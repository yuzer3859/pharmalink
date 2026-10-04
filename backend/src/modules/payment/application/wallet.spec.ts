import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { PaymentProps } from '../domain/entities/payment.entity';
import {
  LedgerAccountProps,
  LedgerEntryProps,
  LedgerTransactionDraft,
  LedgerTransactionProps,
  PostedLedgerTransaction,
} from '../domain/entities/ledger-transaction.entity';
import {
  LedgerAccountType,
  LedgerDirection,
  LedgerTransactionType,
  PaymentMethod,
  PaymentStatus,
} from '../domain/enums';
import {
  AccountBalanceSnapshot,
  AccountEntryPage,
  ILedgerRepository,
  LedgerEntryTotals,
} from '../domain/repositories/ledger.repository';
import { IPaymentRepository } from '../domain/repositories/payment.repository';
import { LedgerService } from '../domain/services/ledger.service';
import { AccountRef, AccountRefKey } from '../domain/value-objects/account-ref.vo';
import { Money } from '../domain/value-objects/money.vo';
import { SpendWalletCommand } from './commands/spend-wallet.command';
import { TopUpWalletCommand } from './commands/top-up-wallet.command';
import { IUnitOfWork } from './ports/unit-of-work.port';
import { GetWalletQuery } from './queries/get-wallet.query';
import { ListWalletTransactionsQuery } from './queries/list-wallet-transactions.query';
import { WalletAccountingService } from './services/wallet-accounting.service';

/**
 * The wallet application slice (§3.3, §9.4, §11.6), over one in-memory ledger that keeps the two
 * properties the real one is trusted for: `ledger_transactions.reference` is unique, and entries
 * are append-only. Those are what make "a top-up cannot credit twice" and "a spend cannot debit
 * twice" real assertions here rather than hopeful ones.
 *
 * The genuinely concurrent case — two spends racing the same last funds under PostgreSQL's
 * serializable snapshot isolation — cannot be proved against a fake and is proved in
 * `test/payment/wallet.e2e-spec.ts` against real PostgreSQL. What is proved here is the logic:
 * that the balance is derived rather than stored, that the guard reads inside the transaction,
 * and that every refusal is the right refusal.
 */

const CUSTOMER = 'customer-1';
const OTHER_CUSTOMER = 'customer-2';
const ORDER = 'order-1';
const PAYMENT = 'payment-1';
const ETB = 'ETB';

function sum(rows: LedgerEntryProps[], direction: LedgerDirection): number {
  return rows
    .filter((row) => row.direction === direction)
    .reduce((total, row) => total + row.amount, 0);
}

function uniqueViolation(constraint: string): Error {
  const err = new Error(`Unique constraint failed on ${constraint}`) as Error & { code: string };
  err.code = 'P2002';
  return err;
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiException) {
      return err.code;
    }
    throw err;
  }
  throw new Error('expected the operation to be rejected');
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

class FakeLedgerRepository implements ILedgerRepository {
  readonly accounts = new Map<string, LedgerAccountProps>();
  readonly transactions = new Map<string, LedgerTransactionProps>();
  readonly entries: LedgerEntryProps[] = [];
  private seq = 0;

  private key(ref: AccountRefKey): string {
    return `${ref.type}:${ref.ownerId ?? '-'}:${ref.currency}`;
  }

