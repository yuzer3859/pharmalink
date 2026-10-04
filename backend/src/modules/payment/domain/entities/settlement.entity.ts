import { LedgerTransactionType, SettlementStatus } from '../enums';
import { PaymentErrors } from '../errors';
import { SettlementLineDraft, SettlementTotals } from '../services/settlement-calculator';

/**
 * The persisted shape of a settlement statement (§7's `settlements`, extended by this task's
 * migration — see it for why the original columns were insufficient).
 *
 * Every monetary field is minor units in `currency`, and every one of them is **derived from the
 * ledger**, never from an order's pricing. A statement carries no `subtotal`, no `deliveryFee` and
 * no coupon code for exactly that reason: those are Module 06 facts that a statement must not
 * appear to re-assert.
 */
export interface SettlementProps {
  id: string;
  /** The provider being settled — `PROVIDER_PAYABLE.ownerId`, i.e. a `Pharmacy.id`. */
  pharmacyId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  /** Σ of the period's positive payable movements: what the pharmacy earned. */
  providerPayableGross: number;
  /** Σ of the negative ones, positive here: refund clawbacks (BRULE-23). */
  refundClawback: number;
  /** `providerPayableGross − refundClawback`. The amount owed, and the only payable figure. */
  netPayable: number;
  /**
   * Platform commission on these postings. Reported beside the payable, **never** subtracted from
   * it: the fee was already withheld when the capture split the gross, so taking it again here
   * would charge the pharmacy twice.
   */
  platformRevenue: number;
  /**
   * Platform-funded coupon expense on these postings (ADR-019). Reported, and **never** applied to
   * the payable in either direction — the platform bears it, which is the whole point of the
   * decision. A positive number here alongside a smaller `customerCashCollected` is the visible
   * signature of a discount the platform funded.
   */
  promotionExpense: number;
  /** What the customer actually paid through the gateway. Context for reconciliation only. */
  customerCashCollected: number;
  lineCount: number;
  status: SettlementStatus;
  /** Stable human/ops handle for the statement, deterministic in the identity — see `statementRefFor`. */
  statementRef: string;
  paidAt: Date | null;
  createdAt: Date;
}

/** One statement line: a single ledger posting, with its four signed figures. */
export interface SettlementLineProps {
  id: string;
  settlementId: string;
  /** The posting this line reports. The line is reproducible from it alone. */
  ledgerTransactionId: string;
  /** `CAPTURE-<paymentId>` / `REFUND-<refundId>` — the unique business reference (BRULE-25). */
  ledgerReference: string;
  transactionType: LedgerTransactionType;
  /** `'payment'` / `'refund'`, from the posting header. */
  sourceRefType: string | null;
  sourceRefId: string | null;
  /** The order this posting belongs to, when it could be resolved. Never re-priced, only labelled. */
  orderId: string | null;
  occurredAt: Date;
  currency: string;
  providerPayableDelta: number;
  platformRevenueDelta: number;
  promotionExpenseDelta: number;
  customerCashDelta: number;
  createdAt: Date;
}

/** A statement with its lines — what a query returns and what reconciliation re-checks. */
export interface SettlementWithLines {
  settlement: SettlementProps;
  lines: SettlementLineProps[];
}

/**
 * The deterministic statement reference.
 *
 * Built from the settlement's identity rather than from a sequence, so the same period for the
 * same provider always produces the same handle — a re-run that replays an existing statement
 * quotes the same reference an operator already has, and two people describing "the statement" are
 * describing one row. The ISO instants are compacted only to keep it legible in a UI.
 */
export function statementRefFor(
  pharmacyId: string,
  periodStart: Date,
  periodEnd: Date,
): string {
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `STL-${pharmacyId}-${stamp(periodStart)}-${stamp(periodEnd)}`;
}

/**
 * `Settlement` (§5.1 aggregate root) — a provider's statement for one period.
 *
 * The aggregate owns the **consistency of its own figures**, and nothing else. It does not decide
 * what a period is, does not read the ledger, and above all does not compute money: by the time it
 * is constructed, `SettlementCalculator` has already projected the postings and the numbers are
 * facts. What this class guarantees is that a statement cannot be stored in a state that
 * contradicts itself — a net that does not equal gross minus clawback, or a negative gross.
 *
 * It is created `DRAFT` and this task gives it no transitions. `APPROVED`/`PAID` belong to the
 * payout flow (§11.5's `ApproveSettlement`/`ExecutePayout`), which is explicitly out of scope:
 * moving a statement to `PAID` without an actual payout, and without the `SETTLEMENT` ledger
 * posting that must accompany it, would record money as sent that nobody sent.
 */
