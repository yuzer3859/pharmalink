import {
  SettlementLineView,
  SettlementStatementView,
  SettlementSummaryPage,
} from '../../application/queries/get-settlement.query';
import {
  SettlementLineProps,
  SettlementProps,
  SettlementWithLines,
} from '../../domain/entities/settlement.entity';
import { LedgerTransactionType, SettlementStatus } from '../../domain/enums';

/**
 * A statement as HTTP exposes it (§9.6).
 *
 * An explicit allow-list, mapped field by field, for the same reason `toCouponResponse` is one: a
 * column added to `settlements` later must not silently become part of a provider-facing API.
 *
 * ## The four figures stay apart
 *
 * `netPayable`, `platformRevenue`, `promotionExpense` and `customerCashCollected` are separate
 * fields and are never combined here — no "net settlement" convenience field, no
 * `revenue − promotion`. That is not presentation fussiness: under ADR-019 a platform-funded
 * coupon makes `netPayable` *larger* than `customerCashCollected`, and a single collapsed number
 * would hide both that the platform spent the discount and that the pharmacy is owed more than
 * the customer paid. Anything derived from these belongs to the reader, not to the wire format.
 *
 * Every figure is an integer in minor units of `currency` (ADR-005), exactly as stored.
 *
 * ## What is deliberately absent
 *
 * - `paidAt` — approval and payout are not implemented, so it is always `null`; a field that can
 *   only ever say "unpaid" would read as a lifecycle this module does not have.
 * - Row ids of lines (`payout_lines.id`, `settlementId`, `ledgerTransactionId`) — a line is
 *   identified to a reader by `ledgerReference` (`CAPTURE-<paymentId>` / `REFUND-<refundId>`),
 *   the business key the ledger already guarantees unique. Handing out primary keys would leak
 *   persistence structure for no reader benefit.
 */
export interface SettlementResponse {
  settlementId: string;
  statementRef: string;
  pharmacyId: string;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  /** What the provider earned in the period, before clawbacks. */
  providerPayableGross: number;
  /** Refunds taken back out of the payable (BRULE-23), positive. */
  refundClawback: number;
  /** `providerPayableGross − refundClawback` — the amount owed. */
  netPayable: number;
  /** Platform commission on these postings. Reported, never deducted from the payable again. */
  platformRevenue: number;
  /** Platform-funded coupon expense (ADR-019). Reported, never applied to the payable. */
  promotionExpense: number;
  /** What customers actually paid. Under a platform-funded coupon, *less* than `netPayable`. */
  customerCashCollected: number;
  lineCount: number;
  status: SettlementStatus;
  createdAt: Date;
}

/** One statement line: a single ledger posting, with its four signed figures. */
export interface SettlementLineResponse {
  /** The posting's unique business reference — what makes this line reproducible. */
  ledgerReference: string;
  transactionType: LedgerTransactionType;
  /** The order this posting belongs to, when it could be resolved. A label, never a re-price. */
  orderId: string | null;
  occurredAt: Date;
  providerPayableDelta: number;
  platformRevenueDelta: number;
  promotionExpenseDelta: number;
  customerCashDelta: number;
}

export interface SettlementDetailResponse extends SettlementResponse {
  lines: SettlementLineResponse[];
}

export interface SettlementPageResponse {
  items: SettlementResponse[];
  total: number;
  page: number;
  size: number;
}

/**
 * The run response.
 *
 * `replay` is the honest answer to "did this call generate anything?". A second run of the same
 * period returns the identical statement with `replay: true`, so a caller can tell a fresh
 * statement from a replayed one without comparing timestamps — and cannot mistake the absence of
 * a duplicate for a failure.
 */
export interface RunSettlementResponse {
  replay: boolean;
  settlement: SettlementDetailResponse;
}

export function toSettlementResponse(view: Omit<SettlementStatementView, 'lines'>): SettlementResponse {
  return {
    settlementId: view.settlementId,
    statementRef: view.statementRef,
    pharmacyId: view.pharmacyId,
    currency: view.currency,
    periodStart: view.periodStart,
    periodEnd: view.periodEnd,
    providerPayableGross: view.providerPayableGross,
    refundClawback: view.refundClawback,
    netPayable: view.netPayable,
    platformRevenue: view.platformRevenue,
    promotionExpense: view.promotionExpense,
    customerCashCollected: view.customerCashCollected,
    lineCount: view.lineCount,
    status: view.status,
    createdAt: view.createdAt,
  };
}

export function toSettlementLineResponse(line: SettlementLineView): SettlementLineResponse {
  return {
    ledgerReference: line.ledgerReference,
    transactionType: line.transactionType,
    orderId: line.orderId,
    occurredAt: line.occurredAt,
    providerPayableDelta: line.providerPayableDelta,
    platformRevenueDelta: line.platformRevenueDelta,
    promotionExpenseDelta: line.promotionExpenseDelta,
    customerCashDelta: line.customerCashDelta,
  };
}

export function toSettlementDetailResponse(
  view: SettlementStatementView,
): SettlementDetailResponse {
  return {
    ...toSettlementResponse(view),
    lines: view.lines.map(toSettlementLineResponse),
  };
}

/**
 * The same mapping from the domain snapshot `RunSettlementCommand` returns.
 *
 * Deliberately a second explicit mapping rather than a re-read through `GetSettlementQuery`: the
 * command already holds the committed statement and its lines, and reading it back could only
 * differ by racing a concurrent write — which, statements being immutable, would mean a different
 * statement entirely. The only shape difference is `id` / `settlementId`.
 */
export function toRunSettlementResponse(
  result: SettlementWithLines & { replay: boolean },
): RunSettlementResponse {
  return {
    replay: result.replay,
    settlement: {
      ...toSettlementPropsResponse(result.settlement),
      lines: result.lines.map(toSettlementLinePropsResponse),
    },
  };
}

function toSettlementPropsResponse(settlement: SettlementProps): SettlementResponse {
  return toSettlementResponse({ ...settlement, settlementId: settlement.id });
}

function toSettlementLinePropsResponse(line: SettlementLineProps): SettlementLineResponse {
  return toSettlementLineResponse(line);
}

export function toSettlementPageResponse(page: SettlementSummaryPage): SettlementPageResponse {
  return {
    items: page.items.map(toSettlementResponse),
    total: page.total,
    page: page.page,
    size: page.size,
  };
}
