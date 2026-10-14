import {
  StockReservationOperationsDetail,
  StockReservationOperationsPage,
  StockReservationOperationsView,
} from '../../../pharmacy-inventory/application/ports/inbound/stock-reservation-operations-read.port';

/**
 * One reservation — ids, its own `quantity`, stored `status`, `expiresAt`, the sweeper's
 * `heldPastExpiry` at `generatedAt`, `dispatched`, `createdAt`. No order id, idempotency key or
 * customer/owner identifier. `quantity` is this reservation's, not the listing's `reserved` total.
 */
export interface StockReservationOperationsResponse {
  reservationId: string;
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  quantity: number;
  status: string;
  expiresAt: string;
  heldPastExpiry: boolean;
  dispatched: boolean;
  createdAt: string;
}

export interface StockReservationOperationsListResponse {
  generatedAt: string;
  items: StockReservationOperationsResponse[];
  total: number;
  page: number;
  size: number;
}

export interface StockReservationOperationsDetailResponse extends StockReservationOperationsResponse {
  generatedAt: string;
}

// Explicit allow-lists, never spreads of port objects.
export function toStockReservationOperationsResponse(r: StockReservationOperationsView): StockReservationOperationsResponse {
  return {
    reservationId: r.reservationId,
    listingId: r.listingId,
    pharmacyId: r.pharmacyId,
    branchId: r.branchId,
    catalogProductId: r.catalogProductId,
    quantity: r.quantity,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    heldPastExpiry: r.heldPastExpiry,
    dispatched: r.dispatched,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toStockReservationOperationsListResponse(p: StockReservationOperationsPage): StockReservationOperationsListResponse {
  return { generatedAt: p.generatedAt.toISOString(), items: p.items.map(toStockReservationOperationsResponse), total: p.total, page: p.page, size: p.size };
}

export function toStockReservationOperationsDetailResponse(d: StockReservationOperationsDetail): StockReservationOperationsDetailResponse {
  return { ...toStockReservationOperationsResponse(d.reservation), generatedAt: d.generatedAt.toISOString() };
}
