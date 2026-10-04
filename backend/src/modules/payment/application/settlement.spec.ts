import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import {
  SettlementLineProps,
  SettlementProps,
  SettlementWithLines,
} from '../domain/entities/settlement.entity';
import {
  LedgerAccountType,
  LedgerDirection,
  LedgerTransactionType,
  PaymentStatus,
  SettlementStatus,
} from '../domain/enums';
import {
  LedgerAccountProps,
  LedgerEntryProps,
  LedgerTransactionProps,
  PostedLedgerTransaction,
} from '../domain/entities/ledger-transaction.entity';
import { PaymentProps } from '../domain/entities/payment.entity';
import { RefundProps } from '../domain/entities/refund.entity';
import {
  ISettlementRepository,
  ListSettlementsCriteria,
  SettlementIdentity,
  SettlementPage,
  SettlementStatusTotals,
} from '../domain/repositories/settlement.repository';
import { SettlementCalculator } from '../domain/services/settlement-calculator';
import { SettlementPeriod } from '../domain/value-objects/settlement-period.vo';
import { RunSettlementCommand } from './commands/run-settlement.command';
import { GetSettlementQuery, ListSettlementsQuery } from './queries/get-settlement.query';
import { AccountingReconciliationService } from './services/accounting-reconciliation.service';
import { ProviderPayableService } from './services/provider-payable.service';
import { IUnitOfWork } from './ports/unit-of-work.port';

/**
 * The settlement foundation (§3.5 F-STL-01/02, §3.6 F-REC-01, §11.5, BRULE-23), over an in-memory
 * ledger that keeps the one property the real one is trusted for: entries are immutable and a
 * balance is only ever `Σ credits − Σ debits` over them. Nothing here stores a provider balance,
 * because the thing under test is precisely that nothing has to.
 *
 * The worked example throughout is the platform-funded coupon from ADR-019:
 *
 * ```
 * subtotal 9,000 + delivery 1,000 + platformFee 450 − coupon 2,000 = 8,450 captured
 *   DEBIT  GATEWAY_CLEARING   8,450      DEBIT  PROMOTION_EXPENSE  2,000
 *   CREDIT PROVIDER_PAYABLE  10,000      CREDIT PLATFORM_REVENUE     450
 * ```
 *
 * The claim being tested is that settlement derives **10,000** — not the 8,450 the customer paid,
 * and not the 8,000 that subtracting the fee from the cash would give.
 */

const PHARMACY = 'pharmacy-1';
const OTHER_PHARMACY = 'pharmacy-2';
const ETB = 'ETB';
const PERIOD = SettlementPeriod.of(
  new Date('2026-09-01T00:00:00.000Z'),
  new Date('2026-10-01T00:00:00.000Z'),
);

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

interface LegSpec {
  type: LedgerAccountType;
  ownerId?: string | null;
  direction: LedgerDirection;
  amount: number;
  currency?: string;
}

/** An append-only ledger: `post` writes, nothing rewrites. */
class FakeLedger {
  readonly accounts: LedgerAccountProps[] = [];
  readonly transactions: LedgerTransactionProps[] = [];
  readonly entries: LedgerEntryProps[] = [];
  private seq = 0;