  async findAccountById(id: string): Promise<LedgerAccountProps | null> {
    return this.accounts.get(id) ?? null;
  }
  async findAccountByRef(ref: AccountRefKey): Promise<LedgerAccountProps | null> {
    return this.accounts.get(this.key(ref)) ?? null;
  }
  async createAccount(ref: AccountRefKey): Promise<LedgerAccountProps> {
    const account: LedgerAccountProps = {
      id: this.key(ref),
      type: ref.type,
      ownerId: ref.ownerId,
      currency: ref.currency,
      createdAt: new Date(),
    };
    this.accounts.set(account.id, account);
    return account;
  }
  async findOrCreateAccount(ref: AccountRefKey): Promise<LedgerAccountProps> {
    return (await this.findAccountByRef(ref)) ?? this.createAccount(ref);
  }
  async createTransaction(draft: LedgerTransactionDraft): Promise<PostedLedgerTransaction> {
    for (const existing of this.transactions.values()) {
      if (existing.reference === draft.reference) {
        throw uniqueViolation('ledger_transactions_reference_key');
      }
    }
    this.seq += 1;
    const transaction: LedgerTransactionProps = {
      id: `txn-${this.seq}`,
      reference: draft.reference,
      type: draft.type,
      refType: draft.refType,
      refId: draft.refId,
      description: draft.description,
      createdAt: new Date(Date.now() + this.seq),
    };
    this.transactions.set(transaction.id, transaction);
    const written = draft.entries.map((entry, index) => {
      const row: LedgerEntryProps = {
        id: `${transaction.id}-e${index}`,
        transactionId: transaction.id,
        accountId: entry.accountId,
        direction: entry.direction,
        amount: entry.amount.amountMinor,
        currency: entry.amount.currency.code,
        createdAt: transaction.createdAt,
      };
      this.entries.push(row);
      return row;
    });
    return { transaction, entries: written };
  }
  async findTransactionById(id: string): Promise<PostedLedgerTransaction | null> {
    const transaction = this.transactions.get(id);
    return transaction
      ? { transaction, entries: this.entries.filter((e) => e.transactionId === id) }
      : null;
  }
  async findTransactionByReference(reference: string): Promise<LedgerTransactionProps | null> {
    return [...this.transactions.values()].find((t) => t.reference === reference) ?? null;
  }
  async findEntriesByTransactionId(transactionId: string): Promise<LedgerEntryProps[]> {
    return this.entries.filter((entry) => entry.transactionId === transactionId);
  }
  async findEntriesByAccountId(accountId: string): Promise<LedgerEntryProps[]> {
    return this.entries.filter((entry) => entry.accountId === accountId);
  }
  /** Faithful to the real adapter: half-open `[from, to)`, so a boundary posting is in one period. */
  async findEntriesByAccountInPeriod(
    accountId: string,
    period: { from: Date; to: Date },
  ): Promise<LedgerEntryProps[]> {
    return this.entries.filter(
      (entry) =>
        entry.accountId === accountId &&
        entry.createdAt.getTime() >= period.from.getTime() &&
        entry.createdAt.getTime() < period.to.getTime(),
    );
  }
  async sumAllEntriesByCurrency(): Promise<LedgerEntryTotals[]> {
    const byCurrency = new Map<string, LedgerEntryTotals>();
    for (const entry of this.entries) {
      const totals = byCurrency.get(entry.currency) ?? {
        debit: 0,
        credit: 0,
        currency: entry.currency,
      };
      if (entry.direction === LedgerDirection.DEBIT) {
        totals.debit += entry.amount;
      } else {
        totals.credit += entry.amount;
      }
      byCurrency.set(entry.currency, totals);
    }
    return [...byCurrency.values()];
  }
  async listEntriesByAccountId(
    accountId: string,
    page: { skip: number; take: number },
  ): Promise<AccountEntryPage> {
    const rows = this.entries.filter((entry) => entry.accountId === accountId).reverse();
    return {
      items: rows.slice(page.skip, page.skip + page.take).map((entry) => ({
        entry,
        transaction: [...this.transactions.values()].find(
          (candidate) => candidate.id === entry.transactionId,
        )!,
      })),
      total: rows.length,
    };
  }
  async sumEntriesByAccount(accountId: string): Promise<LedgerEntryTotals> {
    const rows = this.entries.filter((entry) => entry.accountId === accountId);
    return {
      debit: sum(rows, LedgerDirection.DEBIT),
      credit: sum(rows, LedgerDirection.CREDIT),
      currency: rows[0]?.currency ?? ETB,
    };
  }
  /**
   * The cache — and it is deliberately allowed to **lie** in this fake. Nothing in the wallet may
   * read it, so a test can poison it and prove the balance still comes from the entries.
   */
  cached: AccountBalanceSnapshot | null = null;
  async findCachedBalance(): Promise<AccountBalanceSnapshot | null> {
    return this.cached;
  }
}

class FakePaymentRepository {
  readonly rows = new Map<string, PaymentProps>();
  async findById(id: string): Promise<PaymentProps | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
}

