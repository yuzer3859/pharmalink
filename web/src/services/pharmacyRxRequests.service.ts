import { authService, type SessionRequest } from './auth.service';
import type { FilePreview } from './prescriptionReview.service';

/**
 * Work 137: the pharmacy portal's prescription requests (Works 134–136; owner decision 2026-11-17).
 * A customer sends a prescription; it is offered to every eligible pharmacy nearby; the first
 * pharmacist to accept owns it, quotes the medicines from the branch's stock, and the customer
 * confirms the quote into an order. Seeing requests needs `order:fulfill:org`; deciding (opening
 * the file, accepting, declining, letting go, quoting) needs `prescription:verify` and the
 * PHARMACIST role at the pharmacy it was offered to. Only the customer's name is shown.
 */

export type RxRequestStatus = 'OPEN' | 'CLAIMED' | 'QUOTED' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'NO_PHARMACY';
export type RxOfferStatus = 'OPEN' | 'WON' | 'TAKEN' | 'DECLINED' | 'LAPSED' | 'CLOSED';

export interface RxQuoteLine {
  catalogProductId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  controlledSchedule: string;
  requiresRx: boolean;
}

export interface RxQuote {
  lines: RxQuoteLine[];
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  grandTotal: number;
  currency: string;
  paperRequired: boolean;
  prescriptionIssueDate: string;
  note: string | null;
}

export interface PharmacyRxRequest {
  id: string;
  status: RxRequestStatus;
  offer: { status: RxOfferStatus; branchId: string; distanceMeters: number; respondedAt: string | null };
  /** This pharmacy holds it. */
  mine: boolean;
  customerName: string | null;
  prescription: { id: string; fileType: string | null; doctorName: string | null; hospitalName: string | null; uploadedAt: string } | null;
  prescriptionIssueDate: string;
  note: string | null;
  expiresAt: string;
  claimExpiresAt: string | null;
  quote: RxQuote | null;
  quoteExpiresAt: string | null;
  orderId: string | null;
  createdAt: string;
}

export interface RxRequestPage {
  items: PharmacyRxRequest[];
  total: number;
}

export interface QuoteInput {
  lines: Array<{ catalogProductId: string; quantity: number }>;
  prescriptionIssueDate: string;
  /** `undefined`: the server decides (required when a quoted medicine is a controlled substance). */
  paperRequired?: boolean;
  legibilityOk: boolean;
  validityOk: boolean;
  note?: string;
}

export type RxRequestAction = 'accept' | 'decline' | 'release' | 'quote';

/** What this pharmacy can do with the request now. */
export function rxRequestActions(r: Pick<PharmacyRxRequest, 'status' | 'offer' | 'mine'>): RxRequestAction[] {
  if (r.status === 'OPEN' && r.offer.status === 'OPEN') return ['accept', 'decline'];
  if (r.status === 'CLAIMED' && r.mine) return ['quote', 'release'];
  return [];
}

/** A plain sentence for where the request is, from the pharmacy's side. */
export function rxRequestStage(r: Pick<PharmacyRxRequest, 'status' | 'offer' | 'mine'>): string {
  if (r.offer.status === 'TAKEN') return 'Accepted by another pharmacy';
  if (r.offer.status === 'DECLINED') return 'Your pharmacy declined it';
  if (r.offer.status === 'LAPSED') return 'Not quoted in time: offered to the others again';
  switch (r.status) {
    case 'OPEN':
      return 'New: review it, then accept or decline';
    case 'CLAIMED':
      return r.mine ? 'Accepted by you: send the medicines and price' : 'Accepted by another pharmacy';
    case 'QUOTED':
      return 'Quote sent: waiting for the customer';
    case 'CONFIRMED':
      return 'Confirmed: it is an order now';
    case 'CANCELLED':
      return 'Cancelled';
    case 'EXPIRED':
      return 'Expired';
    case 'NO_PHARMACY':
      return 'Ended: no pharmacy could take it';
  }
}

/** The server's rule for a decline or release reason: 3 to 500 characters. */
export function reasonProblem(reason: string): string | null {
  const n = reason.trim().length;
  if (n < 3) return 'Give a reason of at least 3 characters.';
  if (n > 500) return 'At most 500 characters.';
  return null;
}