  account(type: LedgerAccountType, ownerId: string | null): LedgerAccountProps {
    const existing = this.accounts.find(
      (candidate) => candidate.type === type && candidate.ownerId === ownerId,
    );
    if (existing) {
      return existing;
    }
    const created: LedgerAccountProps = {
      id: `acct-${type}-${ownerId ?? 'platform'}`,
      type,
      ownerId,
      currency: ETB,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    this.accounts.push(created);
    return created;
  }

  post(input: {
    reference: string;
    type: LedgerTransactionType;
    refType?: string | null;
    refId?: string | null;
    at: Date;
    legs: LegSpec[];
  }): LedgerTransactionProps {
    const transaction: LedgerTransactionProps = {
      id: `txn-${++this.seq}`,
      reference: input.reference,
      type: input.type,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      description: null,
      createdAt: input.at,
    };
    this.transactions.push(transaction);
    for (const leg of input.legs) {
      const account = this.account(leg.type, leg.ownerId ?? null);
      this.entries.push({
        id: `entry-${this.entries.length + 1}`,
        transactionId: transaction.id,
        accountId: account.id,
        direction: leg.direction,
        amount: leg.amount,
        currency: leg.currency ?? ETB,
        createdAt: input.at,
      });
    }
    return transaction;
  }

  /** The §11.3 capture posting, with the promotion leg omitted when there is no discount. */
  capture(options: {
    paymentId: string;
    at: Date;
    gross: number;
    fee: number;
    discount?: number;
    pharmacyId?: string;
  }): LedgerTransactionProps {
    const discount = options.discount ?? 0;
    const pharmacyId = options.pharmacyId ?? PHARMACY;
    const payable = options.gross - options.fee + discount;
    return this.post({
      reference: `CAPTURE-${options.paymentId}`,
      type: LedgerTransactionType.CAPTURE,
      refType: 'payment',
      refId: options.paymentId,
      at: options.at,
      legs: [
        {
          type: LedgerAccountType.GATEWAY_CLEARING,
          direction: LedgerDirection.DEBIT,
          amount: options.gross,
        },
        ...(discount > 0
          ? [
              {
                type: LedgerAccountType.PROMOTION_EXPENSE,
                direction: LedgerDirection.DEBIT,
                amount: discount,
              },
            ]
          : []),
        {
          type: LedgerAccountType.PROVIDER_PAYABLE,
          ownerId: pharmacyId,
          direction: LedgerDirection.CREDIT,
          amount: payable,
        },
        ...(options.fee > 0
          ? [
              {
                type: LedgerAccountType.PLATFORM_REVENUE,
                direction: LedgerDirection.CREDIT,
                amount: options.fee,
              },
            ]
          : []),
      ],
    });
  }

  /** The §11.4 refund posting: the mirror of a capture, with the promotion leg credited back. */
  refund(options: {
    refundId: string;
    at: Date;
    amount: number;
    feeClawback: number;
    promotionClawback?: number;
    pharmacyId?: string;
  }): LedgerTransactionProps {
    const promotion = options.promotionClawback ?? 0;
    const providerClawback = options.amount + promotion - options.feeClawback;
    return this.post({
      reference: `REFUND-${options.refundId}`,
      type: LedgerTransactionType.REFUND,
      refType: 'refund',
      refId: options.refundId,
      at: options.at,
      legs: [
        {
          type: LedgerAccountType.PROVIDER_PAYABLE,
          ownerId: options.pharmacyId ?? PHARMACY,
          direction: LedgerDirection.DEBIT,
          amount: providerClawback,
        },
        ...(options.feeClawback > 0
          ? [
              {
                type: LedgerAccountType.PLATFORM_REVENUE,
                direction: LedgerDirection.DEBIT,
                amount: options.feeClawback,
              },
            ]
          : []),
        ...(promotion > 0
          ? [
              {
                type: LedgerAccountType.PROMOTION_EXPENSE,
                direction: LedgerDirection.CREDIT,
                amount: promotion,
              },
            ]
          : []),
        {
          type: LedgerAccountType.GATEWAY_CLEARING,
          direction: LedgerDirection.CREDIT,
          amount: options.amount,
        },
      ],
    });
  }
}

class FakeLedgerRepository {
  constructor(readonly ledger: FakeLedger) {}