/** Serializes transactions and rolls the ledger back on failure, as a real one would. */
class FakeUnitOfWork implements IUnitOfWork {
  commits = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ledger: FakeLedgerRepository) {}

  run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const transactions = new Map(this.ledger.transactions);
      const entries = [...this.ledger.entries];
      try {
        const result = await work({ tx: true });
        this.commits += 1;
        return result;
      } catch (err) {
        this.ledger.transactions.clear();
        for (const [id, row] of transactions) {
          this.ledger.transactions.set(id, row);
        }
        this.ledger.entries.length = 0;
        this.ledger.entries.push(...entries);
        throw err;
      }
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  }
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

function capturedPayment(overrides: Partial<PaymentProps> = {}): PaymentProps {
  return {
    id: PAYMENT,
    orderId: ORDER,
    customerUserId: CUSTOMER,
    method: PaymentMethod.TELEBIRR,
    status: PaymentStatus.CAPTURED,
    amount: 1_000,
    currency: ETB,
    originalAmount: null,
    originalCurrency: null,
    fxRate: null,
    fxSource: null,
    provider: 'mock',
    providerRef: 'gw-1',
    providerToken: null,
    idempotencyKey: 'pay-key-000001',
    authorizedAt: new Date(),
    capturedAt: new Date(),
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PaymentProps;
}

function harness() {
  const ledger = new FakeLedgerRepository();
  const payments = new FakePaymentRepository();
  const uow = new FakeUnitOfWork(ledger);
  const ledgerService = new LedgerService(ledger);
  const wallets = new WalletAccountingService(ledgerService);
  const audit = { record: jest.fn().mockResolvedValue({ id: 'audit-1', hash: 'h' }) };
  const outbox = { write: jest.fn().mockResolvedValue(undefined) };

  const topUp = new TopUpWalletCommand(
    payments as unknown as IPaymentRepository,
    ledger,
    uow,
    wallets,
    audit as unknown as AuditService,
    outbox as unknown as OutboxService,
  );
  const spend = new SpendWalletCommand(
    ledger,
    uow,
    wallets,
    audit as unknown as AuditService,
    outbox as unknown as OutboxService,
  );
  const getWallet = new GetWalletQuery(wallets, ledger);
  const listTransactions = new ListWalletTransactionsQuery(wallets, ledger);

  const gatewayRef = AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING, ETB);

  /**
   * Credits a wallet without going through top-up — written exactly as `RefundPaymentCommand`
   * writes a `destination = WALLET` refund: one `CUSTOMER_WALLET` credit against gateway clearing.
   */
  const creditWallet = async (customerUserId: string, amount: number, reference: string) => {
    const wallet = await wallets.resolveWalletAccount(customerUserId, ETB);
    const gateway = await ledgerService.resolveAccount(gatewayRef);
    await ledgerService.post({
      reference,
      type: LedgerTransactionType.REFUND,
      refType: 'refund',
      refId: reference,
      description: 'Refund to wallet',
      entries: [
        { accountId: gateway.id, direction: LedgerDirection.DEBIT, amount: Money.of(amount, ETB) },
        { accountId: wallet.id, direction: LedgerDirection.CREDIT, amount: Money.of(amount, ETB) },
      ],
    });
  };

  /**
   * The three-leg posting `CaptureAccountingService` writes for an ordinary order payment — the
   * thing whose presence means a payment's funds have already gone to a pharmacy.
   */
  const postCaptureFor = async (paymentId: string, amount: number, pharmacyId: string) => {
    const gateway = await ledgerService.resolveAccount(gatewayRef);
    const payable = await ledgerService.resolveAccount(AccountRef.providerPayable(pharmacyId, ETB));
    await ledgerService.post({
      reference: `CAPTURE-${paymentId}`,
      type: LedgerTransactionType.CAPTURE,
      refType: 'payment',
      refId: paymentId,
      description: 'Capture',
      entries: [
        { accountId: gateway.id, direction: LedgerDirection.DEBIT, amount: Money.of(amount, ETB) },
        { accountId: payable.id, direction: LedgerDirection.CREDIT, amount: Money.of(amount, ETB) },
      ],
    });
  };

  return {
    ledger,
    payments,
    uow,
    wallets,
    audit,
    outbox,
    topUp,
    spend,
    getWallet,
    listTransactions,
    creditWallet,
    postCaptureFor,
  };
}

type Harness = ReturnType<typeof harness>;

const spendRequest = (overrides: Record<string, unknown> = {}) => ({
  customerUserId: CUSTOMER,
  orderId: ORDER,
  amount: 400,
  idempotencyKey: 'wallet-spend-key-1',
  ...overrides,
});

