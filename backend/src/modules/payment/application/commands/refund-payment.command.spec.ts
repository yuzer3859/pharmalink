import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { ApiException } from '../../../../shared/errors/api-exception';
import {
  LedgerAccountProps,
  LedgerEntryProps,
  LedgerTransactionDraft,
  LedgerTransactionProps,
  PostedLedgerTransaction,
} from '../../domain/entities/ledger-transaction.entity';
import { PaymentProps } from '../../domain/entities/payment.entity';
import { RefundProps } from '../../domain/entities/refund.entity';
import {
  LedgerAccountType,
  LedgerDirection,
  PaymentMethod,
  PaymentStatus,
  RefundDestination,
  RefundStatus,
  RefundType,
} from '../../domain/enums';
import {
  AccountBalanceSnapshot,
  AccountEntryPage,
  ILedgerRepository,
  LedgerEntryTotals,
} from '../../domain/repositories/ledger.repository';
import {
  IPaymentRepository,
  NewPaymentData,
  PaymentPage,
  PaymentStateUpdate,
  PaymentStatusTotals,
} from '../../domain/repositories/payment.repository';
import {
  IRefundRepository,
  NewRefundData,
  RefundPage,
  RefundStateUpdate,
  RefundStatusTotals,
} from '../../domain/repositories/refund.repository';
import { LedgerService } from '../../domain/services/ledger.service';
import { REFUNDED_TOTAL_STATUSES } from '../../domain/services/refund-status-policy';
import { AccountRefKey } from '../../domain/value-objects/account-ref.vo';
import {
  IPaymentProviderPort,
  IPaymentProviderRegistry,
  ProviderAuthorizationResult,
  ProviderCaptureResult,
  ProviderRefundRequest,
  ProviderRefundResult,
  ProviderVoidResult,
} from '../ports/outbound/payment-provider.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { captureLedgerReference } from '../services/capture-accounting.service';
import { RefundAccountingService } from '../services/refund-accounting.service';
import {
  RefundInitiator,
  RefundPaymentCommand,
  RefundPaymentInput,
} from './refund-payment.command';

/**
 * Unit suite for the refund flow (§3.2, §9.3, §11.4, BRULE-24).
 *
 * The ledger here is a real one: `LedgerService` and `RefundAccountingService` are the production
 * classes, over an in-memory `ILedgerRepository` that enforces the same reference uniqueness the
 * database's unique index does. So "the refund posting balances" and "a refund cannot post twice"
 * are genuinely exercised rather than asserted against a stub that could not fail them. Only the
 * gateway, the repositories and the transaction boundary are doubles.
 */

const CUSTOMER = 'customer-1';
const PHARMACY = 'pharmacy-1';

// -------------------------------------------------------------------------------------------
// Doubles
// -------------------------------------------------------------------------------------------

/** Records every provider call so "the refund was not duplicated" can be asserted directly. */
class FakeGateway implements IPaymentProviderPort {
  readonly key = 'fake-gateway';
  readonly refundRequests: ProviderRefundRequest[] = [];
  script: ProviderRefundResult | Error = { outcome: 'REFUNDED', providerRef: null };

  supports(): boolean {
    return true;
  }
  async authorize(): Promise<ProviderAuthorizationResult> {
    throw new Error('authorize must not be called during a refund');
  }
  async capture(): Promise<ProviderCaptureResult> {
    throw new Error('capture must not be called during a refund');
  }
  async voidAuthorization(): Promise<ProviderVoidResult> {
    // Guards the port's rule that a refund is never implemented as a void.
    throw new Error('voidAuthorization must not be called during a refund');
  }
  async refund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    this.refundRequests.push(request);
    if (this.script instanceof Error) {
      throw this.script;
    }
    return {
      ...this.script,
      providerRef: this.script.providerRef ?? `gw-refund-${request.refundId}`,
    };
  }
}

/** Resolves by key, exactly as the production registry does for capture/void/refund. */
class SingleProviderRegistry implements IPaymentProviderRegistry {
  constructor(private readonly provider: IPaymentProviderPort) {}
  forMethod(): IPaymentProviderPort {
    return this.provider;
  }
  forKey(providerKey: string | null | undefined): IPaymentProviderPort {
    if (providerKey !== this.provider.key) {
      throw new ApiException(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        `No gateway is bound for provider key ${String(providerKey)}.`,
      );
    }
    return this.provider;
  }
  availableKeys(): string[] {
    return [this.provider.key];
  }
}

class FakePaymentRepository implements IPaymentRepository {
  readonly rows = new Map<string, PaymentProps>();

  seed(props: PaymentProps): PaymentProps {
    this.rows.set(props.id, { ...props });
    return props;
  }
  async findById(id: string): Promise<PaymentProps | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findByIdempotencyKey(): Promise<PaymentProps | null> {
    return null;
  }
  async findByOrderId(): Promise<PaymentProps[]> {
    return [];
  }
  async findByProviderRef(): Promise<PaymentProps | null> {
    return null;
  }
  async findStale(): Promise<PaymentProps[]> {
    return [];
  }
  async create(data: NewPaymentData): Promise<PaymentProps> {
    throw new Error(`create must not be called during a refund (${data.id})`);
  }
  async updateState(id: string, update: PaymentStateUpdate): Promise<PaymentProps> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`unknown payment ${id}`);
    }
    const next: PaymentProps = { ...row, status: update.status, updatedAt: new Date() };
    this.rows.set(id, next);
    return { ...next };
  }

  async search(): Promise<PaymentPage> {
    throw new Error('not used in this suite');
  }

  async summarizeByStatus(): Promise<PaymentStatusTotals[]> {
    throw new Error('not used in this suite');
  }
}

class FakeRefundRepository implements IRefundRepository {
  readonly rows = new Map<string, RefundProps>();
  /** Mirrors `refunds.idempotencyKey`'s unique index. */
  private readonly byKey = new Map<string, string>();