export class Settlement {
  private constructor(private readonly props: SettlementProps) {}

  static create(input: {
    id: string;
    pharmacyId: string;
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    totals: SettlementTotals;
    now?: Date;
  }): Settlement {
    const props: SettlementProps = {
      id: requireText(input.id, 'id'),
      pharmacyId: requireText(input.pharmacyId, 'pharmacyId'),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: requireText(input.currency, 'currency'),
      providerPayableGross: input.totals.providerPayableGross,
      refundClawback: input.totals.providerRefundClawback,
      netPayable: input.totals.netPayable,
      platformRevenue: input.totals.platformRevenue,
      promotionExpense: input.totals.promotionExpense,
      customerCashCollected: input.totals.customerCashCollected,
      lineCount: input.totals.lineCount,
      status: SettlementStatus.DRAFT,
      statementRef: statementRefFor(input.pharmacyId, input.periodStart, input.periodEnd),
      paidAt: null,
      createdAt: input.now ?? new Date(),
    };
    assertConsistent(props);
    return new Settlement(props);
  }

  static rehydrate(props: SettlementProps): Settlement {
    return new Settlement({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get netPayable(): number {
    return this.props.netPayable;
  }

  toProps(): SettlementProps {
    return { ...this.props };
  }
}

/**
 * The invariants a stored statement must satisfy.
 *
 * Deliberately arithmetic rather than business: this is the last place a projection defect can be
 * caught before it becomes a payout instruction, and the alternative to failing loudly is paying a
 * pharmacy a number nobody computed.
 */
function assertConsistent(props: SettlementProps): void {
  for (const [field, value] of [
    ['providerPayableGross', props.providerPayableGross],
    ['refundClawback', props.refundClawback],
    ['lineCount', props.lineCount],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw PaymentErrors.validation(`${field} must be a non-negative integer.`, { field, value });
    }
  }

  if (props.netPayable !== props.providerPayableGross - props.refundClawback) {
    throw PaymentErrors.validation('netPayable must equal providerPayableGross - refundClawback.', {
      providerPayableGross: props.providerPayableGross,
      refundClawback: props.refundClawback,
      netPayable: props.netPayable,
    });
  }

  for (const [field, value] of [
    ['platformRevenue', props.platformRevenue],
    ['promotionExpense', props.promotionExpense],
    ['customerCashCollected', props.customerCashCollected],
    ['netPayable', props.netPayable],
  ] as const) {
    // Signed on purpose. A period containing only refunds legitimately has a negative net payable
    // and negative revenue — that is a pharmacy that owes the platform money back, and clamping it
    // to zero would silently forgive the debt.
    if (!Number.isInteger(value)) {
      throw PaymentErrors.validation(`${field} must be an integer (minor units).`, { field, value });
    }
  }

  if (props.periodStart.getTime() >= props.periodEnd.getTime()) {
    throw PaymentErrors.validation('periodStart must be strictly before periodEnd.', {
      field: 'periodStart',
    });
  }
}

/** Builds the persisted line shape from the calculator's draft. */
export function toSettlementLineProps(
  draft: SettlementLineDraft,
  input: { id: string; settlementId: string; orderId: string | null; now?: Date },
): SettlementLineProps {
  return {
    id: input.id,
    settlementId: input.settlementId,
    ledgerTransactionId: draft.transactionId,
    ledgerReference: draft.reference,
    transactionType: draft.type,
    sourceRefType: draft.refType,
    sourceRefId: draft.refId,
    orderId: input.orderId,
    occurredAt: draft.occurredAt,
    currency: draft.currency,
    providerPayableDelta: draft.providerPayableDelta,
    platformRevenueDelta: draft.platformRevenueDelta,
    promotionExpenseDelta: draft.promotionExpenseDelta,
    customerCashDelta: draft.customerCashDelta,
    createdAt: input.now ?? new Date(),
  };
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