const topUpRequest = (overrides: Record<string, unknown> = {}) => ({
  customerUserId: CUSTOMER,
  paymentId: PAYMENT,
  idempotencyKey: 'wallet-topup-key-1',
  ...overrides,
});

async function walletBalance(h: Harness, customerUserId = CUSTOMER): Promise<number> {
  return (await h.wallets.balanceOf(customerUserId, ETB)).amountMinor;
}

// =============================================================================================
// Account resolution and derived balance
// =============================================================================================

describe('Wallet account and derived balance (§5.1, §5.3, F-WAL-01)', () => {
  it('resolves a wallet by (CUSTOMER_WALLET, customerUserId, currency), opening it on first use', async () => {
    const h = harness();

    const account = await h.wallets.resolveWalletAccount(CUSTOMER, ETB);

    expect(account).toMatchObject({
      type: LedgerAccountType.CUSTOMER_WALLET,
      ownerId: CUSTOMER,
      currency: ETB,
    });
    // Idempotent: asking again returns the same account, never a second one.
    expect((await h.wallets.resolveWalletAccount(CUSTOMER, ETB)).id).toBe(account.id);
    expect(h.ledger.accounts.size).toBe(1);
  });

  it('gives two customers two different wallets', async () => {
    const h = harness();

    const mine = await h.wallets.resolveWalletAccount(CUSTOMER, ETB);
    const theirs = await h.wallets.resolveWalletAccount(OTHER_CUSTOMER, ETB);

    expect(mine.id).not.toBe(theirs.id);
  });

  it('reports a zero balance for a wallet that has never transacted', async () => {
    const h = harness();

    const view = await h.getWallet.execute({ customerUserId: CUSTOMER });

    expect(view).toEqual({
      balance: 0,
      currency: ETB,
      totalCredited: 0,
      totalDebited: 0,
      transactionCount: 0,
    });
  });

  it('derives a positive balance as credits minus debits', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment());
    await h.topUp.execute(topUpRequest());

    const view = await h.getWallet.execute({ customerUserId: CUSTOMER });

    expect(view).toMatchObject({ balance: 1_000, totalCredited: 1_000, totalDebited: 0 });
  });

  it('derives the balance from the ledger, never from the account_balances cache', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment());
    await h.topUp.execute(topUpRequest());
    // Poison the cache. A wallet that read it would now report 999 999.
    h.ledger.cached = {
      accountId: 'CUSTOMER_WALLET:customer-1:ETB',
      balance: 999_999,
      currency: ETB,
      updatedAt: new Date(),
    };

    expect((await h.getWallet.execute({ customerUserId: CUSTOMER })).balance).toBe(1_000);
    expect(await walletBalance(h)).toBe(1_000);
  });

  /** §13's worked example, exactly: top-up +1000, refund +200, spend −400 → 800. */
  it('accumulates top-ups, refund credits and spends into one derived figure', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ amount: 1_000 }));
    await h.topUp.execute(topUpRequest());
    await h.creditWallet(CUSTOMER, 200, 'REFUND-refund-1');
    await h.spend.execute(spendRequest({ amount: 400 }));

    const view = await h.getWallet.execute({ customerUserId: CUSTOMER });

    expect(view).toMatchObject({
      balance: 800,
      totalCredited: 1_200,
      totalDebited: 400,
      transactionCount: 3,
    });
  });

  it('reflects a refund credited to the wallet with no wallet-side bookkeeping at all', async () => {
    const h = harness();

    // Written exactly as `RefundPaymentCommand` writes it: one CUSTOMER_WALLET credit.
    await h.creditWallet(CUSTOMER, 750, 'REFUND-refund-9');

    expect(await walletBalance(h)).toBe(750);
    const history = await h.listTransactions.execute({ customerUserId: CUSTOMER });
    expect(history.items[0]).toMatchObject({
      reference: 'REFUND-refund-9',
      direction: LedgerDirection.CREDIT,
      amount: 750,
      type: LedgerTransactionType.REFUND,
    });
  });

  it('rejects a balance read with no customer', async () => {
    const h = harness();

    expect(await codeOf(() => h.getWallet.execute({ customerUserId: '  ' }))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

// =============================================================================================
// Transaction history
// =============================================================================================

describe('ListWalletTransactionsQuery (§9.4, F-WAL-03)', () => {
  it('lists the wallet movements newest first with their references and directions', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ amount: 1_000 }));
    await h.topUp.execute(topUpRequest());
    await h.spend.execute(spendRequest({ amount: 300 }));

    const view = await h.listTransactions.execute({ customerUserId: CUSTOMER });

    expect(view.total).toBe(2);
    expect(view.items.map((item) => [item.reference, item.direction, item.amount])).toEqual([
      [`WALLET-SPEND-${ORDER}`, LedgerDirection.DEBIT, 300],
      [`WALLET-TOPUP-${PAYMENT}`, LedgerDirection.CREDIT, 1_000],
    ]);
    expect(view.items[0]).toMatchObject({
      type: LedgerTransactionType.WALLET_SPEND,
      relatedType: 'order',
      relatedId: ORDER,
      currency: ETB,
    });
  });

  it('returns only safe fields — no account id, no transaction id, no counterpart leg', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment());
    await h.topUp.execute(topUpRequest());

    const view = await h.listTransactions.execute({ customerUserId: CUSTOMER });

    expect(Object.keys(view.items[0]).sort()).toEqual(
      [
        'reference',
        'type',
        'direction',
        'amount',
        'currency',
        'description',
        'relatedType',
        'relatedId',
        'createdAt',
      ].sort(),
    );
    // The posting has two legs; only the wallet's own is listed. The gateway leg is invisible.
    expect(view.items).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain('GATEWAY_CLEARING');
  });

  it("never shows one customer another customer's movements", async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment());
    await h.topUp.execute(topUpRequest());

    const intruder = await h.listTransactions.execute({ customerUserId: OTHER_CUSTOMER });

    expect(intruder.items).toEqual([]);
    expect(intruder.total).toBe(0);
    expect(await walletBalance(h, OTHER_CUSTOMER)).toBe(0);
  });

  it('pages, and clamps a size beyond the maximum', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      await h.creditWallet(CUSTOMER, 100, `REFUND-r${i}`);
    }

    const first = await h.listTransactions.execute({ customerUserId: CUSTOMER, page: 1, size: 2 });
    const second = await h.listTransactions.execute({ customerUserId: CUSTOMER, page: 2, size: 2 });
    const clamped = await h.listTransactions.execute({
      customerUserId: CUSTOMER,
      size: 5_000,
    });

    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(first.items[0].reference).not.toBe(second.items[0].reference);
    expect(first.total).toBe(5);
    expect(clamped.size).toBe(50);
  });
});