  async findAccountById(id: string): Promise<LedgerAccountProps | null> {
    return this.ledger.accounts.find((account) => account.id === id) ?? null;
  }
  async findAccountByRef(ref: {
    type: LedgerAccountType;
    ownerId: string | null;
  }): Promise<LedgerAccountProps | null> {
    return (
      this.ledger.accounts.find(
        (account) => account.type === ref.type && account.ownerId === ref.ownerId,
      ) ?? null
    );
  }
  async findEntriesByAccountInPeriod(
    accountId: string,
    period: { from: Date; to: Date },
  ): Promise<LedgerEntryProps[]> {
    return this.ledger.entries.filter(
      (entry) =>
        entry.accountId === accountId &&
        entry.createdAt.getTime() >= period.from.getTime() &&
        entry.createdAt.getTime() < period.to.getTime(),
    );
  }
  async findTransactionById(id: string): Promise<PostedLedgerTransaction | null> {
    const transaction = this.ledger.transactions.find((candidate) => candidate.id === id);
    if (!transaction) {
      return null;
    }
    return {
      transaction,
      entries: this.ledger.entries.filter((entry) => entry.transactionId === id),
    };
  }
  async findTransactionByReference(reference: string): Promise<LedgerTransactionProps | null> {
    return this.ledger.transactions.find((txn) => txn.reference === reference) ?? null;
  }
  async findEntriesByTransactionId(transactionId: string): Promise<LedgerEntryProps[]> {
    return this.ledger.entries.filter((entry) => entry.transactionId === transactionId);
  }
  async sumAllEntriesByCurrency() {
    const byCurrency = new Map<string, { debit: number; credit: number; currency: string }>();
    for (const entry of this.ledger.entries) {
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
}

class FakeSettlementRepository implements ISettlementRepository {
  readonly settlements = new Map<string, SettlementProps>();
  readonly lines = new Map<string, SettlementLineProps[]>();

  private keyOf(identity: SettlementIdentity): string {
    return [
      identity.pharmacyId,
      identity.periodStart.toISOString(),
      identity.periodEnd.toISOString(),
      identity.currency,
    ].join('|');
  }

  async findByIdentity(identity: SettlementIdentity): Promise<SettlementProps | null> {
    const key = this.keyOf(identity);
    return (
      [...this.settlements.values()].find(
        (settlement) =>
          this.keyOf({
            pharmacyId: settlement.pharmacyId,
            periodStart: settlement.periodStart,
            periodEnd: settlement.periodEnd,
            currency: settlement.currency,
          }) === key,
      ) ?? null
    );
  }
  async findById(id: string): Promise<SettlementProps | null> {
    return this.settlements.get(id) ?? null;
  }
  async findWithLines(id: string): Promise<SettlementWithLines | null> {
    const settlement = this.settlements.get(id);
    return settlement ? { settlement, lines: this.lines.get(id) ?? [] } : null;
  }
  async list(criteria: ListSettlementsCriteria): Promise<SettlementPage> {
    const all = [...this.settlements.values()].filter(
      (settlement) =>
        // `undefined` is unrestricted; `[]` matches nothing. The real `in: []` semantics, so a
        // scope bug cannot pass here and fail against PostgreSQL.
        (criteria.pharmacyIds === undefined ||
          criteria.pharmacyIds.includes(settlement.pharmacyId)) &&
        (!criteria.currency || settlement.currency === criteria.currency) &&
        (!criteria.status || settlement.status === criteria.status),
    );
    const start = (criteria.page - 1) * criteria.size;
    return { items: all.slice(start, start + criteria.size), total: all.length };
  }
  async create(
    settlement: SettlementProps,
    lines: SettlementLineProps[],
  ): Promise<SettlementWithLines> {
    // The unique index, as a real assertion rather than a hopeful one.
    if (await this.findByIdentity(settlement)) {
      const err = new Error('Unique constraint failed') as Error & { code: string };
      err.code = 'P2002';
      throw err;
    }
    this.settlements.set(settlement.id, { ...settlement });
    this.lines.set(settlement.id, lines.map((line) => ({ ...line })));
    return { settlement, lines };
  }
  async findOverlapping(
    pharmacyId: string,
    currency: string,
    from: Date,
    to: Date,
  ): Promise<SettlementProps[]> {
    return [...this.settlements.values()].filter(
      (settlement) =>
        settlement.pharmacyId === pharmacyId &&
        settlement.currency === currency &&
        settlement.periodStart.getTime() < to.getTime() &&
        settlement.periodEnd.getTime() > from.getTime(),
    );
  }
  async findLines(settlementId: string): Promise<SettlementLineProps[]> {
    return this.lines.get(settlementId) ?? [];
  }

  async summarizeByStatus(): Promise<SettlementStatusTotals[]> {
    throw new Error('not used in this suite');
  }
}

/** Defaults to `p1`, matching the `CAPTURE-p1` reference the ledger helpers post. */
function payment(overrides: Partial<PaymentProps> = {}): PaymentProps {
  return {
    id: 'p1',
    orderId: 'order-1',
    customerUserId: 'customer-1',
    status: PaymentStatus.CAPTURED,
    amount: 8_450,
    currency: ETB,
    ...overrides,
  } as PaymentProps;
}

class FakePaymentRepository {
  readonly payments: PaymentProps[] = [];
  async findById(id: string): Promise<PaymentProps | null> {
    return this.payments.find((candidate) => candidate.id === id) ?? null;
  }
  async findStale(criteria: { statuses: PaymentStatus[]; limit: number }): Promise<PaymentProps[]> {
    return this.payments
      .filter((candidate) => criteria.statuses.includes(candidate.status))
      .slice(0, criteria.limit);
  }
}

class FakeRefundRepository {
  readonly refunds: RefundProps[] = [];
  async findById(id: string): Promise<RefundProps | null> {
    return this.refunds.find((candidate) => candidate.id === id) ?? null;
  }
}

const uow: IUnitOfWork = { run: (work) => work(undefined) };

function harness() {
  const ledger = new FakeLedger();
  const ledgerRepo = new FakeLedgerRepository(ledger);
  const settlements = new FakeSettlementRepository();
  const payments = new FakePaymentRepository();
  const refunds = new FakeRefundRepository();
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) };
  const payable = new ProviderPayableService(ledgerRepo as never);

