import { authService, type SessionRequest } from './auth.service';

/**
 * Work 125 (live-walk deviations 6 and 8): the two finance actions the operations portal lacked.
 *
 * - **Run a statement** (`finance:settlement:any`): from Work 124's `GET /admin/finance/settlements/due`,
 *   which pharmacies are owed since their last statement and what a run would carry; running one is
 *   `POST /admin/finance/settlements/run` over that same period. A run produces a **draft**:
 *   approving it and paying it out each need a second finance officer (Module 16 maker-checker).
 * - **Reconciliation** (`finance:report:any`): `GET /admin/finance/reconciliation`, read-only.
 *
 * Kept apart from `adminFinanceService`, whose read-only promise its own tests pin.
 */

export interface SettlementDue {
  pharmacyId: string;
  pharmacyName: string | null;
  currency: string;
  periodStart: string;
  periodEnd: string;
  netPayable: number;
  lineCount: number;
  oldestLineAt: string | null;
  lastStatement: { settlementId: string; periodEnd: string; status: string } | null;
  autoRunTrigger: string | null;
}

export interface RunResult {
  replay: boolean;
  settlement: { settlementId: string; statementRef: string; netPayable: number; status: string; currency: string };
}

export interface ReconciliationDiscrepancy {
  code: string;
  description: string;
  subject: string;
  subjectType: string;
  paymentId: string | null;
  settlementId: string | null;
  amount: number | null;
  currency: string | null;
}

export interface ReconciliationReport {
  checkedAt: string;
  status: 'CLEAN' | 'DISCREPANCIES_FOUND';
  discrepancyCount: number;
  scope: {
    pharmacyId: string | null;
    capturedPaymentsExamined: number;
    settlementsExamined: number;
    settlementLinesExamined?: number;
    currenciesExamined?: number;
  };
  discrepancies: ReconciliationDiscrepancy[];
}

/** The run's body for a due row: the period it reported, ending now, never earlier than it started. */
export function runRequest(due: SettlementDue, now = new Date()) {
  const end = new Date(Math.max(now.getTime(), Date.parse(due.periodEnd)));
  return { pharmacyId: due.pharmacyId, periodStart: due.periodStart, periodEnd: end.toISOString(), currency: due.currency };
}

export const TRIGGER_TEXT: Record<string, string> = {
  AMOUNT: 'The automatic run would generate it now (amount reached).',
  PERIOD: 'The automatic run would generate it now (period passed).',
};

export function createFinanceStatementsService(request: SessionRequest) {
  return {
    due: () => request<{ items: SettlementDue[]; checkedAt: string }>('/admin/finance/settlements/due', { method: 'GET' }),
    run: (due: SettlementDue) => request<RunResult>('/admin/finance/settlements/run', { method: 'POST', body: runRequest(due) }),
    reconciliation: () => request<ReconciliationReport>('/admin/finance/reconciliation', { method: 'GET' }),
  };
}

export const financeStatementsService = createFinanceStatementsService(authService.request);