// =============================================================================================
// Top-up
// =============================================================================================

describe('TopUpWalletCommand (§3.3 F-WAL-02)', () => {
  it('credits the wallet from a captured payment and posts a balanced transaction', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ amount: 1_000 }));

    const result = await h.topUp.execute(topUpRequest());

    expect(result).toMatchObject({
      customerUserId: CUSTOMER,
      paymentId: PAYMENT,
      amount: 1_000,
      currency: ETB,
      ledgerReference: `WALLET-TOPUP-${PAYMENT}`,
      balance: 1_000,
      replay: false,
    });

    const posting = [...h.ledger.transactions.values()][0];
    expect(posting.type).toBe(LedgerTransactionType.WALLET_TOPUP);
    expect(posting.refType).toBe('payment');
    expect(posting.refId).toBe(PAYMENT);
    const entries = h.ledger.entries.filter((e) => e.transactionId === posting.id);
    expect(sum(entries, LedgerDirection.DEBIT)).toBe(sum(entries, LedgerDirection.CREDIT));
    // The credit is backed by a gateway-clearing debit — money arrived, it was not invented.
    expect(
      entries.find((e) => e.direction === LedgerDirection.DEBIT)!.accountId,
    ).toContain(LedgerAccountType.GATEWAY_CLEARING);
  });

  it('credits what the payment collected, ignoring what the caller claims', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ amount: 1_000 }));

    // A matching assertion is accepted...
    const result = await h.topUp.execute(topUpRequest({ amount: 1_000 }));
    expect(result.amount).toBe(1_000);
  });

  it('rejects an amount that disagrees with the funding payment', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ amount: 1_000 }));

    expect(await codeOf(() => h.topUp.execute(topUpRequest({ amount: 5_000 })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(await walletBalance(h)).toBe(0);
  });

  it.each([
    ['authorized but not captured', PaymentStatus.AUTHORIZED],
    ['initiated', PaymentStatus.INITIATED],
    ['failed', PaymentStatus.FAILED],
    ['voided', PaymentStatus.VOIDED],
  ])('refuses to credit from a payment that is %s', async (_label, status) => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ status }));

    expect(await codeOf(() => h.topUp.execute(topUpRequest()))).toBe(
      ErrorCode.BUSINESS_RULE_VIOLATION,
    );
    expect(h.ledger.transactions.size).toBe(0);
    expect(await walletBalance(h)).toBe(0);
  });

  it("refuses to credit from another customer's payment, without confirming it exists", async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ customerUserId: OTHER_CUSTOMER }));

    const found = await codeOf(() => h.topUp.execute(topUpRequest()));
    const missing = await codeOf(() =>
      h.topUp.execute(topUpRequest({ paymentId: 'no-such-payment' })),
    );

    expect(found).toBe(ErrorCode.NOT_FOUND);
    expect(found).toBe(missing);
    expect(await walletBalance(h)).toBe(0);
  });

  /** The guard that keeps a top-up backed rather than merely plausible. */
  it('refuses a payment whose funds were already settled to a provider', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment());
    // Exactly what `CaptureAccountingService` writes for an ordinary order payment: the gross is
    // already owed to a pharmacy, so crediting the wallet as well would pay it out twice.
    await h.postCaptureFor(PAYMENT, 1_000, 'pharmacy-1');

    expect(await codeOf(() => h.topUp.execute(topUpRequest()))).toBe(
      ErrorCode.BUSINESS_RULE_VIOLATION,
    );
    expect(await walletBalance(h)).toBe(0);
  });

  it('replays a repeated top-up of the same payment without crediting twice', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ amount: 1_000 }));
    const first = await h.topUp.execute(topUpRequest());

    const second = await h.topUp.execute(topUpRequest());

    expect(second.replay).toBe(true);
    expect(second.ledgerReference).toBe(first.ledgerReference);
    expect(second.balance).toBe(1_000);
    expect(await walletBalance(h)).toBe(1_000);
    expect(h.ledger.transactions.size).toBe(1);
  });

  it('replays under a different idempotency key too — the payment is the identity', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment());
    await h.topUp.execute(topUpRequest({ idempotencyKey: 'wallet-topup-key-a' }));

    const second = await h.topUp.execute(topUpRequest({ idempotencyKey: 'wallet-topup-key-b' }));

    expect(second.replay).toBe(true);
    expect(await walletBalance(h)).toBe(1_000);
    expect(h.ledger.transactions.size).toBe(1);
  });

  it('rejects a malformed idempotency key before touching any money', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment());

    expect(await codeOf(() => h.topUp.execute(topUpRequest({ idempotencyKey: 'short' })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(h.ledger.transactions.size).toBe(0);
  });

  it('records the audit entry and the catalogued wallet.credited event', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ amount: 1_000 }));

    await h.topUp.execute(topUpRequest());

    expect(h.audit.record).toHaveBeenCalledTimes(1);
    const [entry] = h.audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'WALLET_TOPPED_UP',
      resourceType: 'Wallet',
      resourceId: CUSTOMER,
      actorUserId: CUSTOMER,
    });
    expect(entry.context).toMatchObject({
      customerUserId: CUSTOMER,
      paymentId: PAYMENT,
      amount: 1_000,
      currency: ETB,
      ledgerReference: `WALLET-TOPUP-${PAYMENT}`,
      outcome: 'CREDITED',
    });
    // §13: no token, no provider credential, no raw payload anywhere in the trail.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('providerToken');
    expect(serialized).not.toContain('gw-1');

    expect(h.outbox.write).toHaveBeenCalledTimes(1);
    expect(h.outbox.write.mock.calls[0][0]).toMatchObject({
      type: 'wallet.credited',
      aggregateType: 'Wallet',
      aggregateId: CUSTOMER,
      payload: { userId: CUSTOMER, amount: 1_000 },
    });
  });

  it('writes nothing at all when the top-up is refused', async () => {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ status: PaymentStatus.AUTHORIZED }));

    await expect(h.topUp.execute(topUpRequest())).rejects.toBeInstanceOf(ApiException);

    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.outbox.write).not.toHaveBeenCalled();
    expect(h.ledger.entries).toHaveLength(0);
  });
});