  return {
    ledger,
    ledgerRepo,
    settlements,
    payments,
    refunds,
    audit,
    payable,
    run: new RunSettlementCommand(
      settlements,
      payments as never,
      refunds as never,
      uow,
      payable,
      audit as unknown as AuditService,
    ),
    get: new GetSettlementQuery(settlements),
    listQuery: new ListSettlementsQuery(settlements),
    reconcile: new AccountingReconciliationService(
      ledgerRepo as never,
      payments as never,
      settlements,
      payable,
    ),
  };
}

const AT = new Date('2026-09-15T10:00:00.000Z');
const runInput = { pharmacyId: PHARMACY, periodStart: PERIOD.start, periodEnd: PERIOD.end };

// =============================================================================================
// Period
// =============================================================================================

describe('SettlementPeriod', () => {
  it('is half-open, so a boundary posting belongs to exactly one period', () => {
    const september = SettlementPeriod.of(
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
    );
    const october = SettlementPeriod.of(
      new Date('2026-10-01T00:00:00.000Z'),
      new Date('2026-11-01T00:00:00.000Z'),
    );
    const boundary = new Date('2026-10-01T00:00:00.000Z');

    // The single property that keeps consecutive statements gapless without overlapping — an
    // inclusive end would pay this posting twice.
    expect(september.contains(boundary)).toBe(false);
    expect(october.contains(boundary)).toBe(true);
  });

  it('refuses an inverted or empty window', async () => {
    const day = new Date('2026-09-01T00:00:00.000Z');
    expect(() => SettlementPeriod.of(day, day)).toThrow(ApiException);
    expect(() => SettlementPeriod.of(new Date('2026-10-01Z'), day)).toThrow(ApiException);
  });
});

// =============================================================================================
// Derivation
// =============================================================================================

describe('ProviderPayableService — payable derived from the ledger', () => {
  it('settles a plain capture with no coupon', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 10_450, fee: 450 });

    const derived = await h.payable.derive(PHARMACY, ETB, PERIOD);

    expect(derived.totals).toMatchObject({
      providerPayableGross: 10_000,
      providerRefundClawback: 0,
      netPayable: 10_000,
      platformRevenue: 450,
      promotionExpense: 0,
      customerCashCollected: 10_450,
      lineCount: 1,
    });
  });

  it('derives 10,000 for the platform-funded coupon example, not 8,450 and not 8,000', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });

    const derived = await h.payable.derive(PHARMACY, ETB, PERIOD);

    // The pharmacy is owed what the capture credited it, which is more than the customer paid.
    // 8,450 would pay it out of cash collected; 8,450 − 450 = 8,000 would do that and charge the
    // commission twice. Both would short the pharmacy by the discount the platform promised.
    expect(derived.totals.netPayable).toBe(10_000);
    expect(derived.totals.customerCashCollected).toBe(8_450);
    expect(derived.totals.promotionExpense).toBe(2_000);
    expect(derived.totals.platformRevenue).toBe(450);
  });

  it('never lets promotion expense reduce the payable, at any discount', async () => {
    const h = harness();
    // Two orders identical but for the coupon. The payable must be the same for both.
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 10_450, fee: 450, discount: 0 });
    h.ledger.capture({ paymentId: 'p2', at: AT, gross: 8_450, fee: 450, discount: 2_000 });

    const derived = await h.payable.derive(PHARMACY, ETB, PERIOD);

    expect(derived.totals.netPayable).toBe(20_000);
    expect(derived.totals.promotionExpense).toBe(2_000);
    // Had the expense been netted in, this would read 18,000.
    expect(derived.totals.netPayable - derived.totals.promotionExpense).toBe(18_000);
  });

  it('keeps platform revenue separate from the payable in both directions', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    h.ledger.refund({ refundId: 'r1', at: AT, amount: 2_000, feeClawback: 107, promotionClawback: 473 });

    const derived = await h.payable.derive(PHARMACY, ETB, PERIOD);

    // Revenue moves by its own clawback, the payable by its own. Neither is derived from the other.
    expect(derived.totals.platformRevenue).toBe(450 - 107);
    expect(derived.totals.netPayable).toBe(10_000 - 2_366);
  });

  it('sums several orders for one provider and ignores another provider entirely', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 10_450, fee: 450 });
    h.ledger.capture({ paymentId: 'p2', at: AT, gross: 5_225, fee: 225 });
    h.ledger.capture({
      paymentId: 'p3',
      at: AT,
      gross: 9_999,
      fee: 0,
      pharmacyId: OTHER_PHARMACY,
    });

    const mine = await h.payable.derive(PHARMACY, ETB, PERIOD);
    const theirs = await h.payable.derive(OTHER_PHARMACY, ETB, PERIOD);

    expect(mine.totals.netPayable).toBe(10_000 + 5_000);
    expect(mine.totals.lineCount).toBe(2);
    expect(theirs.totals.netPayable).toBe(9_999);
  });

  it('reduces the payable by a full refund, to zero', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    h.ledger.refund({
      refundId: 'r1',
      at: AT,
      amount: 8_450,
      feeClawback: 450,
      promotionClawback: 2_000,
    });

    const derived = await h.payable.derive(PHARMACY, ETB, PERIOD);

    expect(derived.totals).toMatchObject({
      providerPayableGross: 10_000,
      providerRefundClawback: 10_000,
      netPayable: 0,
      platformRevenue: 0,
      promotionExpense: 0,
      customerCashCollected: 0,
    });
  });

  it('reduces the payable by a partial refund, using the posted clawback and not a recomputed one', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    // The figures the refund service actually posts for a 2,000 partial (ADR-016's cumulative
    // rounding): fee 107, promotion 473, provider 2,000 + 473 − 107 = 2,366.
    h.ledger.refund({ refundId: 'r1', at: AT, amount: 2_000, feeClawback: 107, promotionClawback: 473 });

    const derived = await h.payable.derive(PHARMACY, ETB, PERIOD);

    expect(derived.totals.providerPayableGross).toBe(10_000);
    expect(derived.totals.providerRefundClawback).toBe(2_366);
    expect(derived.totals.netPayable).toBe(7_634);
    expect(derived.totals.promotionExpense).toBe(2_000 - 473);
  });

  it('reads only the period it was asked for', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 10_450, fee: 450 });
    h.ledger.capture({
      paymentId: 'p2',
      at: new Date('2026-10-02T00:00:00.000Z'),
      gross: 5_225,
      fee: 225,
    });

    expect((await h.payable.derive(PHARMACY, ETB, PERIOD)).totals.netPayable).toBe(10_000);
  });

  it('is an empty statement, not an error, for a provider with no account at all', async () => {
    const h = harness();
    const derived = await h.payable.derive('pharmacy-never-traded', ETB, PERIOD);
    expect(derived.totals).toMatchObject({ netPayable: 0, lineCount: 0 });
  });
});

