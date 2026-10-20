import { DeclineRecoveryPage, DeclineRecoverySegment } from '../../../orders/application/ports/inbound/decline-recovery-read.port';

export interface OrderDeclineRecoveryItemResponse {
  orderId: string;
  orderStatus: string;
  lineId: string;
  fulfillmentId: string | null;
  fulfillmentStatus: string | null;
  fulfillmentCreatedAt: string | null;
  reservationId: string | null;
  listingId: string | null;
  reservationStatus: string | null;
  reservationExpiresAt: string | null;
  state: string;
  diagnosticCode: string;
}

export interface OrderDeclineRecoveryListResponse {
  generatedAt: string;
  /** Per-state segment counts for THIS PAGE's orders only (`countsScope`), never global totals. */
  pageCounts: { PENDING_CONFIRMATION: number; CONFIRMATION_FAILED: number; ORPHANED: number; RESOLVED: number };
  countsScope: 'CURRENT_PAGE';
  items: OrderDeclineRecoveryItemResponse[];
  /** Global: every candidate order (live, declined at least once, not being cancelled). */
  totalOrders: number;
  page: number;
  size: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-lists, never spreads of port objects: ids, statuses, timestamps, a diagnostic code.
export function toOrderDeclineRecoveryItemResponse(s: DeclineRecoverySegment): OrderDeclineRecoveryItemResponse {
  return {
    orderId: s.orderId,
    orderStatus: s.orderStatus,
    lineId: s.lineId,
    fulfillmentId: s.fulfillmentId,
    fulfillmentStatus: s.fulfillmentStatus,
    fulfillmentCreatedAt: iso(s.fulfillmentCreatedAt),
    reservationId: s.reservationId,
    listingId: s.listingId,
    reservationStatus: s.reservationStatus,
    reservationExpiresAt: iso(s.reservationExpiresAt),
    state: s.state,
    diagnosticCode: s.diagnosticCode,
  };
}

export function toOrderDeclineRecoveryListResponse(p: DeclineRecoveryPage): OrderDeclineRecoveryListResponse {
  return {
    generatedAt: p.generatedAt.toISOString(),
    pageCounts: {
      PENDING_CONFIRMATION: p.pageCounts.PENDING_CONFIRMATION,
      CONFIRMATION_FAILED: p.pageCounts.CONFIRMATION_FAILED,
      ORPHANED: p.pageCounts.ORPHANED,
      RESOLVED: p.pageCounts.RESOLVED,
    },
    countsScope: 'CURRENT_PAGE',
    items: p.items.map(toOrderDeclineRecoveryItemResponse),
    totalOrders: p.totalOrders,
    page: p.page,
    size: p.size,
  };
}