// =============================================================================================
// Spend
// =============================================================================================

describe('SpendWalletCommand (§11.6)', () => {
  async function funded(amount = 1_000): Promise<Harness> {
    const h = harness();
    h.payments.rows.set(PAYMENT, capturedPayment({ amount }));
    await h.topUp.execute(topUpRequest());
    h.audit.record.mockClear();
    h.outbox.write.mockClear();
    return h;
  }

  it('debits the wallet and credits gateway clearing, exactly as §11.6 specifies', async () => {
    const h = await funded();

    const result = await h.spend.execute(spendRequest({ amount: 400 }));

    expect(result).toMatchObject({
      customerUserId: CUSTOMER,
      orderId: ORDER,
      amount: 400,
      currency: ETB,
      ledgerReference: `WALLET-SPEND-${ORDER}`,
      balance: 600,
      replay: false,
    });

    const posting = [...h.ledger.transactions.values()].find(
      (t) => t.reference === `WALLET-SPEND-${ORDER}`,
    )!;
    expect(posting.type).toBe(LedgerTransactionType.WALLET_SPEND);
    expect(posting.refType).toBe('order');
    expect(posting.refId).toBe(ORDER);
    const entries = h.ledger.entries.filter((e) => e.transactionId === posting.id);
    expect(sum(entries, LedgerDirection.DEBIT)).toBe(sum(entries, LedgerDirection.CREDIT));
    expect(entries.find((e) => e.direction === LedgerDirection.DEBIT)!.accountId).toContain(
      LedgerAccountType.CUSTOMER_WALLET,
    );
    expect(entries.find((e) => e.direction === LedgerDirection.CREDIT)!.accountId).toContain(
      LedgerAccountType.GATEWAY_CLEARING,
    );
  });

  it('spends the whole balance down to exactly zero', async () => {
    const h = await funded(1_000);

    const result = await h.spend.execute(spendRequest({ amount: 1_000 }));

    expect(result.balance).toBe(0);
    expect(await walletBalance(h)).toBe(0);
  });

  it('refuses a spend the wallet cannot fund, and writes nothing', async () => {
    const h = await funded(1_000);

    const code = await codeOf(() => h.spend.execute(spendRequest({ amount: 1_001 })));

    expect(code).toBe(ErrorCode.INSUFFICIENT_WALLET_BALANCE);
    expect(await walletBalance(h)).toBe(1_000);
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.outbox.write).not.toHaveBeenCalled();
    expect(
      [...h.ledger.transactions.values()].some((t) => t.type === LedgerTransactionType.WALLET_SPEND),
    ).toBe(false);
  });

  it('refuses a spend from an empty wallet', async () => {
    const h = harness();

    expect(await codeOf(() => h.spend.execute(spendRequest({ amount: 1 })))).toBe(
      ErrorCode.INSUFFICIENT_WALLET_BALANCE,
    );
    expect(await walletBalance(h)).toBe(0);
  });

  it('reports the derived balance in the refusal, so a saga can offer another method', async () => {
    const h = await funded(1_000);

    try {
      await h.spend.execute(spendRequest({ amount: 1_500 }));
      throw new Error('expected a rejection');
    } catch (err) {
      expect((err as ApiException).details).toMatchObject({
        customerUserId: CUSTOMER,
        requested: 1_500,
        available: 1_000,
        currency: ETB,
      });
    }
  });

  /**
   * The sequential half of the concurrency story: the second spend reads the first's debit and
   * refuses. The genuinely simultaneous case is proved against real PostgreSQL in the e2e suite,
   * because only SSI can prove it.
   */
  it('never lets two spends share the same funds — the second sees the first', async () => {
    const h = await funded(1_000);

    const results = await Promise.allSettled([
      h.spend.execute(spendRequest({ orderId: 'order-a', amount: 700 })),
      h.spend.execute(spendRequest({ orderId: 'order-b', amount: 700 })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as ApiException).code).toBe(ErrorCode.INSUFFICIENT_WALLET_BALANCE);
    expect(await walletBalance(h)).toBe(300);
  });

  it('never leaves a negative balance, whatever sequence is attempted', async () => {
    const h = await funded(1_000);

    await h.spend.execute(spendRequest({ orderId: 'order-a', amount: 600 }));
    await expect(
      h.spend.execute(spendRequest({ orderId: 'order-b', amount: 600 })),
    ).rejects.toBeInstanceOf(ApiException);
    await h.spend.execute(spendRequest({ orderId: 'order-c', amount: 400 }));

    expect(await walletBalance(h)).toBe(0);
    expect(await walletBalance(h)).toBeGreaterThanOrEqual(0);
  });

  it('replays a repeated spend for the same order without debiting twice', async () => {
    const h = await funded();
    const first = await h.spend.execute(spendRequest({ amount: 400 }));

    const second = await h.spend.execute(spendRequest({ amount: 400 }));

    expect(second.replay).toBe(true);
    expect(second.ledgerReference).toBe(first.ledgerReference);
    expect(await walletBalance(h)).toBe(600);
    expect(
      [...h.ledger.transactions.values()].filter(
        (t) => t.type === LedgerTransactionType.WALLET_SPEND,
      ),
    ).toHaveLength(1);
  });

  it('rejects the same order re-spent for a different amount as a conflict', async () => {
    const h = await funded();
    await h.spend.execute(spendRequest({ amount: 400 }));

    const code = await codeOf(() => h.spend.execute(spendRequest({ amount: 500 })));

    expect(code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
    expect(await walletBalance(h)).toBe(600);
  });

  it('uses the deterministic WALLET-SPEND-<orderId> reference, not a random one', async () => {
    const h = await funded();

    const a = await h.spend.execute(spendRequest({ orderId: 'order-x', amount: 100 }));
    const b = await h.spend.execute(spendRequest({ orderId: 'order-y', amount: 100 }));

    expect(a.ledgerReference).toBe('WALLET-SPEND-order-x');
    expect(b.ledgerReference).toBe('WALLET-SPEND-order-y');
  });

  it.each([
    ['zero', 0],
    ['negative', -100],
  ])('rejects a %s spend amount', async (_label, amount) => {
    const h = await funded();

    expect(await codeOf(() => h.spend.execute(spendRequest({ amount })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(await walletBalance(h)).toBe(1_000);
  });

  it('rejects a spend with no order or no customer', async () => {
    const h = await funded();

    expect(await codeOf(() => h.spend.execute(spendRequest({ orderId: ' ' })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(await codeOf(() => h.spend.execute(spendRequest({ customerUserId: '' })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a malformed idempotency key before touching any money', async () => {
    const h = await funded();

    expect(await codeOf(() => h.spend.execute(spendRequest({ idempotencyKey: 'no' })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(await walletBalance(h)).toBe(1_000);
  });

  it('records the audit entry and the catalogued wallet.debited event', async () => {
    const h = await funded();

    await h.spend.execute(spendRequest({ amount: 400 }));

    const [entry] = h.audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'WALLET_SPENT',
      resourceType: 'Wallet',
      resourceId: CUSTOMER,
    });
    expect(entry.context).toMatchObject({
      customerUserId: CUSTOMER,
      orderId: ORDER,
      amount: 400,
      ledgerReference: `WALLET-SPEND-${ORDER}`,
      balanceAfter: 600,
      outcome: 'DEBITED',
    });

    expect(h.outbox.write.mock.calls[0][0]).toMatchObject({
      type: 'wallet.debited',
      aggregateType: 'Wallet',
      aggregateId: CUSTOMER,
      payload: { userId: CUSTOMER, amount: 400 },
    });
  });

  it('does not write a second audit entry or event on a replay', async () => {
    const h = await funded();
    await h.spend.execute(spendRequest({ amount: 400 }));

    await h.spend.execute(spendRequest({ amount: 400 }));

    expect(h.audit.record).toHaveBeenCalledTimes(1);
    expect(h.outbox.write).toHaveBeenCalledTimes(1);
  });

  it("spends only the caller's own wallet, never another customer's", async () => {
    const h = await funded(1_000);

    // The other customer's wallet is empty, so their spend is refused even though ours is funded.
    expect(
      await codeOf(() =>
        h.spend.execute(spendRequest({ customerUserId: OTHER_CUSTOMER, orderId: 'order-z' })),
      ),
    ).toBe(ErrorCode.INSUFFICIENT_WALLET_BALANCE);
    expect(await walletBalance(h)).toBe(1_000);
  });
});
