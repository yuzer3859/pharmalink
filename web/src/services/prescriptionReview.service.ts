import { authService, type SessionRequest } from './auth.service';

/**
 * Work 110: the pharmacist's prescription review (module-05 §9, Model A; owner decision
 * 2026-11-09, verify before paying). Checkout routes a customer's prescription to the pharmacy it
 * matched (Work 109); that pharmacy's pharmacist reviews it here. Every route needs
 * `prescription:verify` and the PHARMACIST role at the pharmacy the prescription was sent to.
 * The file opens only through the audited, short-lived preview link.
 */

export interface RequestedItem {
  catalogProductId: string;
  productName: string | null;
  quantity: number;
}

export interface ReviewPrescription {
  id: string;
  status: string;
  displayStatus?: string;
  fileType: string | null;
  doctorName: string | null;
  hospitalName: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  requestedItems?: RequestedItem[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewQueuePage {
  items: ReviewPrescription[];
  total: number;
}

export interface ApprovalLine {
  catalogProductId: string;
  approvedQuantity: number;
  refillsAllowed: number;
  isSingleUse: boolean;
}

export interface Approval {
  lines: ApprovalLine[];
  legibilityOk: boolean;
  validityOk: boolean;
}

export interface FilePreview {
  url: string;
  expiresAt: string;
  contentType: string;
}

/** The server's rules for a rejection reason and a clarification message: 3 to 500 characters. */
export const NOTE_MIN = 3;
export const NOTE_MAX = 500;

export function noteProblem(text: string): string | null {
  const length = text.trim().length;
  if (length < NOTE_MIN) return `Write at least ${NOTE_MIN} characters.`;
  if (length > NOTE_MAX) return `At most ${NOTE_MAX} characters.`;
  return null;
}

/**
 * The approval the form would send, or why it can't be sent. The pharmacist approves the items the
 * customer asked for; a quantity of 0 leaves an item out. The checks are the server's own: at least
 * one line, whole quantities of at least 1, refills of 0 or more, and both attestations.
 */
export function approvalProblem(approval: Approval): string | null {
  if (!approval.legibilityOk || !approval.validityOk) return 'Confirm the prescription is legible and valid.';
  if (approval.lines.length === 0) return 'Approve at least one item.';
  for (const line of approval.lines) {
    if (!Number.isInteger(line.approvedQuantity) || line.approvedQuantity < 1) return 'Approved quantities are whole numbers of at least 1.';
    if (!Number.isInteger(line.refillsAllowed) || line.refillsAllowed < 0) return 'Refills are whole numbers, 0 or more.';
  }
  return null;
}

export function reviewQueueQuery(page?: number, size?: number): string {
  const params = new URLSearchParams();
  if (page) params.set('page', String(page));
  if (size) params.set('size', String(Math.min(size, 50)));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function createPrescriptionReviewService(request: SessionRequest) {
  const path = (id: string, action?: string) =>
    `/pharmacy/verification/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
  return {
    queue(page?: number, size?: number): Promise<ReviewQueuePage> {
      return request<ReviewQueuePage>(`/pharmacy/verification/queue${reviewQueueQuery(page, size)}`, { method: 'GET' });
    },
    get(id: string): Promise<ReviewPrescription> {
      return request<ReviewPrescription>(path(id), { method: 'GET' });
    },
    /** A short-lived link to the file; the server records each one. */
    filePreview(id: string): Promise<FilePreview> {
      return request<FilePreview>(path(id, 'file'), { method: 'POST' });
    },
    approve(id: string, approval: Approval): Promise<unknown> {
      return request(path(id, 'approve'), { method: 'POST', body: approval });
    },
    reject(id: string, reason: string): Promise<unknown> {
      return request(path(id, 'reject'), { method: 'POST', body: { reason: reason.trim() } });
    },
    clarify(id: string, message: string): Promise<unknown> {
      return request(path(id, 'clarify'), { method: 'POST', body: { message: message.trim() } });
    },
  };
}

export const prescriptionReviewService = createPrescriptionReviewService(authService.request);