describe('SettlementCalculator', () => {
  it('refuses to mix currencies rather than adding minor units across them', () => {
    expect(() =>
      SettlementCalculator.lineFor(
        {
          transactionId: 't1',
          reference: 'CAPTURE-p1',
          type: LedgerTransactionType.CAPTURE,
          refType: 'payment',
          refId: 'p1',
          occurredAt: AT,
          legs: [
            {
              accountType: LedgerAccountType.PROVIDER_PAYABLE,
              ownerId: PHARMACY,
              direction: LedgerDirection.CREDIT,
              amount: 100,
              currency: 'USD',
            },
          ],
        },
        PHARMACY,
        ETB,
      ),
    ).toThrow(ApiException);
  });
});

// =============================================================================================
// Run
// =============================================================================================

describe('RunSettlementCommand', () => {
  it('writes a DRAFT statement whose figures stay separate', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    h.payments.payments.push(payment());

    const result = await h.run.execute(runInput);

    expect(result.replay).toBe(false);
    expect(result.settlement).toMatchObject({
      pharmacyId: PHARMACY,
      status: 'DRAFT',
      providerPayableGross: 10_000,
      refundClawback: 0,
      netPayable: 10_000,
      platformRevenue: 450,
      promotionExpense: 2_000,
      customerCashCollected: 8_450,
      lineCount: 1,
    });
    // The line names the posting it came from, which is what makes the statement reproducible
    // without re-deriving any historical pricing.
    expect(result.lines[0]).toMatchObject({
      ledgerReference: 'CAPTURE-p1',
      orderId: 'order-1',
      providerPayableDelta: 10_000,
      promotionExpenseDelta: 2_000,
    });
  });

  it('posts nothing to the ledger — a statement is a read written down', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    const before = {
      transactions: h.ledger.transactions.length,
      entries: h.ledger.entries.length,
    };

    await h.run.execute(runInput);

    // No SETTLEMENT posting, no payable debit. Recording money as sent before anything can send
    // it would be unrecoverable in an append-only ledger.
    expect(h.ledger.transactions).toHaveLength(before.transactions);
    expect(h.ledger.entries).toHaveLength(before.entries);
  });

  it('is idempotent: a second run replays the first statement rather than creating another', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });

    const first = await h.run.execute(runInput);
    const second = await h.run.execute(runInput);

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.settlement.id).toBe(first.settlement.id);
    expect(second.settlement.netPayable).toBe(first.settlement.netPayable);
    expect(h.settlements.settlements.size).toBe(1);
    // No second audit entry either — a replay is not an event.
    expect(h.audit.record).toHaveBeenCalledTimes(1);
  });

  it('does not fold a later capture into an already-generated statement', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 10_450, fee: 450 });
    const first = await h.run.execute(runInput);

    // A posting arriving after the statement was cut. The statement must not silently change:
    // an operator may already have approved the figure they were shown.
    h.ledger.capture({ paymentId: 'p2', at: AT, gross: 5_225, fee: 225 });
    const second = await h.run.execute(runInput);

    expect(second.replay).toBe(true);
    expect(second.settlement.netPayable).toBe(first.settlement.netPayable);
    expect(second.settlement.netPayable).toBe(10_000);
  });

  it('records the source ledger references in the audit trail', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });

    await h.run.execute({ ...runInput, actorUserId: 'finance-1' });

    const [entry] = h.audit.record.mock.calls[0];
    expect(entry).toMatchObject({ action: 'SETTLEMENT_GENERATED', resourceType: 'Settlement' });
    expect(entry.context).toMatchObject({
      pharmacyId: PHARMACY,
      netPayable: 10_000,
      platformRevenue: 450,
      promotionExpense: 2_000,
      ledgerReferences: ['CAPTURE-p1'],
    });
  });

  it('generates an empty statement for a provider with no activity', async () => {
    const h = harness();
    const result = await h.run.execute(runInput);
    expect(result.settlement).toMatchObject({ netPayable: 0, lineCount: 0 });
    expect(result.lines).toHaveLength(0);
  });

  it('rejects an invalid period before touching the ledger', async () => {
    const h = harness();
    expect(
      await codeOf(() =>
        h.run.execute({ pharmacyId: PHARMACY, periodStart: PERIOD.end, periodEnd: PERIOD.start }),
      ),
    ).toBe(ErrorCode.VALIDATION_ERROR);
    expect(h.settlements.settlements.size).toBe(0);
  });
});

