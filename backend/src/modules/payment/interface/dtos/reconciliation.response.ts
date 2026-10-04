import {
  AccountingAnomaly,
  AccountingAnomalyKind,
  DEFAULT_CAPTURED_PAYMENT_LIMIT,
  ReconciliationReport,
  SETTLEMENT_SCAN_LIMIT,
} from '../../application/services/accounting-reconciliation.service';

/**
 * Whether the books agreed with themselves on this sweep.
 *
 * Two values, and a count and a list beside them — never a lone boolean. "Reconciled: false" tells
 * an operator that something is wrong and nothing about what or where, which is the one thing they
 * cannot act on.
 */
export type ReconciliationStatus = 'CLEAN' | 'DISCREPANCIES_FOUND';

/** What the `subject` of a discrepancy identifies, so a client need not parse it by shape. */
export type ReconciliationSubjectType =
  | 'PAYMENT'
  | 'LEDGER_REFERENCE'
  | 'SETTLEMENT'
  | 'CURRENCY';

/**
 * The numbers behind a discrepancy, as an **explicit allow-list of named keys**.
 *
 * The service carries its per-anomaly detail in a free-form `Record<string, unknown>`. Passing
 * that through would make every future field the service adds an accidental part of this API, so
 * each key below is read out by name, type-checked, and omitted when the anomaly kind has no such
 * figure. Nothing here is a secret: every one of these numbers already appears in the anomaly's
 * own human-readable message, and all are integer minor units (ADR-005) or plain counts.
 */
export interface ReconciliationFigures {
  /** `TRANSACTION_UNBALANCED`, `LEDGER_IMBALANCE` — the two sides that failed to match. */
  debits?: number;
  credits?: number;
  /** `CAPTURE_POSTING_UNBALANCED` — the four legs of ADR-019's `gross + promotion = payable + revenue`. */
  gross?: number;
  promotionExpense?: number;
  providerPayable?: number;
  platformRevenue?: number;
  /** `SETTLEMENT_*_MISMATCH` — what the statement says, against what the ledger derives now. */
  stored?: number;
  derived?: number;
  /** `SETTLEMENT_TOTAL_MISMATCH` — a statement header against its own lines. */
  lineSum?: number;
  storedLineCount?: number;
  actualLineCount?: number;
}

/**
 * One discrepancy, in the shape an operator needs to go and look at it.
 *
 * Identifiers are populated **only where the service already has them**. `orderId` and a provider
 * id are deliberately absent: no check resolves either, and adding the queries to find them would
 * mean the HTTP layer doing accounting work the service does not do — for a report whose whole
 * purpose is to say what the service found. A `settlementId` is the handle for both, through
 * `GET /settlements/{id}`.
 *
 * `details.transactionId` — a `ledger_transactions` primary key — is read and discarded, for the
 * same reason the settlement API exposes `ledgerReference` and not the row id: the business
 * reference is the durable handle, and primary keys are persistence structure.
 */
export interface ReconciliationDiscrepancyResponse {
  /** The machine-readable kind. Stable, and the thing to alert on. */
  code: AccountingAnomalyKind;
  /** The service's own message — safe to display and to log; never contains a secret. */
  description: string;
  /** Whatever identifies the thing at fault. */
  subject: string;
  subjectType: ReconciliationSubjectType;
  paymentId: string | null;
  settlementId: string | null;
  /** Other statements implicated — `DUPLICATE_SETTLEMENT`'s overlapping periods. */
  relatedSettlementIds: string[];
  /** `ledger_transactions.reference` (`CAPTURE-<paymentId>` / `REFUND-<refundId>`). */
  ledgerReferences: string[];
  /** A single headline amount, where the anomaly has one. Minor units of `currency`. */
  amount: number | null;
  currency: string | null;
  figures: ReconciliationFigures;
}

/**
 * What this sweep actually looked at.
 *
 * Present because "no discrepancies" is only meaningful next to "…across this much". Both scans
 * are capped, so a sweep that hit a cap has examined a prefix of the books rather than the books;
 * `truncated` says so outright instead of leaving an operator to compare counts against limits
 * they would have to know.
 */
export interface ReconciliationScopeResponse {
  /** `null` = every provider. */
  pharmacyId: string | null;
  /**
   * `true` when `pharmacyId` narrowed the settlement checks. The capture-posting and
   * ledger-balance checks are **always platform-wide** — `PLATFORM_REVENUE` and
   * `PROMOTION_EXPENSE` are platform-level accounts, and a ledger imbalance is not attributable to
   * one provider at all.
   */
  settlementChecksScoped: boolean;
  capturedPaymentsExamined: number;
  capturedPaymentLimit: number;
  settlementsExamined: number;
  settlementScanLimit: number;
  settlementLinesExamined: number;
  currenciesExamined: number;
  /** A cap was reached: this report describes part of the books, not all of them. */
  truncated: boolean;
}

export interface ReconciliationReportResponse {
  checkedAt: Date;
  status: ReconciliationStatus;
  discrepancyCount: number;
  scope: ReconciliationScopeResponse;
  discrepancies: ReconciliationDiscrepancyResponse[];
}