  async findById(id: string): Promise<RefundProps | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findByIdempotencyKey(key: string): Promise<RefundProps | null> {
    const id = this.byKey.get(key);
    return id ? { ...(this.rows.get(id) as RefundProps) } : null;
  }
  async findByPaymentId(paymentId: string): Promise<RefundProps[]> {
    return [...this.rows.values()]
      .filter((row) => row.paymentId === paymentId)
      .map((row) => ({ ...row }));
  }
  async totalRefundedForPayment(paymentId: string): Promise<number> {
    return [...this.rows.values()]
      .filter(
        (row) => row.paymentId === paymentId && REFUNDED_TOTAL_STATUSES.includes(row.status),
      )
      .reduce((total, row) => total + row.amount, 0);
  }
  /** COMPLETED only — the number §6's status decision uses (ADR-018). */
  async totalCompletedRefundedForPayment(paymentId: string): Promise<number> {
    return [...this.rows.values()]
      .filter((row) => row.paymentId === paymentId && row.status === RefundStatus.COMPLETED)
      .reduce((total, row) => total + row.amount, 0);
  }

  async create(data: NewRefundData): Promise<RefundProps> {
    // Synchronous check-then-insert, with no `await` between them, so this double cannot let two
    // concurrent inserts both win where the real unique index would let only one.
    if (this.byKey.has(data.idempotencyKey)) {
      throw uniqueViolation('refunds_idempotencyKey_key');
    }
    const row: RefundProps = {
      id: data.id,
      paymentId: data.paymentId,
      amount: data.amount,
      reason: data.reason ?? null,
      type: data.type,
      destination: data.destination,
      status: data.status,
      providerRef: data.providerRef ?? null,
      approvedBy: data.approvedBy ?? null,
      idempotencyKey: data.idempotencyKey,
      createdAt: new Date(),
      completedAt: null,
    };
    this.byKey.set(data.idempotencyKey, row.id);
    this.rows.set(row.id, row);
    return { ...row };
  }
  async updateState(id: string, update: RefundStateUpdate): Promise<RefundProps> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`unknown refund ${id}`);
    }
    const next: RefundProps = {
      ...row,
      status: update.status,
      providerRef: update.providerRef === undefined ? row.providerRef : update.providerRef,
      completedAt: update.completedAt === undefined ? row.completedAt : update.completedAt,
    };
    this.rows.set(id, next);
    return { ...next };
  }

  async search(): Promise<RefundPage> {
    throw new Error('not used in this suite');
  }

  async summarizeByStatus(): Promise<RefundStatusTotals[]> {
    throw new Error('not used in this suite');
  }
}

/**
 * In-memory ledger with the one property that matters here: `reference` is unique, exactly as
 * `ledger_transactions.reference` is. That is what makes "a refund cannot post twice" a real
 * assertion rather than a hopeful one.
 */
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
      createdAt: new Date(),
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
        createdAt: new Date(),
      };
      this.entries.push(row);
      return row;
    });
    return { transaction, entries: written };
  }
  async findTransactionById(id: string): Promise<PostedLedgerTransaction | null> {
    const transaction = this.transactions.get(id);
    if (!transaction) {
      return null;
    }
    return { transaction, entries: this.entries.filter((e) => e.transactionId === id) };
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
      currency: rows[0]?.currency ?? 'ETB',
    };
  }
  async findCachedBalance(): Promise<AccountBalanceSnapshot | null> {
    return null;
  }
}

/**
 * Serializes `run()` and rolls the fakes back on failure, so a failed transaction leaves no
 * partial state — the property the real `Serializable` boundary provides and the one these tests
 * depend on when asserting that an ambiguous provider outcome writes nothing.
 */
class FakeUnitOfWork implements IUnitOfWork {
  commits = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly payments: FakePaymentRepository,
    private readonly refunds: FakeRefundRepository,
    private readonly ledger: FakeLedgerRepository,
  ) {}

  run<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const snapshot = this.snapshot();
      try {
        const result = await work({ tx: true });
        this.commits += 1;
        return result;
      } catch (err) {
        this.restore(snapshot);
        throw err;
      }
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private snapshot() {
    return {
      payments: new Map([...this.payments.rows].map(([k, v]) => [k, { ...v }])),
      refunds: new Map([...this.refunds.rows].map(([k, v]) => [k, { ...v }])),
      transactions: new Map(this.ledger.transactions),
      entries: [...this.ledger.entries],
    };
  }

  private restore(snapshot: ReturnType<FakeUnitOfWork['snapshot']>): void {
    this.payments.rows.clear();
    for (const [k, v] of snapshot.payments) this.payments.rows.set(k, v);
    this.refunds.rows.clear();
    for (const [k, v] of snapshot.refunds) this.refunds.rows.set(k, v);
    this.ledger.transactions.clear();
    for (const [k, v] of snapshot.transactions) this.ledger.transactions.set(k, v);
    this.ledger.entries.length = 0;
    this.ledger.entries.push(...snapshot.entries);
  }
}

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

// -------------------------------------------------------------------------------------------
// Harness
// -------------------------------------------------------------------------------------------

interface Harness {
  command: RefundPaymentCommand;
  gateway: FakeGateway;
  payments: FakePaymentRepository;
  refunds: FakeRefundRepository;
  ledger: FakeLedgerRepository;
  ledgerService: LedgerService;
  uow: FakeUnitOfWork;
  audit: { record: jest.Mock };
  outbox: { write: jest.Mock };
  payment: PaymentProps;
  balanceOf(type: LedgerAccountType, ownerId?: string | null): Promise<number>;
}