describe('GetSettlementQuery', () => {
  it('returns the statement with its figures kept apart', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    const created = await h.run.execute(runInput);

    const view = await h.get.execute({ settlementId: created.settlement.id });

    expect(view).toMatchObject({
      netPayable: 10_000,
      platformRevenue: 450,
      promotionExpense: 2_000,
      customerCashCollected: 8_450,
    });
    expect(view.lines).toHaveLength(1);
  });

  it('reports another provider’s statement as missing rather than forbidden', async () => {
    const h = harness();
    const created = await h.run.execute(runInput);

    expect(
      await codeOf(() =>
        h.get.execute({ settlementId: created.settlement.id, pharmacyIds: [OTHER_PHARMACY] }),
      ),
    ).toBe(ErrorCode.NOT_FOUND);
  });

  it('omits lines from a list — a list is not a statement', async () => {
    const h = harness();
    await h.run.execute(runInput);
    const page = await h.listQuery.execute({ pharmacyId: PHARMACY });
    expect(page.total).toBe(1);
    expect(page.items[0]).not.toHaveProperty('lines');
  });

  // -------------------------------------------------------------------------------------------
  // Scope. `allowedPharmacyIds` is authorization; `pharmacyId` is a filter. The tests below are
  // the ones that would fail if a later change let the two be conflated.
  // -------------------------------------------------------------------------------------------

  it('restricts a list to the caller’s own providers', async () => {
    const h = harness();
    await h.run.execute(runInput);
    await h.run.execute({ ...runInput, pharmacyId: OTHER_PHARMACY });

    const page = await h.listQuery.execute({ allowedPharmacyIds: [PHARMACY] });

    expect(page.total).toBe(1);
    expect(page.items[0].pharmacyId).toBe(PHARMACY);
  });

  it('returns an empty page for a caller whose scope is empty, never every provider’s', async () => {
    const h = harness();
    await h.run.execute(runInput);

    const page = await h.listQuery.execute({ allowedPharmacyIds: [] });

    expect(page).toMatchObject({ items: [], total: 0 });
  });

  it('cannot be widened by a pharmacyId filter naming another provider', async () => {
    const h = harness();
    await h.run.execute({ ...runInput, pharmacyId: OTHER_PHARMACY });

    const page = await h.listQuery.execute({
      allowedPharmacyIds: [PHARMACY],
      pharmacyId: OTHER_PHARMACY,
    });

    expect(page).toMatchObject({ items: [], total: 0 });
  });

  it('intersects a pharmacyId filter with the scope when it is inside it', async () => {
    const h = harness();
    await h.run.execute(runInput);
    await h.run.execute({ ...runInput, pharmacyId: OTHER_PHARMACY });

    const page = await h.listQuery.execute({
      allowedPharmacyIds: [PHARMACY, OTHER_PHARMACY],
      pharmacyId: OTHER_PHARMACY,
    });

    expect(page.total).toBe(1);
    expect(page.items[0].pharmacyId).toBe(OTHER_PHARMACY);
  });

  it('reads a statement belonging to any pharmacy in the caller’s scope', async () => {
    const h = harness();
    const created = await h.run.execute({ ...runInput, pharmacyId: OTHER_PHARMACY });

    const view = await h.get.execute({
      settlementId: created.settlement.id,
      pharmacyIds: [PHARMACY, OTHER_PHARMACY],
    });

    expect(view.pharmacyId).toBe(OTHER_PHARMACY);
  });

  it('reports every statement as missing for an empty scope', async () => {
    const h = harness();
    const created = await h.run.execute(runInput);

    expect(
      await codeOf(() => h.get.execute({ settlementId: created.settlement.id, pharmacyIds: [] })),
    ).toBe(ErrorCode.NOT_FOUND);
  });

  it('filters by currency and status without touching the scope', async () => {
    const h = harness();
    await h.run.execute(runInput);

    expect((await h.listQuery.execute({ currency: 'ETB' })).total).toBe(1);
    expect((await h.listQuery.execute({ currency: 'USD' })).total).toBe(0);
    expect((await h.listQuery.execute({ status: SettlementStatus.DRAFT })).total).toBe(1);
    expect((await h.listQuery.execute({ status: SettlementStatus.PAID })).total).toBe(0);
  });
});