export function toReconciliationResponse(
  report: ReconciliationReport,
  options: { pharmacyId?: string; limit?: number },
): ReconciliationReportResponse {
  const capturedPaymentLimit = options.limit ?? DEFAULT_CAPTURED_PAYMENT_LIMIT;
  return {
    checkedAt: report.checkedAt,
    status: report.anomalies.length === 0 ? 'CLEAN' : 'DISCREPANCIES_FOUND',
    discrepancyCount: report.anomalies.length,
    scope: {
      pharmacyId: options.pharmacyId ?? null,
      settlementChecksScoped: options.pharmacyId !== undefined,
      capturedPaymentsExamined: report.examined.capturedPayments,
      capturedPaymentLimit,
      settlementsExamined: report.examined.settlements,
      settlementScanLimit: SETTLEMENT_SCAN_LIMIT,
      settlementLinesExamined: report.examined.settlementLines,
      currenciesExamined: report.examined.currencies,
      truncated:
        report.examined.capturedPayments >= capturedPaymentLimit ||
        report.examined.settlements >= SETTLEMENT_SCAN_LIMIT,
    },
    discrepancies: report.anomalies.map(toDiscrepancyResponse),
  };
}

function toDiscrepancyResponse(anomaly: AccountingAnomaly): ReconciliationDiscrepancyResponse {
  const details = anomaly.details ?? {};
  const base = {
    code: anomaly.kind,
    description: anomaly.message,
    subject: anomaly.subject,
    subjectType: SUBJECT_TYPES[anomaly.kind],
    paymentId: null as string | null,
    settlementId: null as string | null,
    relatedSettlementIds: [] as string[],
    ledgerReferences: [] as string[],
    amount: null as number | null,
    currency: null as string | null,
    figures: {} as ReconciliationFigures,
  };

  switch (anomaly.kind) {
    case 'CAPTURE_POSTING_MISSING':
      return {
        ...base,
        paymentId: anomaly.subject,
        ledgerReferences: refs(text(details.reference)),
        amount: num(details.amount),
        currency: text(details.currency),
      };

    case 'CAPTURE_POSTING_UNBALANCED':
      return {
        ...base,
        ledgerReferences: refs(anomaly.subject),
        figures: defined({
          gross: num(details.gross),
          promotionExpense: num(details.promotionDebit),
          providerPayable: num(details.payableCredit),
          platformRevenue: num(details.revenueCredit),
        }),
      };

    case 'TRANSACTION_UNBALANCED':
      return {
        ...base,
        ledgerReferences: refs(anomaly.subject),
        figures: defined({ debits: num(details.debits), credits: num(details.credits) }),
      };

    case 'LEDGER_IMBALANCE':
      return {
        ...base,
        currency: anomaly.subject,
        figures: defined({ debits: num(details.debit), credits: num(details.credit) }),
      };

    case 'PAYABLE_SOURCE_MISSING':
      return {
        ...base,
        // The payment the posting *should* name. What it names instead is in the description; it
        // is a dangling reference, not an identifier a client should follow.
        paymentId: text(details.paymentId),
        ledgerReferences: refs(anomaly.subject),
      };

    case 'DUPLICATE_SETTLEMENT':
      return {
        ...base,
        settlementId: anomaly.subject,
        relatedSettlementIds: textArray(details.overlapping),
      };

    case 'SETTLEMENT_LINE_MISMATCH':
      return {
        ...base,
        settlementId: text(details.settlementId),
        ledgerReferences: refs(anomaly.subject),
        figures: defined({
          stored: num(record(details.stored)?.providerPayableDelta),
          derived: num(record(details.derived)?.providerPayableDelta),
        }),
      };

    case 'SETTLEMENT_TOTAL_MISMATCH':
      return {
        ...base,
        settlementId: anomaly.subject,
        figures: defined({
          // The header-against-its-own-lines variant reports `netPayable`; the
          // header-against-the-ledger variant reports `stored`. Both mean "what the statement says".
          stored: num(details.stored) ?? num(details.netPayable),
          derived: num(details.derived),
          lineSum: num(details.lineSum),
          storedLineCount: num(details.lineCount),
          actualLineCount: num(details.actualLines),
        }),
      };
  }
}

const SUBJECT_TYPES: Record<AccountingAnomalyKind, ReconciliationSubjectType> = {
  CAPTURE_POSTING_MISSING: 'PAYMENT',
  CAPTURE_POSTING_UNBALANCED: 'LEDGER_REFERENCE',
  TRANSACTION_UNBALANCED: 'LEDGER_REFERENCE',
  LEDGER_IMBALANCE: 'CURRENCY',
  PAYABLE_SOURCE_MISSING: 'LEDGER_REFERENCE',
  DUPLICATE_SETTLEMENT: 'SETTLEMENT',
  SETTLEMENT_LINE_MISMATCH: 'LEDGER_REFERENCE',
  SETTLEMENT_TOTAL_MISMATCH: 'SETTLEMENT',
};

// -----------------------------------------------------------------------------------------------
// Readers. Each one type-checks rather than casts, so a detail that is missing or of an unexpected
// shape becomes an absent field — never `undefined` leaking into a response as a typed value, and
// never an exception thrown while reporting that the books are broken.
// -----------------------------------------------------------------------------------------------

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function refs(reference: string | null): string[] {
  return reference === null ? [] : [reference];
}

/** Drops the keys that had no value, so `figures` carries only what this anomaly actually knows. */
function defined(figures: Record<string, number | null>): ReconciliationFigures {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(figures)) {
    if (value !== null) {
      result[key] = value;
    }
  }
  return result;
}
