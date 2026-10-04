import { SettlementStatus } from '../enums';
import {
  SettlementLineProps,
  SettlementProps,
  SettlementWithLines,
} from '../entities/settlement.entity';

export const SETTLEMENT_REPOSITORY = Symbol('SETTLEMENT_REPOSITORY');

/** The settlement's natural key — see {@link ISettlementRepository.findByIdentity}. */
export interface SettlementIdentity {
  pharmacyId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
}

export interface ListSettlementsCriteria {
  /**
   * The providers whose statements may be returned.
   *
   * `undefined` means **unrestricted** and `[]` means **nothing matches** — the two are not
   * interchangeable, and an adapter that collapsed them would turn "this owner has no pharmacies"
   * into "every provider's statements". Callers resolve this from the authenticated principal
   * (`ProviderScopeService`), never from the request.
   */
  pharmacyIds?: string[];
  /** Statements whose period *starts* at or after this instant. */
  from?: Date;
  /** Statements whose period *ends* at or before this instant. */
  to?: Date;
  /** Exact match on the statement's currency — statements are never mixed-currency. */
  currency?: string;
  /**
   * Exact match on the lifecycle status. Every statement is `DRAFT` today; the filter exists
   * because the column does, not in anticipation of the approve/pay transitions, which have no
   * write path in this module.
   */
  status?: SettlementStatus;
  page: number;
  size: number;
}

export interface SettlementPage {
  items: SettlementProps[];
  total: number;
}

/**
 * The stored statement figures summed over one `(currency, status)` bucket (module-16 Work 07).
 *
 * Each field is `Σ` of the same-named column on `SettlementProps`, so the relationships the
 * aggregate guarantees per statement (`netPayable = providerPayableGross − refundClawback`;
 * `platformRevenue` and `promotionExpense` reported beside the payable, never applied to it) hold
 * for the sums too. Every statement is `DRAFT` today: an `APPROVED` or `PAID` bucket can only
 * appear once the payout flow that writes those states exists.
 */
export interface SettlementStatusTotals {
  currency: string;
  status: SettlementStatus;
  count: number;
  providerPayableGross: number;
  refundClawback: number;
  netPayable: number;
  platformRevenue: number;
  promotionExpense: number;
  customerCashCollected: number;
}

/**
 * Persistence port for settlement statements (§7's `settlements` / `payout_lines`, §10's
 * `ISettlementRepository`). Domain-facing snapshots only — no Prisma type crosses this boundary
 * (ADR-002).
 *
 * ## There is no update method, and that is the point
 *
 * A statement is a **report about an immutable ledger**, so it is itself immutable: re-running a
 * period must either return the statement that already exists or create the first one, never
 * rewrite figures an operator may already have acted on. If the underlying postings genuinely
 * changed — which, the ledger being append-only, can only mean *new* postings were added — the
 * honest record is a later statement covering them, not a silently edited earlier one.
 *
 * The one write this port will eventually need and deliberately does not have yet is a status
 * transition for `ApproveSettlement`/`ExecutePayout` (§11.5). Adding it now would be adding the
 * ability to mark money paid before anything can pay it.
 *
 * ## Identity and idempotency
 *
 * `(pharmacyId, periodStart, periodEnd, currency)` is the identity, enforced by a unique index so
 * the database — not a read-then-write in application code — is what makes a settlement run
 * idempotent. That mirrors how every other money operation in this module is made idempotent: a
 * deterministic natural key with a unique constraint behind it (`ledger_transactions.reference`,
 * `coupon_redemptions (couponId, orderId)`), never a second bespoke mechanism.
 */
export interface ISettlementRepository {
  /**
   * The idempotency lookup. Returns the committed statement for this identity, if one exists.
   *
   * Called both before a run (to replay cheaply) and again *inside* the run's Serializable
   * transaction, because the cheap check outside it can be raced.
   */
  findByIdentity(identity: SettlementIdentity, tx?: unknown): Promise<SettlementProps | null>;

  findById(id: string, tx?: unknown): Promise<SettlementProps | null>;

  /** A statement with every line, for a query or for reconciliation to re-check. */
  findWithLines(id: string, tx?: unknown): Promise<SettlementWithLines | null>;

  list(criteria: ListSettlementsCriteria, tx?: unknown): Promise<SettlementPage>;

  /**
   * Writes the statement and all of its lines together. Atomic by contract: a statement whose
   * lines are missing would report totals nothing substantiates, and lines with no statement would
   * be unreachable rows.
   *
   * Rejects a duplicate identity through the unique index; the caller decides whether that means
   * "replay" or "defect" (`RunSettlementCommand` treats it as a replay).
   */
  create(
    settlement: SettlementProps,
    lines: SettlementLineProps[],
    tx?: unknown,
  ): Promise<SettlementWithLines>;

  /**
   * Every statement whose period overlaps `[from, to)` for this pharmacy and currency.
   *
   * Exists for reconciliation, not for the run: it is what detects two statements that both claim
   * the same postings. The unique index prevents an *identical* period twice, but not a later run
   * with shifted boundaries that double-counts part of an earlier one — which would pay a
   * pharmacy twice for the same orders, and is precisely the failure a half-open period
   * (`SettlementPeriod`) is designed to make impossible and this check is designed to prove.
   */
  findOverlapping(
    pharmacyId: string,
    currency: string,
    from: Date,
    to: Date,
    tx?: unknown,
  ): Promise<SettlementProps[]>;

  /** The lines of a statement, for reconciliation's line-by-line re-derivation. */
  findLines(settlementId: string, tx?: unknown): Promise<SettlementLineProps[]>;

  /** Every `(currency, status)` bucket with its count and summed figures, in that order. */
  summarizeByStatus(tx?: unknown): Promise<SettlementStatusTotals[]>;
}