/** Why the quote cannot be sent yet, or `null`. The same checks as the server's. */
export function quoteProblem(q: QuoteInput): string | null {
  if (q.lines.length === 0) return 'Add at least one medicine.';
  if (new Set(q.lines.map((l) => l.catalogProductId)).size !== q.lines.length) return 'List each medicine once.';
  if (q.lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1)) return 'Quantities are whole numbers of at least 1.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.prescriptionIssueDate)) return 'Enter the date on the prescription.';
  if (!q.legibilityOk || !q.validityOk) return 'Confirm the prescription is legible and valid.';
  return null;
}

/**
 * Work 140: what is waiting for this pharmacy, for the portal-wide alert. `toAnswer`: offered to
 * it and still open, to accept or decline. `toQuote`: accepted by it, waiting for the medicines and price.
 */
export function rxRequestsWaiting(items: Array<Pick<PharmacyRxRequest, 'id' | 'status' | 'offer' | 'mine'>>): { toAnswer: string[]; toQuote: string[] } {
  return {
    toAnswer: items.filter((r) => r.status === 'OPEN' && r.offer.status === 'OPEN').map((r) => r.id),
    toQuote: items.filter((r) => r.status === 'CLAIMED' && r.mine).map((r) => r.id),
  };
}

/** The ids not seen before: the requests that arrived since the last check. */
export function newlyArrived(seen: ReadonlySet<string>, ids: string[]): string[] {
  return ids.filter((id) => !seen.has(id));
}

/** The banner's sentence, or `null` when nothing is waiting. */
export function rxRequestAlertText(w: { toAnswer: number; toQuote: number }): string | null {
  const parts: string[] = [];
  if (w.toAnswer === 1) parts.push('A new prescription request is waiting for your answer.');
  else if (w.toAnswer > 1) parts.push(`${w.toAnswer} new prescription requests are waiting for your answer.`);
  if (w.toQuote === 1) parts.push('A request you accepted is waiting for its medicines and price.');
  else if (w.toQuote > 1) parts.push(`${w.toQuote} requests you accepted are waiting for their medicines and price.`);
  return parts.length ? parts.join(' ') : null;
}

export function rxRequestQuery(scope: 'active' | 'all', page?: number, size?: number): string {
  const params = new URLSearchParams({ scope });
  if (page) params.set('page', String(page));
  if (size) params.set('size', String(Math.min(size, 50)));
  return `?${params.toString()}`;
}

export function createPharmacyRxRequestsService(request: SessionRequest) {
  const path = (id: string, action?: string) => `/pharmacy/rx-requests/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
  return {
    list(scope: 'active' | 'all' = 'active', page?: number, size?: number): Promise<RxRequestPage> {
      return request<RxRequestPage>(`/pharmacy/rx-requests${rxRequestQuery(scope, page, size)}`, { method: 'GET' });
    },
    get(id: string): Promise<PharmacyRxRequest> {
      return request<PharmacyRxRequest>(path(id), { method: 'GET' });
    },
    /** A short-lived, access-logged link to the prescription. */
    fileLink(id: string): Promise<FilePreview> {
      return request<FilePreview>(path(id, 'file'), { method: 'POST' });
    },
    accept: (id: string) => request<PharmacyRxRequest>(path(id, 'accept'), { method: 'POST' }),
    decline: (id: string, reason: string) => request<PharmacyRxRequest>(path(id, 'decline'), { method: 'POST', body: { reason: reason.trim() } }),
    release: (id: string, reason: string) => request<PharmacyRxRequest>(path(id, 'release'), { method: 'POST', body: { reason: reason.trim() } }),
    quote: (id: string, input: QuoteInput) =>
      request<PharmacyRxRequest>(path(id, 'quote'), {
        method: 'POST',
        body: { ...input, ...(input.note?.trim() ? { note: input.note.trim() } : { note: undefined }) },
      }),
  };
}

export const pharmacyRxRequestsService = createPharmacyRxRequestsService(authService.request);
