import { authService, type SessionRequest } from './auth.service';

/**
 * Work 108: the pharmacy portal's orders on the real API (module-06 §9.4, Work 107's read).
 * `GET /pharmacy/orders` lists the fulfilments of the signed-in user's pharmacies; the four actions
 * move one through accept → prepare → ready, or decline it with a reason. All need
 * `order:fulfill:org`. There is no customer contact data in any of it.
 *
 * Work 132 (owner decision 2026-11-16): an order with a prescription medicine carries the
 * customer's prescription. The pharmacist sees who ordered (name only) and approves or rejects the
 * prescription on the order itself (`prescription:verify`); there is no separate prescriptions page.
 */

export type FulfillmentStatus = 'PENDING' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'DISPATCHED' | 'DELIVERED' | 'CANCELLED';

export const FULFILLMENT_STATUSES: FulfillmentStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];

export interface PharmacyOrderLine {
  id: string;
  catalogProductId: string;
  productName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  requiresRx: boolean;
  lineStatus: string;
}

export type RxReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface PharmacyOrderPrescription {
  id: string;
  status: string;
  fileType: string | null;
  doctorName: string | null;
  hospitalName: string | null;
  uploadedAt: string;
}

export interface PharmacyOrder {
  id: string;
  orderId: string;
  pharmacyId: string;
  branchId: string;
  status: FulfillmentStatus;
  deliveryJobId: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  createdAt: string;
  order: {
    orderNumber: string;
    status: string;
    isCod: boolean;
    grandTotal: number;
    currency: string;
    placedAt: string | null;
    deliverySlot: string | null;
    /** `null` for an order without a prescription. */
    rxReviewStatus?: RxReviewStatus | null;
  };
  /** The customer's name from their profile; no contact data. */
  customerName?: string | null;
  prescription?: PharmacyOrderPrescription | null;
  lines: PharmacyOrderLine[];
  requiresRx: boolean;
}

export interface PharmacyOrderPage {
  items: PharmacyOrder[];
  total: number;
}

export interface PharmacyOrderFilters {
  status?: FulfillmentStatus | 'all';
  /** 1-based. */
  page?: number;
  /** The server allows at most 50. */
  size?: number;
}

export const PHARMACY_ORDER_PAGE_SIZES = [10, 25, 50] as const;

/** The server's decline reason rule: 3 to 500 characters. */
export const DECLINE_REASON_MIN = 3;
export const DECLINE_REASON_MAX = 500;

export function pharmacyOrderQuery(filters: PharmacyOrderFilters): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(Math.min(filters.size, 50)));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export type FulfillmentAction = 'accept' | 'decline' | 'prepare' | 'ready';

/** The prescription on this order still waits for the pharmacist's decision. */
export function awaitingRxReview(order: Pick<PharmacyOrder, 'order'>): boolean {
  return order.order.rxReviewStatus === 'PENDING';
}

/**
 * What the pharmacy can do next (module-06's fulfilment policy). After READY the order is the
 * driver's: the hand-over is the driver's pick-up, and the status follows the delivery. While the
 * prescription waits for review the only decision is the review itself (the server refuses a
 * decline then), and a prepaid order is accepted only once the customer has paid.
 */
export function nextActions(status: FulfillmentStatus, rxReviewStatus?: RxReviewStatus | null): FulfillmentAction[] {
  if (rxReviewStatus === 'PENDING') return [];
  switch (status) {
    case 'PENDING':
      return ['accept', 'decline'];
    case 'ACCEPTED':
      return ['prepare'];
    case 'PREPARING':
      return ['ready'];
    default:
      return [];
  }
}

