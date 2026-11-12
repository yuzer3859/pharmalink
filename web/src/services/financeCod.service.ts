import { authService, type SessionRequest } from './auth.service';

/**
 * Work 127 (found in the second live walk): recording the cash a driver hands to PharmaLink. The
 * owner's COD decision (Work 97) is that a pharmacy is paid only once COD cash reaches PharmaLink:
 * recording the remittance is what posts the COD sale to the pharmacy's payable, so without it a
 * COD order can never be settled. The backend existed (module-08 COD reconciliation); no page used it.
 *
 * - list: `GET /admin/delivery/cod-reconciliation` (`finance:report:any`)
 * - remit: `POST …/:collectionId/remit` (`finance:settlement:any`): the cash arrived
 * - reconcile: `POST …/:collectionId/reconcile` (`finance:settlement:any`): checked against the bank
 */

export type CodStatus = 'COLLECTED' | 'REMITTED' | 'RECONCILED';
export const COD_STATUSES: CodStatus[] = ['COLLECTED', 'REMITTED', 'RECONCILED'];

export interface CodCollection {
  id: string;
  jobId: string;
  orderId: string;
  driverId: string;
  expectedAmount: number;
  collectedAmount: number;
  currency: string;
  method: string;
  status: CodStatus;
  collectedAt: string;
  collectionVariance: number;
  remittanceVariance: number | null;
  hasDiscrepancy: boolean;
  isOutstanding: boolean;
  remittance: { remittedAmount: number; reference: string; remittedAt: string } | null;
  reconciliation: { outcome: string; reference: string | null; reconciledAt: string } | null;
}

export interface CodPage {
  items: CodCollection[];
  total: number;
  page: number;
  size: number;
}

/** The server's reference limit (`MAX_REMITTANCE_REFERENCE_LENGTH`). */
export const REFERENCE_MAX = 128;

/** Birr typed in the form to santim; null when not an amount of 0 or more. */
export function birrToSantim(birr: string): number | null {
  const value = Number(birr.replace(',', '.'));
  if (!birr.trim() || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function remitProblem(amountBirr: string, reference: string): string | null {
  if (birrToSantim(amountBirr) === null) return 'Enter the cash received, in birr.';
  const ref = reference.trim();
  if (!ref) return 'Enter the receipt or deposit reference.';
  if (ref.length > REFERENCE_MAX) return `At most ${REFERENCE_MAX} characters.`;
  return null;
}

export function codQuery(f: { status?: CodStatus | 'all'; page?: number; size?: number }): string {
  const params = new URLSearchParams();
  if (f.status && f.status !== 'all') params.set('status', f.status);
  if (f.page) params.set('page', String(f.page));
  if (f.size) params.set('size', String(Math.min(f.size, 50)));
  const q = params.toString();
  return q ? `?${q}` : '';
}

export function createFinanceCodService(request: SessionRequest) {
  const base = '/admin/delivery/cod-reconciliation';
  return {
    list: (f: { status?: CodStatus | 'all'; page?: number; size?: number } = {}) => request<CodPage>(`${base}${codQuery(f)}`, { method: 'GET' }),
    remit: (id: string, input: { remittedAmount: number; reference: string; note?: string }) =>
      request(`${base}/${encodeURIComponent(id)}/remit`, {
        method: 'POST',
        body: { remittedAmount: input.remittedAmount, reference: input.reference.trim(), ...(input.note?.trim() ? { note: input.note.trim() } : {}) },
      }),
    reconcile: (id: string, input: { reference?: string; note?: string } = {}) =>
      request(`${base}/${encodeURIComponent(id)}/reconcile`, {
        method: 'POST',
        body: { ...(input.reference?.trim() ? { reference: input.reference.trim() } : {}), ...(input.note?.trim() ? { note: input.note.trim() } : {}) },
      }),
  };
}

export const financeCodService = createFinanceCodService(authService.request);
