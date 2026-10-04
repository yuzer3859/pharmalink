import { Inject, Injectable } from '@nestjs/common';
import { SettlementLineProps, SettlementProps } from '../../domain/entities/settlement.entity';
import { LedgerTransactionType, SettlementStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import {
  ISettlementRepository,
  SETTLEMENT_REPOSITORY,
} from '../../domain/repositories/settlement.repository';

/**
 * A statement as a reader sees it — the four figures kept apart, plus the one amount payable.
 *
 * Deliberately a projection rather than the repository snapshot: it drops nothing sensitive today,
 * but a statement is the shape a provider-facing route will eventually return, and letting the
 * persistence snapshot become that contract by default is how internal columns leak.
 */
export interface SettlementStatementView {
  settlementId: string;
  statementRef: string;
  pharmacyId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  status: SettlementStatus;
  /** What the provider earned this period, before clawbacks. */
  providerPayableGross: number;
  /** Refunds taken back out of the payable (BRULE-23's clawback). */
  refundClawback: number;
  /** `providerPayableGross − refundClawback` — **the amount owed**. */
  netPayable: number;
  /** Platform commission on these postings. Reported, never deducted from the payable again. */
  platformRevenue: number;
  /** Platform-funded coupon expense (ADR-019). Reported, never applied to the payable. */
  promotionExpense: number;
  /** What customers actually paid. Under a platform-funded coupon this is *less* than the payable. */
  customerCashCollected: number;
  lineCount: number;
  createdAt: Date;
  lines: SettlementLineView[];
}

export interface SettlementLineView {
  ledgerReference: string;
  transactionType: LedgerTransactionType;
  orderId: string | null;
  occurredAt: Date;
  providerPayableDelta: number;
  platformRevenueDelta: number;
  promotionExpenseDelta: number;
  customerCashDelta: number;
}

export interface GetSettlementInput {
  settlementId: string;
  /**
   * When present, the statement must belong to one of these providers or it is reported as
   * missing.
   *
   * An ownership check rather than a filter, and it answers `NOT_FOUND` rather than `FORBIDDEN`
   * for another provider's statement — the same no-existence-leakage discipline the rest of the
   * codebase uses, so a pharmacy cannot probe which statements exist.
   *
   * A **list**, because one organization can own several pharmacies; `[]` therefore means "this
   * caller may see nothing" and every statement is reported missing, while `undefined`/`null`
   * means unrestricted. HTTP callers always pass a resolved list (`ProviderScopeService`); the
   * unrestricted form is for in-process callers such as reconciliation.
   */
  pharmacyIds?: string[] | null;
}

/** `GetSettlements` (§10's `queries/`, §9.6) — read one statement with its lines. */
@Injectable()
export class GetSettlementQuery {
  constructor(
    @Inject(SETTLEMENT_REPOSITORY) private readonly settlements: ISettlementRepository,
  ) {}

  async execute(input: GetSettlementInput): Promise<SettlementStatementView> {
    const found = await this.settlements.findWithLines(input.settlementId);
    const scoped = input.pharmacyIds ?? null;
    if (!found || (scoped !== null && !scoped.includes(found.settlement.pharmacyId))) {
      throw PaymentErrors.notFound('Settlement not found.', {
        settlementId: input.settlementId,
      });
    }
    return toView(found.settlement, found.lines);
  }
}

export interface ListSettlementsInput {
  /**
   * **Authorization**, not a filter: the providers this caller may see at all. `[]` yields an
   * empty page; `undefined`/`null` is unrestricted and is only ever used in-process.
   *
   * Kept separate from `pharmacyId` on purpose. Conflating "what the caller asked for" with "what
   * the caller is allowed" is the shape most scope bugs take — a client-supplied filter silently
   * becoming the scope. Here the filter can only ever narrow this set.
   */
  allowedPharmacyIds?: string[] | null;
  /** An optional client-supplied narrowing filter, intersected with `allowedPharmacyIds`. */
  pharmacyId?: string;
  from?: Date;
  to?: Date;
  currency?: string;
  status?: SettlementStatus;
  page?: number;
  size?: number;
}

export interface SettlementSummaryPage {
  items: Omit<SettlementStatementView, 'lines'>[];
  total: number;
  page: number;
  size: number;
}

export const MAX_SETTLEMENT_PAGE_SIZE = 100;

/** Statement summaries, newest period first. Lines are omitted — a list is not a statement. */
@Injectable()
export class ListSettlementsQuery {
  constructor(
    @Inject(SETTLEMENT_REPOSITORY) private readonly settlements: ISettlementRepository,
  ) {}

  async execute(input: ListSettlementsInput = {}): Promise<SettlementSummaryPage> {
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const size = Math.min(MAX_SETTLEMENT_PAGE_SIZE, Math.max(1, Math.trunc(input.size ?? 20)));

    const pharmacyIds = resolveScope(input);
    // An authorized caller who owns nothing, or who filtered to a pharmacy outside their scope,
    // gets an empty page rather than an error: the route is theirs to call, there is simply
    // nothing in it for them. Short-circuiting here also means no unscoped query is ever issued.
    if (pharmacyIds !== undefined && pharmacyIds.length === 0) {
      return { items: [], total: 0, page, size };
    }

    const result = await this.settlements.list({
      pharmacyIds,
      from: input.from,
      to: input.to,
      currency: input.currency,
      status: input.status,
      page,
      size,
    });
    return {
      // Built without lines rather than destructured out of a full view, so a field added to the
      // statement view later is a deliberate decision here too, not an accident of spreading.
      items: result.items.map((settlement) => toSummaryView(settlement)),
      total: result.total,
      page,
      size,
    };
  }
}

/**
 * The effective provider set: the authorized scope narrowed by the optional filter.
 *
 * `undefined` (unrestricted, in-process only) with no filter stays `undefined`. A filter outside
 * the scope collapses to `[]` — not to the filter — so a client naming another provider's
 * pharmacy sees an empty page, never that provider's statements.
 */
function resolveScope(input: ListSettlementsInput): string[] | undefined {
  const allowed = input.allowedPharmacyIds ?? null;
  if (allowed === null) {
    return input.pharmacyId ? [input.pharmacyId] : undefined;
  }
  if (!input.pharmacyId) {
    return allowed;
  }
  return allowed.includes(input.pharmacyId) ? [input.pharmacyId] : [];
}

function toSummaryView(
  settlement: SettlementProps,
): Omit<SettlementStatementView, 'lines'> {
  return {
    settlementId: settlement.id,
    statementRef: settlement.statementRef,
    pharmacyId: settlement.pharmacyId,
    periodStart: settlement.periodStart,
    periodEnd: settlement.periodEnd,
    currency: settlement.currency,
    status: settlement.status,
    providerPayableGross: settlement.providerPayableGross,
    refundClawback: settlement.refundClawback,
    netPayable: settlement.netPayable,
    platformRevenue: settlement.platformRevenue,
    promotionExpense: settlement.promotionExpense,
    customerCashCollected: settlement.customerCashCollected,
    lineCount: settlement.lineCount,
    createdAt: settlement.createdAt,
  };
}

function toView(
  settlement: SettlementProps,
  lines: SettlementLineProps[],
): SettlementStatementView {
  return {
    ...toSummaryView(settlement),
    lines: lines.map((line) => ({
      ledgerReference: line.ledgerReference,
      transactionType: line.transactionType,
      orderId: line.orderId,
      occurredAt: line.occurredAt,
      providerPayableDelta: line.providerPayableDelta,
      platformRevenueDelta: line.platformRevenueDelta,
      promotionExpenseDelta: line.promotionExpenseDelta,
      customerCashDelta: line.customerCashDelta,
    })),
  };
}