function paymentProps(overrides: Partial<PaymentProps> = {}): PaymentProps {
  const now = new Date();
  return {
    id: 'payment-1',
    orderId: 'order-1',
    customerUserId: CUSTOMER,
    method: PaymentMethod.TELEBIRR,
    status: PaymentStatus.CAPTURED,
    amount: 10_000,
    currency: 'ETB',
    originalAmount: null,
    originalCurrency: null,
    fxRate: null,
    fxSource: null,
    provider: 'fake-gateway',
    providerRef: 'gw-auth-payment-1',
    providerToken: null,
    idempotencyKey: 'pay-key-1',
    authorizedAt: now,
    capturedAt: now,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Seeds the capture posting a refund reverses, exactly as `CaptureAccountingService` writes it. */
async function seedCapture(
  ledgerService: LedgerService,
  payment: PaymentProps,
  fee: number,
): Promise<void> {
  const { AccountRef } = await import('../../domain/value-objects/account-ref.vo');
  const { Money } = await import('../../domain/value-objects/money.vo');
  const { LedgerTransactionType } = await import('../../domain/enums');

  const gateway = await ledgerService.resolveAccount(
    AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING, payment.currency),
  );
  const payable = await ledgerService.resolveAccount(
    AccountRef.providerPayable(PHARMACY, payment.currency),
  );
  const revenue = await ledgerService.resolveAccount(
    AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE, payment.currency),
  );

  await ledgerService.post({
    reference: captureLedgerReference(payment.id),
    type: LedgerTransactionType.CAPTURE,
    refType: 'payment',
    refId: payment.id,
    entries: [
      {
        accountId: gateway.id,
        direction: LedgerDirection.DEBIT,
        amount: Money.of(payment.amount, payment.currency),
      },
      ...(payment.amount - fee > 0
        ? [
            {
              accountId: payable.id,
              direction: LedgerDirection.CREDIT,
              amount: Money.of(payment.amount - fee, payment.currency),
            },
          ]
        : []),
      ...(fee > 0
        ? [
            {
              accountId: revenue.id,
              direction: LedgerDirection.CREDIT,
              amount: Money.of(fee, payment.currency),
            },
          ]
        : []),
    ],
  });
}

async function harness(
  options: { payment?: Partial<PaymentProps>; fee?: number; withCapture?: boolean } = {},
): Promise<Harness> {
  const gateway = new FakeGateway();
  const payments = new FakePaymentRepository();
  const refunds = new FakeRefundRepository();
  const ledger = new FakeLedgerRepository();
  const uow = new FakeUnitOfWork(payments, refunds, ledger);
  const ledgerService = new LedgerService(ledger);
  const accounting = new RefundAccountingService(ledgerService, ledger, refunds);
  const audit = { record: jest.fn().mockResolvedValue({ id: 'audit-1', hash: 'h' }) };
  const outbox = { write: jest.fn().mockResolvedValue(undefined) };

  const payment = payments.seed(paymentProps(options.payment));
  if (options.withCapture !== false && payment.status !== PaymentStatus.INITIATED) {
    await seedCapture(ledgerService, payment, options.fee ?? 0);
  }

  const command = new RefundPaymentCommand(
    payments,
    refunds,
    new SingleProviderRegistry(gateway),
    uow,
    accounting,
    audit as unknown as AuditService,
    outbox as unknown as OutboxService,
  );

  return {
    command,
    gateway,
    payments,
    refunds,
    ledger,
    ledgerService,
    uow,
    audit,
    outbox,
    payment,
    async balanceOf(type: LedgerAccountType, ownerId: string | null = null) {
      const { AccountRef } = await import('../../domain/value-objects/account-ref.vo');
      const ref =
        ownerId === null
          ? AccountRef.platform(type, payment.currency)
          : AccountRef.of({ type, ownerId, currency: payment.currency });
      return (await ledgerService.balanceOfAccount(ref)).amountMinor;
    },
  };
}

function manual(overrides: Partial<RefundPaymentInput> = {}): RefundPaymentInput {
  return {
    paymentId: 'payment-1',
    idempotencyKey: 'refund-key-1',
    initiator: RefundInitiator.MANUAL,
    actorUserId: 'finance-1',
    actorPermissions: ['finance:refund:any'],
    reason: 'Order cancelled',
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error('expected the operation to be rejected');
  } catch (err) {
    if (err instanceof ApiException) {
      return err.code;
    }
    throw err;
  }
}

// -------------------------------------------------------------------------------------------
// Eligibility (§3.2, BRULE-24)
// -------------------------------------------------------------------------------------------