// =============================================================================================
// Reconciliation
// =============================================================================================

describe('AccountingReconciliationService', () => {
  it('reports nothing when the books agree', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    h.payments.payments.push(payment());
    await h.run.execute(runInput);

    const report = await h.reconcile.run();

    expect(report.anomalies).toEqual([]);
    expect(report.examined).toMatchObject({ capturedPayments: 1, settlements: 1 });
  });

  it('detects a CAPTURED payment with no capture posting behind it', async () => {
    const h = harness();
    // The malformed scenario: the payment says the money was captured, the ledger has no record.
    h.payments.payments.push(payment({ id: 'orphan' }));

    const report = await h.reconcile.run();

    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({
      kind: 'CAPTURE_POSTING_MISSING',
      subject: 'orphan',
    });
  });

  it('detects a capture whose legs break the ADR-019 invariant', async () => {
    const h = harness();
    // Credits the payable as though the coupon were platform-funded, but posts no promotion leg —
    // the shape a pharmacy-funded implementation would leave behind.
    h.ledger.post({
      reference: 'CAPTURE-p1',
      type: LedgerTransactionType.CAPTURE,
      refType: 'payment',
      refId: 'p1',
      at: AT,
      legs: [
        { type: LedgerAccountType.GATEWAY_CLEARING, direction: LedgerDirection.DEBIT, amount: 8_450 },
        {
          type: LedgerAccountType.PROVIDER_PAYABLE,
          ownerId: PHARMACY,
          direction: LedgerDirection.CREDIT,
          amount: 10_000,
        },
        { type: LedgerAccountType.PLATFORM_REVENUE, direction: LedgerDirection.CREDIT, amount: 450 },
      ],
    });
    h.payments.payments.push(payment({ id: 'p1' }));

    const report = await h.reconcile.run();
    const kinds = report.anomalies.map((anomaly) => anomaly.kind);

    expect(kinds).toContain('CAPTURE_POSTING_UNBALANCED');
    expect(kinds).toContain('TRANSACTION_UNBALANCED');
    expect(kinds).toContain('LEDGER_IMBALANCE');
  });

  it('detects a statement whose totals no longer match its own lines', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    const created = await h.run.execute(runInput);

    // Simulate a statement tampered with or written by an older derivation.
    const stored = h.settlements.settlements.get(created.settlement.id)!;
    h.settlements.settlements.set(created.settlement.id, { ...stored, netPayable: 8_450 });

    const report = await h.reconcile.run();

    expect(report.anomalies.map((anomaly) => anomaly.kind)).toContain(
      'SETTLEMENT_TOTAL_MISMATCH',
    );
  });

  it('mutates nothing — not the ledger, not the statements', async () => {
    const h = harness();
    h.ledger.capture({ paymentId: 'p1', at: AT, gross: 8_450, fee: 450, discount: 2_000 });
    h.payments.payments.push(payment({ id: 'orphan' }));
    await h.run.execute(runInput);

    const ledgerBefore = JSON.stringify({
      transactions: h.ledger.transactions,
      entries: h.ledger.entries,
      accounts: h.ledger.accounts,
    });
    const settlementsBefore = JSON.stringify([...h.settlements.settlements.values()]);

    const report = await h.reconcile.run();
    expect(report.anomalies.length).toBeGreaterThan(0);

    // Reporting a discrepancy must never be the thing that changes the books. A repair would be a
    // guess about which side is right, written where it can never be withdrawn.
    expect(
      JSON.stringify({
        transactions: h.ledger.transactions,
        entries: h.ledger.entries,
        accounts: h.ledger.accounts,
      }),
    ).toBe(ledgerBefore);
    expect(JSON.stringify([...h.settlements.settlements.values()])).toBe(settlementsBefore);
  });
});