/** A plain sentence for where the order is, from the pharmacy's side. */
export function stageLabel(status: FulfillmentStatus): string {
  switch (status) {
    case 'PENDING':
      return 'New: accept or decline it';
    case 'ACCEPTED':
      return 'Accepted: start preparing';
    case 'PREPARING':
      return 'Preparing: mark it ready when packed';
    case 'READY':
      return 'Ready: waiting for the driver to pick it up';
    case 'DISPATCHED':
      return 'With the driver';
    case 'DELIVERED':
      return 'Delivered';
    case 'CANCELLED':
      return 'Cancelled';
  }
}

/** Where the order is, including the prescription review and the customer's payment before it. */
export function orderStageLabel(f: Pick<PharmacyOrder, 'status' | 'order'>): string {
  if (f.order.rxReviewStatus === 'PENDING') return 'Prescription to review: approve or reject it';
  if (f.order.rxReviewStatus === 'REJECTED') return 'Prescription rejected: the order is cancelled';
  if (f.status === 'PENDING' && f.order.status === 'PENDING_PAYMENT') return 'Prescription approved: waiting for the customer to pay';
  return stageLabel(f.status);
}

/** The payment column: COD, paid, or still to be paid. */
export function paymentLabel(f: Pick<PharmacyOrder, 'order'>): string {
  if (f.order.isCod) return 'COD';
  return f.order.status === 'PENDING_PAYMENT' ? 'Not paid yet' : 'Paid';
}

/** The server's rule for a rejection reason (the customer sees it): 3 to 500 characters. */
export const REJECT_REASON_MIN = 3;
export const REJECT_REASON_MAX = 500;

export function rejectReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REJECT_REASON_MIN) return `Give a reason of at least ${REJECT_REASON_MIN} characters.`;
  if (length > REJECT_REASON_MAX) return `At most ${REJECT_REASON_MAX} characters.`;
  return null;
}

export function declineReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length < DECLINE_REASON_MIN) return `Give a reason of at least ${DECLINE_REASON_MIN} characters.`;
  if (length > DECLINE_REASON_MAX) return `At most ${DECLINE_REASON_MAX} characters.`;
  return null;
}

export function createPharmacyOrdersService(request: SessionRequest) {
  const act = (fulfillmentId: string, action: FulfillmentAction, body?: unknown) =>
    request<unknown>(`/pharmacy/orders/${encodeURIComponent(fulfillmentId)}/${action}`, body === undefined ? { method: 'POST' } : { method: 'POST', body });
  return {
    list(filters: PharmacyOrderFilters = {}): Promise<PharmacyOrderPage> {
      return request<PharmacyOrderPage>(`/pharmacy/orders${pharmacyOrderQuery(filters)}`, { method: 'GET' });
    },
    get(fulfillmentId: string): Promise<PharmacyOrder> {
      return request<PharmacyOrder>(`/pharmacy/orders/${encodeURIComponent(fulfillmentId)}`, { method: 'GET' });
    },
    accept: (fulfillmentId: string) => act(fulfillmentId, 'accept'),
    prepare: (fulfillmentId: string) => act(fulfillmentId, 'prepare'),
    ready: (fulfillmentId: string) => act(fulfillmentId, 'ready'),
    decline: (fulfillmentId: string, reason: string) => act(fulfillmentId, 'decline', { reason: reason.trim() }),
    /** Both attestations are required by the server. A COD order is then confirmed; a prepaid one waits for the customer to pay. */
    approvePrescription: (fulfillmentId: string, attest: { legibilityOk: boolean; validityOk: boolean }) =>
      request<unknown>(`/pharmacy/orders/${encodeURIComponent(fulfillmentId)}/prescription/approve`, { method: 'POST', body: attest }),
    /** Cancels the order and releases its stock; the customer sees the reason. */
    rejectPrescription: (fulfillmentId: string, reason: string) =>
      request<unknown>(`/pharmacy/orders/${encodeURIComponent(fulfillmentId)}/prescription/reject`, { method: 'POST', body: { reason: reason.trim() } }),
  };
}

export const pharmacyOrdersService = createPharmacyOrdersService(authService.request);
