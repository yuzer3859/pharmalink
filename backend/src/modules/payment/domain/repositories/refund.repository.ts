import { RefundProps } from '../entities/refund.entity';
import { RefundDestination, RefundStatus, RefundType } from '../enums';

export const REFUND_REPOSITORY = Symbol('REFUND_REPOSITORY');

/**
 * Fields required to insert a brand-new `refunds` row (§7). The caller supplies the `id` and an
 * already-validated entity state (`Refund.create(...).toProps()`), so the repository never
 * re-derives domain values and never re-decides eligibility.
 *
 * **PCI (BRULE-26, NFR-SEC-04): no field here carries card data**, and none can — a refund to the
 * original method is addressed by the gateway's own reference, never by an instrument.
 */
export interface NewRefundData {
  id: string;
  paymentId: string;
  amount: number;
  reason?: string | null;
  type: RefundType;
  destination: RefundDestination;
  status: RefundStatus;
  providerRef?: string | null;
  approvedBy?: string | null;
  idempotencyKey: string;
}

/**
 * Fields an already-validated (`RefundStatusPolicy`) `Refund` transition writes. The state machine
 * lives in the domain — this repository persists whichever state the caller has already proven
 * legal, exactly as `IPaymentRepository.updateState` does for `Payment`.
 *
 * `completedAt` travels with the transition that sets it, so a completion and its timestamp can
 * never be written apart from one another.
 */
export interface RefundStateUpdate {
  status: RefundStatus;
  providerRef?: string | null;
  completedAt?: Date | null;
}

/**
 * The filters a platform-wide refund read may narrow by (module-16 Work 07). Each is a column of
 * `refunds`; nothing searches the free-text `reason`. `createdFrom` inclusive, `createdTo`
 * exclusive.
 */
export interface RefundSearchCriteria {
  status?: RefundStatus;
  type?: RefundType;
  destination?: RefundDestination;
  paymentId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * A refund with the one thing the row does not carry: its currency, which §7 keeps on the
 * payment alone (see `RefundProps`). Read through the relation so the two can never disagree.
 */
export interface RefundRecord {
  refund: RefundProps;
  currency: string;
}

export interface RefundPage {
  items: RefundRecord[];
  total: number;
  page: number;
  size: number;
}

/**
 * `COUNT(*)` and `Σ amount` over the refunds in one `(currency, status)` bucket — currency being
 * the payment's. A `COMPLETED` bucket is money that has gone back; `PENDING` is money reserved
 * and not yet moved; `FAILED` moved nothing. Reported apart, never netted.
 */
export interface RefundStatusTotals {
  currency: string;
  status: RefundStatus;
  count: number;
  amount: number;
}

/**
 * Persistence port for the `Refund` entity (§5.1, §7 `refunds`). Domain/application-facing
 * snapshots only — no Prisma type crosses this boundary (ADR-002), exactly like every Module
 * 04/05/06 repository and its `IPaymentRepository`/`ILedgerRepository` siblings.
 *
 * Every method takes an optional `tx` handle so a refund command can compose its refund write,
 * its ledger posting, its payment transition, its audit entry and its outbox event inside one
 * `Serializable` transaction (ADR-010, ADR-013).
 *
 * ## The over-refund guarantee, and where it actually lives
 *
 * {@link totalRefundedForPayment} is the read BRULE-24's invariant is decided against. It is a
 * plain aggregate read — it takes **no** lock of its own, and deliberately so: the atomicity comes
 * from running that read and the subsequent {@link create} inside one `Serializable` transaction,
 * where PostgreSQL's serializable snapshot isolation turns "two transactions each read the same
 * sum, then each insert into the range they summed" into a serialization failure for one of them.
 * That is the classic write-skew SSI exists to catch, and it is why the caller must never split
 * the read and the insert across two transactions. A `SELECT ... FOR UPDATE`-style lock is not
 * used because the rows being protected are the ones that do not exist yet.
 *
 * There is deliberately **no** `delete` and no method that rewrites an amount: a refund that
 * should not have happened is corrected by a compensating posting and a new record, never by
 * editing the financial history (§13, ADR-006).
 */
export interface IRefundRepository {
  findById(id: string, tx?: unknown): Promise<RefundProps | null>;

  /**
   * Idempotency-replay lookup (BRULE-25, §5.3). `refunds.idempotencyKey` is `@unique`, so the
   * database is the final arbiter of "one key, one refund": a repeated refund request with the
   * same key is resolved by re-reading through this method and returning (or resuming) the
   * already-committed refund, never by inserting a second row. Mirrors
   * `IPaymentRepository.findByIdempotencyKey`.
   */
  findByIdempotencyKey(idempotencyKey: string, tx?: unknown): Promise<RefundProps | null>;

  /** Every refund against a payment, oldest first — the input to §9.3's list endpoint. */
  findByPaymentId(paymentId: string, tx?: unknown): Promise<RefundProps[]>;

  /**
   * Σ `amount` over the refunds of one payment that count against the refunded total
   * (`RefundStatusPolicy.countsAgainstRefundedTotal` — everything except `FAILED`, because a
   * declined refund moved no money and its amount is refundable again).
   *
   * Returned in minor units; the caller pairs it with the payment's currency (§7's `refunds` has
   * no currency column by design — see `RefundProps`). Zero when the payment has no refunds.
   */
  totalRefundedForPayment(paymentId: string, tx?: unknown): Promise<number>;

  /**
   * Σ `amount` over the refunds of one payment that have **actually completed** — `COMPLETED` only,
   * excluding `PENDING` as well as `FAILED`.
   *
   * This is deliberately a *different* number from {@link totalRefundedForPayment}, and the two
   * answer different questions:
   *
   *  - "how much may still be *requested*?" counts `PENDING` too, because an in-flight refund has
   *    reserved that money and letting a second request spend it would over-refund (BRULE-24).
   *    That is {@link totalRefundedForPayment}, and it gates eligibility.
   *  - "has this payment been repaid in full?" must count only money that has actually gone back.
   *    That is this method, and it decides §6's `REFUNDED` vs `PARTIALLY_REFUNDED` (ADR-018).
   *
   * Using the reserving total for the status would let a payment become `REFUNDED` while a
   * `PENDING` refund is still outstanding; if that refund then failed, its amount would be
   * refundable again but the payment would be stuck in a terminal `REFUNDED` state — money owed to
   * a customer that could never be paid. Hence the split.
   */
  totalCompletedRefundedForPayment(paymentId: string, tx?: unknown): Promise<number>;

  create(data: NewRefundData, tx?: unknown): Promise<RefundProps>;

  /** Persists a transition the domain has already validated; returns the committed row. */
  updateState(id: string, update: RefundStateUpdate, tx?: unknown): Promise<RefundProps>;

  /**
   * Platform-wide page, newest first (`createdAt desc, id desc`). Added for module-16 Work 07's
   * oversight read; §9.3's own list is per payment and oldest first, and stays so.
   */
  search(criteria: RefundSearchCriteria, page: number, size: number, tx?: unknown): Promise<RefundPage>;

  /** Every `(currency, status)` bucket with its count and amount, in that order. */
  summarizeByStatus(tx?: unknown): Promise<RefundStatusTotals[]>;
}