describe('RefundPaymentCommand — eligibility', () => {
  it('refunds a captured payment in full when no amount is given', async () => {
    const h = await harness();

    const result = await h.command.execute(manual());

    expect(result.type).toBe(RefundType.FULL);
    expect(result.amount).toBe(10_000);
    expect(result.status).toBe(RefundStatus.COMPLETED);
    expect(result.remainingRefundable).toBe(0);
    expect(result.replay).toBe(false);
  });

  it('refunds a captured payment partially when an amount is given', async () => {
    const h = await harness();

    const result = await h.command.execute(manual({ amount: 4_000 }));

    expect(result.type).toBe(RefundType.PARTIAL);
    expect(result.amount).toBe(4_000);
    expect(result.remainingRefundable).toBe(6_000);
  });

  it.each([
    ['INITIATED', PaymentStatus.INITIATED],
    ['AUTHORIZED', PaymentStatus.AUTHORIZED],
    ['VOIDED', PaymentStatus.VOIDED],
    ['FAILED', PaymentStatus.FAILED],
    ['EXPIRED', PaymentStatus.EXPIRED],
    ['SETTLED', PaymentStatus.SETTLED],
  ])('refuses a refund of a %s payment — money was never captured or is out of reach', async (
    _label,
    status,
  ) => {
    const h = await harness({ payment: { status }, withCapture: false });

    expect(await codeOf(h.command.execute(manual({ amount: 100 })))).toBe(
      ErrorCode.REFUND_NOT_ELIGIBLE,
    );
    expect(h.gateway.refundRequests).toHaveLength(0);
    expect(h.refunds.rows.size).toBe(0);
  });

  it('refuses a refund beyond the remaining amount after an earlier partial refund', async () => {
    const h = await harness();
    await h.command.execute(manual({ amount: 7_000 }));

    const code = await codeOf(
      h.command.execute(manual({ idempotencyKey: 'refund-key-2', amount: 4_000 })),
    );

    expect(code).toBe(ErrorCode.REFUND_EXCEEDS_CAPTURED);
    // The declined request left nothing behind, and the gateway was never asked.
    expect(h.gateway.refundRequests).toHaveLength(1);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(7_000);
  });

  it.each([
    ['zero', 0],
    ['negative', -500],
  ])('rejects a %s refund amount', async (_label, amount) => {
    const h = await harness();

    expect(await codeOf(h.command.execute(manual({ amount })))).toBe(ErrorCode.VALIDATION_ERROR);
    expect(h.refunds.rows.size).toBe(0);
  });

  it('rejects a refund whose currency is not the payment currency — never an implicit conversion', async () => {
    const h = await harness();

    expect(await codeOf(h.command.execute(manual({ amount: 1_000, currency: 'USD' })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(h.refunds.rows.size).toBe(0);
  });

  it('classifies a refund that exhausts the remainder as FULL, not PARTIAL', async () => {
    const h = await harness();
    await h.command.execute(manual({ amount: 6_000 }));

    const closing = await h.command.execute(
      manual({ idempotencyKey: 'refund-key-2', amount: 4_000 }),
    );

    expect(closing.type).toBe(RefundType.FULL);
    expect(closing.remainingRefundable).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// Provider boundary (§9, §11.4)
// -------------------------------------------------------------------------------------------

describe('RefundPaymentCommand — provider boundary', () => {
  it("routes to the gateway recorded on the payment, keyed on the refund id", async () => {
    const h = await harness();

    const result = await h.command.execute(manual({ amount: 2_500 }));

    expect(h.gateway.refundRequests).toHaveLength(1);
    const request = h.gateway.refundRequests[0];
    // Keyed on the refund, not the payment — several partial refunds must be distinguishable.
    expect(request.refundId).toBe(result.refundId);
    expect(request.paymentId).toBe('payment-1');
    expect(request.amount).toBe(2_500);
    expect(request.capturedAmount).toBe(10_000);
    expect(request.providerRef).toBe('gw-auth-payment-1');
  });

  it('refuses to refund through a gateway other than the one that took the money', async () => {
    const h = await harness({ payment: { provider: 'some-other-gateway' } });

    expect(await codeOf(h.command.execute(manual({ amount: 1_000 })))).toBe(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
  });

  it('marks the refund FAILED on a positive decline, freeing the amount to be refunded again', async () => {
    const h = await harness();
    h.gateway.script = { outcome: 'FAILED', providerRef: null, failureReason: 'declined' };

    expect(await codeOf(h.command.execute(manual({ amount: 3_000 })))).toBe(
      ErrorCode.BUSINESS_RULE_VIOLATION,
    );

    const [row] = [...h.refunds.rows.values()];
    expect(row.status).toBe(RefundStatus.FAILED);
    // No money moved, so nothing was posted and the payment is untouched.
    expect(h.ledger.transactions.size).toBe(1);
    expect(h.payments.rows.get('payment-1')?.status).toBe(PaymentStatus.CAPTURED);
    // A FAILED refund does not count against the refundable total.
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(0);
  });

  it.each([
    ['an UNKNOWN outcome', { outcome: 'UNKNOWN', providerRef: 'gw-refund-partial' } as const],
    ['a thrown provider error', new Error('socket hang up')],
  ])('leaves the refund PENDING on %s — never FAILED, which would allow a second payout', async (
    _label,
    script,
  ) => {
    const h = await harness();
    h.gateway.script = script as ProviderRefundResult | Error;

    expect(await codeOf(h.command.execute(manual({ amount: 3_000 })))).toBe(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );

    const [row] = [...h.refunds.rows.values()];
    expect(row.status).toBe(RefundStatus.PENDING);
    expect(row.completedAt).toBeNull();
    // The amount stays reserved: an in-flight refund may yet succeed.
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(3_000);
    // Only the capture posting exists — nothing was recorded as refunded.
    expect(h.ledger.transactions.size).toBe(1);
    expect(h.outbox.write).not.toHaveBeenCalled();
  });

  it('treats ALREADY_REFUNDED as success — the normal answer to an idempotent retry', async () => {
    const h = await harness();
    h.gateway.script = { outcome: 'ALREADY_REFUNDED', providerRef: 'gw-refund-existing' };

    const result = await h.command.execute(manual({ amount: 1_000 }));

    expect(result.status).toBe(RefundStatus.COMPLETED);
    expect(result.providerRef).toBe('gw-refund-existing');
  });

  it('does not leak a raw provider failure into the error or the audit trail', async () => {
    const h = await harness();
    h.gateway.script = {
      outcome: 'FAILED',
      providerRef: null,
      failureReason: 'Authorization: Bearer eyJhbGciOi.SECRET api_key=sk_live_1234567890',
    };

    let message = '';
    try {
      await h.command.execute(manual({ amount: 1_000 }));
    } catch (err) {
      message = (err as ApiException).message;
    }

    expect(message).not.toContain('sk_live_1234567890');
    expect(message).not.toContain('eyJhbGciOi');
    const auditContexts = h.audit.record.mock.calls.map(
      (call) => JSON.stringify(call[0].context ?? {}),
    );
    for (const context of auditContexts) {
      expect(context).not.toContain('sk_live_1234567890');
      expect(context).not.toContain('eyJhbGciOi');
    }
  });

  it('never calls the gateway for a wallet-destination refund', async () => {
    const h = await harness();

    const result = await h.command.execute(
      manual({ amount: 2_000, destination: RefundDestination.WALLET }),
    );

    expect(h.gateway.refundRequests).toHaveLength(0);
    expect(result.status).toBe(RefundStatus.COMPLETED);
    expect(result.destination).toBe(RefundDestination.WALLET);
  });
});

// -------------------------------------------------------------------------------------------
// Idempotency and concurrency (BRULE-25, §5.3)
// -------------------------------------------------------------------------------------------

describe('RefundPaymentCommand — idempotency and concurrency', () => {
  it('replays an identical request without refunding again', async () => {
    const h = await harness();
    const first = await h.command.execute(manual({ amount: 3_000 }));

    const second = await h.command.execute(manual({ amount: 3_000 }));

    expect(second.refundId).toBe(first.refundId);
    expect(second.replay).toBe(true);
    // The gateway saw exactly one refund, and exactly one posting exists.
    expect(h.gateway.refundRequests).toHaveLength(1);
    expect(h.refunds.rows.size).toBe(1);
    expect(refundPostings(h)).toHaveLength(1);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(3_000);
  });

  it('rejects a key reused for a materially different refund', async () => {
    const h = await harness();
    await h.command.execute(manual({ amount: 3_000 }));

    expect(await codeOf(h.command.execute(manual({ amount: 5_000 })))).toBe(
      ErrorCode.IDEMPOTENCY_CONFLICT,
    );
    expect(h.refunds.rows.size).toBe(1);
  });

  it('rejects a key reused for a different destination', async () => {
    const h = await harness();
    await h.command.execute(manual({ amount: 3_000 }));

    expect(
      await codeOf(
        h.command.execute(manual({ amount: 3_000, destination: RefundDestination.WALLET })),
      ),
    ).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
  });

  it('resumes a PENDING refund left by an ambiguous outcome, without creating a second one', async () => {
    const h = await harness();
    h.gateway.script = { outcome: 'UNKNOWN', providerRef: null };
    await expect(h.command.execute(manual({ amount: 3_000 }))).rejects.toBeInstanceOf(
      ApiException,
    );

    h.gateway.script = { outcome: 'REFUNDED', providerRef: null };
    const resumed = await h.command.execute(manual({ amount: 3_000 }));

    expect(resumed.status).toBe(RefundStatus.COMPLETED);
    expect(h.refunds.rows.size).toBe(1);
    // Both gateway calls carried the same refund id — the provider-side idempotency identity.
    expect(new Set(h.gateway.refundRequests.map((r) => r.refundId)).size).toBe(1);
    expect(refundPostings(h)).toHaveLength(1);
  });

  it('lets only one of two concurrent refunds of the whole remainder succeed', async () => {
    const h = await harness();

    const results = await Promise.allSettled([
      h.command.execute(manual({ idempotencyKey: 'refund-race-a', amount: 10_000 })),
      h.command.execute(manual({ idempotencyKey: 'refund-race-b', amount: 10_000 })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as ApiException).code).toBe(ErrorCode.REFUND_EXCEEDS_CAPTURED);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(10_000);
  });

  it('collapses two concurrent refunds sharing an idempotency key into one refund', async () => {
    const h = await harness();

    const results = await Promise.allSettled([
      h.command.execute(manual({ amount: 2_000 })),
      h.command.execute(manual({ amount: 2_000 })),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(h.refunds.rows.size).toBe(1);
    expect(refundPostings(h)).toHaveLength(1);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(2_000);
  });
});

// -------------------------------------------------------------------------------------------
// Ledger accounting (§11.4)
// -------------------------------------------------------------------------------------------

describe('RefundPaymentCommand — ledger accounting', () => {
  it('posts a balanced REFUND transaction reversing the capture to gateway clearing', async () => {
    const h = await harness();

    const result = await h.command.execute(manual());

    const [posting] = refundPostings(h);
    expect(result.ledgerReference).toBe(`REFUND-${result.refundId}`);
    expect(posting.transaction.reference).toBe(result.ledgerReference);
    expect(posting.transaction.refType).toBe('refund');
    expect(posting.transaction.refId).toBe(result.refundId);
    expect(sum(posting.entries, LedgerDirection.DEBIT)).toBe(
      sum(posting.entries, LedgerDirection.CREDIT),
    );
    // The capture credited the payable in full (zero fee), so the refund takes it all back.
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
    expect(await h.balanceOf(LedgerAccountType.GATEWAY_CLEARING)).toBe(0);
  });

  it('credits the customer wallet instead of gateway clearing for a wallet refund', async () => {
    const h = await harness();

    await h.command.execute(manual({ destination: RefundDestination.WALLET }));

    // The wallet balance is derived from the ledger — no stored balance anywhere (§3.3 F-WAL-01).
    expect(await h.balanceOf(LedgerAccountType.CUSTOMER_WALLET, CUSTOMER)).toBe(10_000);
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
    // Gateway clearing keeps the capture's debit: the money never went back out through it.
    expect(await h.balanceOf(LedgerAccountType.GATEWAY_CLEARING)).toBe(-10_000);
  });

  it('reverses the platform fee exactly when the whole capture is refunded', async () => {
    const h = await harness({ fee: 1_000 });

    await h.command.execute(manual());

    expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(0);
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
  });

  it('takes a partial refund of a zero-fee capture entirely out of the provider payable', async () => {
    const h = await harness();

    await h.command.execute(manual({ amount: 3_000 }));

    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(7_000);
    expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(0);
  });

  /**
   * ADR-016, the single-refund case: the clawback is proportional to the amount refunded, and the
   * provider leg takes the balance so the posting balances exactly.
   *
   * 3 333 of a 10 000 capture with a 1 000 fee: round(1000 x 3333 / 10000) = round(333.3) = 333.
   */
  it('claws back the platform fee proportionally on a fee-bearing partial refund', async () => {
    const h = await harness({ fee: 1_000 });

    await h.command.execute(manual({ amount: 3_333 }));

    const [posting] = refundPostings(h);
    expect(legOf(h, posting, LedgerAccountType.PLATFORM_REVENUE)).toEqual({
      direction: LedgerDirection.DEBIT,
      amount: 333,
    });
    expect(legOf(h, posting, LedgerAccountType.PROVIDER_PAYABLE)).toEqual({
      direction: LedgerDirection.DEBIT,
      amount: 3_000,
    });
    expect(legOf(h, posting, LedgerAccountType.GATEWAY_CLEARING)).toEqual({
      direction: LedgerDirection.CREDIT,
      amount: 3_333,
    });
    expect(sum(posting.entries, LedgerDirection.DEBIT)).toBe(
      sum(posting.entries, LedgerDirection.CREDIT),
    );

    expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(667);
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(6_000);
  });

  /**
   * The second refund is computed against the **cumulative** baseline, not as an independent
   * percentage. round(1000 x 6666/10000) - round(1000 x 3333/10000) = 667 - 333 = 334 — note that
   * an independent calculation would have given round(333.3) = 333 and drifted by a santim.
   */
  it('computes a later refund against the cumulative baseline, not independently', async () => {
    const h = await harness({ fee: 1_000 });
    await h.command.execute(manual({ idempotencyKey: 'refund-one', amount: 3_333 }));

    await h.command.execute(manual({ idempotencyKey: 'refund-two', amount: 3_333 }));

    const second = refundPostings(h)[1];
    expect(legOf(h, second, LedgerAccountType.PLATFORM_REVENUE)?.amount).toBe(334);
    expect(legOf(h, second, LedgerAccountType.PROVIDER_PAYABLE)?.amount).toBe(2_999);
    // Cumulative revenue clawed back is 667, exactly round(1000 x 6666/10000).
    expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(333);
  });

  /**
   * The property that matters: over any sequence that fully refunds the payment, the fee clawbacks
   * telescope to exactly the captured fee and the payable clawbacks to exactly the captured net.
   * Nothing checks whether a refund is "the last one" — the cumulative formula absorbs the residue
   * on its own.
   */
  it.each([
    ['one full refund', 10_000, 1_000, [10_000]],
    ['100 / 200 / 300 / 400', 10_000, 1_000, [1_000, 2_000, 3_000, 4_000]],
    ['333 / 333 / 334', 10_000, 1_000, [3_330, 3_330, 3_340]],
    ['uneven partition', 10_000, 1_000, [1, 4_999, 9, 4_991]],
    ['awkward fee', 10_000, 333, [1_111, 2_222, 3_333, 3_334]],
    ['midpoint-heavy', 1_000, 500, [5, 5, 5, 985]],
    ['fee equals gross', 10_000, 10_000, [2_500, 2_500, 5_000]],
    ['zero fee', 10_000, 0, [1_234, 8_766]],
  ])(
    'telescopes to the exact captured split for %s',
    async (_label, gross, fee, amounts) => {
      const h = await harness({ payment: { amount: gross as number }, fee: fee as number });

      for (const [index, amount] of (amounts as number[]).entries()) {
        await h.command.execute(manual({ idempotencyKey: `refund-seq-${index}`, amount }));
      }

      // Σ clawbacks == the capture's own legs, so both accounts return to zero exactly.
      expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(0);
      expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
      expect(await h.balanceOf(LedgerAccountType.GATEWAY_CLEARING)).toBe(0);

      // And every posting balanced on its own.
      for (const posting of refundPostings(h)) {
        expect(sum(posting.entries, LedgerDirection.DEBIT)).toBe(
          sum(posting.entries, LedgerDirection.CREDIT),
        );
      }

      const revenueDebits = refundPostings(h)
        .flatMap((posting) => posting.entries)
        .filter(
          (entry) =>
            h.ledger.accounts.get(entry.accountId)?.type === LedgerAccountType.PLATFORM_REVENUE,
        )
        .reduce((total, entry) => total + entry.amount, 0);
      expect(revenueDebits).toBe(fee);
    },
  );

  it.each([
    ['1 minor unit', 1],
    ['gross - 1', 9_999],
  ])('handles a refund of %s against a fee-bearing capture', async (_label, amount) => {
    const h = await harness({ fee: 1_000 });

    await h.command.execute(manual({ amount }));

    const [posting] = refundPostings(h);
    expect(sum(posting.entries, LedgerDirection.DEBIT)).toBe(amount);
    expect(sum(posting.entries, LedgerDirection.CREDIT)).toBe(amount);
    // Closing the payment out returns both accounts to zero regardless of where it started.
    if (amount < 10_000) {
      await h.command.execute(manual({ idempotencyKey: 'refund-rest', amount: 10_000 - amount }));
    }
    expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(0);
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
  });

  it('claws the whole refund out of platform revenue when the fee was the entire gross', async () => {
    // Degenerate but reachable: such a capture credits no PROVIDER_PAYABLE at all, so the refund
    // must not try to debit one — and must not fail looking for a payable owner that never existed.
    const h = await harness({ fee: 10_000 });

    await h.command.execute(manual({ amount: 4_000 }));

    const [posting] = refundPostings(h);
    expect(legOf(h, posting, LedgerAccountType.PLATFORM_REVENUE)?.amount).toBe(4_000);
    expect(legOf(h, posting, LedgerAccountType.PROVIDER_PAYABLE)).toBeUndefined();
    expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(6_000);
  });

  it('takes a fee-bearing wallet refund out of the same two accounts', async () => {
    const h = await harness({ fee: 1_000 });

    await h.command.execute(
      manual({ amount: 3_333, destination: RefundDestination.WALLET }),
    );

    const [posting] = refundPostings(h);
    expect(legOf(h, posting, LedgerAccountType.PLATFORM_REVENUE)?.amount).toBe(333);
    expect(legOf(h, posting, LedgerAccountType.PROVIDER_PAYABLE)?.amount).toBe(3_000);
    // Only the destination differs from an ORIGINAL refund.
    expect(legOf(h, posting, LedgerAccountType.CUSTOMER_WALLET)).toEqual({
      direction: LedgerDirection.CREDIT,
      amount: 3_333,
    });
    expect(legOf(h, posting, LedgerAccountType.GATEWAY_CLEARING)).toBeUndefined();
    expect(await h.balanceOf(LedgerAccountType.CUSTOMER_WALLET, CUSTOMER)).toBe(3_333);
  });

  it('does not shift the cumulative baseline for a refund that is still PENDING', async () => {
    const h = await harness({ fee: 1_000 });
    // An ambiguous outcome leaves a PENDING refund that posted nothing.
    h.gateway.script = { outcome: 'UNKNOWN', providerRef: null };
    await expect(
      h.command.execute(manual({ idempotencyKey: 'refund-pending', amount: 5_000 })),
    ).rejects.toBeInstanceOf(ApiException);

    h.gateway.script = { outcome: 'REFUNDED', providerRef: null };
    await h.command.execute(manual({ idempotencyKey: 'refund-first', amount: 3_333 }));

    // Baseline was 0, not 5 000: the clawback is the first-refund figure.
    const [posting] = refundPostings(h);
    expect(legOf(h, posting, LedgerAccountType.PLATFORM_REVENUE)?.amount).toBe(333);
  });

  it('does not post the fee clawback twice when a refund is replayed', async () => {
    const h = await harness({ fee: 1_000 });
    const request = manual({ amount: 3_333 });
    await h.command.execute(request);

    await h.command.execute(request);

    expect(refundPostings(h)).toHaveLength(1);
    expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(667);
  });

  it('keeps the split exact when two fee-bearing refunds run concurrently', async () => {
    const h = await harness({ fee: 1_000 });

    const results = await Promise.allSettled([
      h.command.execute(manual({ idempotencyKey: 'refund-race-a', amount: 3_333 })),
      h.command.execute(manual({ idempotencyKey: 'refund-race-b', amount: 6_667 })),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // Whatever order they committed in, the cumulative formula closes the books exactly.
    expect(await h.balanceOf(LedgerAccountType.PLATFORM_REVENUE)).toBe(0);
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
  });

  it('leaves the capture posting itself untouched', async () => {
    const h = await harness({ fee: 1_000 });
    const captureBefore = h.ledger.entries.filter(
      (entry) => entry.transactionId === [...h.ledger.transactions.values()][0].id,
    );

    await h.command.execute(manual({ amount: 3_333 }));

    const captureAfter = h.ledger.entries.filter(
      (entry) => entry.transactionId === [...h.ledger.transactions.values()][0].id,
    );
    expect(captureAfter).toEqual(captureBefore);
  });

  it('refuses to refund a payment with no capture posting to reverse', async () => {
    const h = await harness({ withCapture: false });

    expect(await codeOf(h.command.execute(manual({ amount: 1_000 })))).toBe(
      ErrorCode.BUSINESS_RULE_VIOLATION,
    );
  });
});

// -------------------------------------------------------------------------------------------
// Payment state, audit and events (§6, §13)
// -------------------------------------------------------------------------------------------

describe('RefundPaymentCommand — payment state, audit and events', () => {
  it('moves a fully refunded payment to REFUNDED', async () => {
    const h = await harness();

    const result = await h.command.execute(manual());

    expect(result.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(h.payments.rows.get('payment-1')?.status).toBe(PaymentStatus.REFUNDED);
  });

  it('moves a partially refunded payment to PARTIALLY_REFUNDED', async () => {
    const h = await harness();

    const result = await h.command.execute(manual({ amount: 2_000 }));

    expect(result.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
  });

  /**
   * ADR-018: the refund that exhausts the remainder moves the payment to `REFUNDED`, even though it
   * arrived as the second of two partial requests. The status follows the money, not the number of
   * requests it took to return it.
   */
  it('advances a PARTIALLY_REFUNDED payment to REFUNDED once the remainder is exhausted', async () => {
    const h = await harness();
    const first = await h.command.execute(manual({ amount: 6_000 }));
    expect(first.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);

    const closing = await h.command.execute(
      manual({ idempotencyKey: 'refund-key-2', amount: 4_000 }),
    );

    expect(closing.status).toBe(RefundStatus.COMPLETED);
    expect(closing.remainingRefundable).toBe(0);
    expect(closing.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(h.payments.rows.get('payment-1')?.status).toBe(PaymentStatus.REFUNDED);

    const completion = h.audit.record.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.action === 'PAYMENT_REFUNDED')
      .pop();
    expect(completion.context.paymentStatusAdvanced).toBe(true);
    expect(completion.context.paymentStatusLimitation).toBeNull();
    // Both refunds are on the books and the ledger is fully reversed.
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(10_000);
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
  });

  it.each([
    ['a single full refund', [10_000]],
    ['1000 -> 100 -> 300 -> 600', [1_000, 3_000, 6_000]],
    ['1000 -> 333 -> 333 -> 334', [3_330, 3_330, 3_340]],
  ])('reaches REFUNDED for the sequence %s — the remainder decides, not the request count', async (
    _label,
    amounts,
  ) => {
    const h = await harness();

    let last;
    for (const [index, amount] of (amounts as number[]).entries()) {
      last = await h.command.execute(manual({ idempotencyKey: `refund-seq-${index}`, amount }));
      const isFinal = index === (amounts as number[]).length - 1;
      expect(last.paymentStatus).toBe(
        isFinal ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
      );
    }

    expect(last?.remainingRefundable).toBe(0);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(10_000);
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
  });

  it('stays PARTIALLY_REFUNDED while any remainder is left, however many refunds it took', async () => {
    const h = await harness();

    for (const [index, amount] of [1_000, 3_000, 5_000].entries()) {
      const result = await h.command.execute(
        manual({ idempotencyKey: `refund-seq-${index}`, amount }),
      );
      expect(result.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    }

    // 1 000 short of the captured amount is still not a refunded payment.
    expect(h.payments.rows.get('payment-1')?.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(9_000);
  });

  /**
   * The status decision counts refunds that have actually **completed**, not the reserving total the
   * over-refund guard uses. A `PENDING` refund has reserved its amount but returned no money, so a
   * payment must not go terminally `REFUNDED` while one is outstanding — if it later failed, its
   * amount would be refundable again with the payment stuck in a state `RefundPolicy` refuses to
   * refund from.
   */
  it('does not mark a payment REFUNDED while an ambiguous refund is still PENDING', async () => {
    const h = await harness();
    // Refund 1's outcome is unknown: the row stays PENDING and reserves 4 000.
    h.gateway.script = { outcome: 'UNKNOWN', providerRef: null };
    await expect(
      h.command.execute(manual({ idempotencyKey: 'refund-pending', amount: 4_000 })),
    ).rejects.toBeInstanceOf(ApiException);

    // Refund 2 completes and takes the *reserving* total to the full captured amount.
    h.gateway.script = { outcome: 'REFUNDED', providerRef: null };
    const second = await h.command.execute(
      manual({ idempotencyKey: 'refund-settled', amount: 6_000 }),
    );

    // Nothing more may be requested...
    expect(second.remainingRefundable).toBe(0);
    // ...but only 6 000 has actually gone back, so the payment is not REFUNDED yet.
    expect(second.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(await h.refunds.totalCompletedRefundedForPayment('payment-1')).toBe(6_000);

    // Resuming the PENDING refund successfully is what completes the payment.
    h.gateway.script = { outcome: 'REFUNDED', providerRef: null };
    const resumed = await h.command.execute(
      manual({ idempotencyKey: 'refund-pending', amount: 4_000 }),
    );
    expect(resumed.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it('reports the same final state when the closing refund is replayed', async () => {
    const h = await harness();
    await h.command.execute(manual({ amount: 6_000 }));
    const closing = manual({ idempotencyKey: 'refund-key-2', amount: 4_000 });
    const first = await h.command.execute(closing);

    const replay = await h.command.execute(closing);

    expect(replay.replay).toBe(true);
    expect(replay.refundId).toBe(first.refundId);
    expect(replay.paymentStatus).toBe(PaymentStatus.REFUNDED);
    // The replay neither re-refunded nor re-posted: two refunds, two postings, no third.
    expect(h.gateway.refundRequests).toHaveLength(2);
    expect(refundPostings(h)).toHaveLength(2);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(10_000);
  });

  it('still refuses a further refund once the payment is fully refunded', async () => {
    const h = await harness();
    await h.command.execute(manual({ amount: 6_000 }));
    await h.command.execute(manual({ idempotencyKey: 'refund-key-2', amount: 4_000 }));

    // `REFUNDED` is not a refundable status, so a further request is refused as ineligible rather
    // than as an over-refund. Either way no money moves and nothing is posted.
    const code = await codeOf(
      h.command.execute(manual({ idempotencyKey: 'refund-key-3', amount: 1 })),
    );
    expect([ErrorCode.REFUND_NOT_ELIGIBLE, ErrorCode.REFUND_EXCEEDS_CAPTURED]).toContain(code);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(10_000);
    expect(refundPostings(h)).toHaveLength(2);
  });

  it('reaches REFUNDED exactly once when two concurrent refunds split the remainder', async () => {
    const h = await harness();

    const results = await Promise.allSettled([
      h.command.execute(manual({ idempotencyKey: 'refund-race-a', amount: 4_000 })),
      h.command.execute(manual({ idempotencyKey: 'refund-race-b', amount: 6_000 })),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // Whichever committed second is the one that saw a zero remainder.
    expect(h.payments.rows.get('payment-1')?.status).toBe(PaymentStatus.REFUNDED);
    expect(await h.refunds.totalRefundedForPayment('payment-1')).toBe(10_000);
    expect(refundPostings(h)).toHaveLength(2);
    expect(await h.balanceOf(LedgerAccountType.PROVIDER_PAYABLE, PHARMACY)).toBe(0);
  });

  it('audits the refund with §13\'s required fields and the approving actor', async () => {
    const h = await harness();

    const result = await h.command.execute(manual({ amount: 2_500 }));

    const completion = h.audit.record.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.action === 'PAYMENT_REFUNDED');
    expect(completion.actorUserId).toBe('finance-1');
    expect(completion.resourceType).toBe('Refund');
    expect(completion.resourceId).toBe(result.refundId);
    expect(completion.context).toMatchObject({
      refundId: result.refundId,
      paymentId: 'payment-1',
      orderId: 'order-1',
      amount: 2_500,
      currency: 'ETB',
      type: RefundType.PARTIAL,
      destination: RefundDestination.ORIGINAL,
      reason: 'Order cancelled',
      initiator: RefundInitiator.MANUAL,
      approvedBy: 'finance-1',
      ledgerReference: `REFUND-${result.refundId}`,
    });
  });

  it('writes the catalogued payment.refunded event and no other', async () => {
    const h = await harness();

    const result = await h.command.execute(manual({ amount: 2_500 }));

    expect(h.outbox.write).toHaveBeenCalledTimes(1);
    const event = h.outbox.write.mock.calls[0][0];
    expect(event.type).toBe('payment.refunded');
    expect(event.aggregateType).toBe('Payment');
    expect(event.aggregateId).toBe('payment-1');
    expect(event.payload).toEqual({ paymentId: 'payment-1', amount: 2_500 });
    expect(result.refundId).toBeDefined();
  });
});

// -------------------------------------------------------------------------------------------
// Manual/admin authorization (§3.2 F-RFD-03, §9.3)
// -------------------------------------------------------------------------------------------

describe('RefundPaymentCommand — manual refund authorization', () => {
  it('records the approving actor on a manual refund', async () => {
    const h = await harness();

    const result = await h.command.execute(manual({ amount: 1_000 }));

    expect(h.refunds.rows.get(result.refundId)?.approvedBy).toBe('finance-1');
  });

  it('refuses a manual refund from an actor without finance:refund:any', async () => {
    const h = await harness();

    const code = await codeOf(
      h.command.execute(
        manual({
          amount: 1_000,
          actorUserId: CUSTOMER,
          // A customer's real permission set: it contains no refund permission at all.
          actorPermissions: ['payment:create:own', 'payment:read:own', 'order:read:own'],
        }),
      ),
    );

    expect(code).toBe(ErrorCode.RBAC_FORBIDDEN);
    // Refused before anything was read or written — not even a refund row exists.
    expect(h.refunds.rows.size).toBe(0);
    expect(h.gateway.refundRequests).toHaveLength(0);
  });

  it('refuses a manual refund with no acting user at all', async () => {
    const h = await harness();

    expect(
      await codeOf(
        h.command.execute(
          manual({ amount: 1_000, actorUserId: null, actorPermissions: ['finance:refund:any'] }),
        ),
      ),
    ).toBe(ErrorCode.RBAC_FORBIDDEN);
  });

  it('allows a SYSTEM refund without a permission set, and records no approver', async () => {
    const h = await harness();

    const result = await h.command.execute({
      paymentId: 'payment-1',
      idempotencyKey: 'saga-key-1',
      initiator: RefundInitiator.SYSTEM,
      amount: 1_000,
    });

    expect(result.status).toBe(RefundStatus.COMPLETED);
    // A saga has no human approver, and none is fabricated.
    expect(h.refunds.rows.get(result.refundId)?.approvedBy).toBeNull();
  });
});

/** One leg of a posting, by the account type it touches. `undefined` when the leg is absent. */
function legOf(
  h: Harness,
  posting: PostedLedgerTransaction,
  type: LedgerAccountType,
): { direction: LedgerDirection; amount: number } | undefined {
  const entry = posting.entries.find(
    (candidate) => h.ledger.accounts.get(candidate.accountId)?.type === type,
  );
  return entry ? { direction: entry.direction, amount: entry.amount } : undefined;
}

/** Every committed REFUND posting, read back off the fake ledger. */
function refundPostings(h: Harness): PostedLedgerTransaction[] {
  return [...h.ledger.transactions.values()]
    .filter((transaction) => transaction.reference.startsWith('REFUND-'))
    .map((transaction) => ({
      transaction,
      entries: h.ledger.entries.filter((entry) => entry.transactionId === transaction.id),
    }));
}
