export const RESERVATION_STATUS_READ_PORT = Symbol('RESERVATION_STATUS_READ_PORT');

/**
 * One reservation as Module 04 holds it now (Work 55, decline recovery): status, its listing and that
 * listing's branch, the hold's expiry, and whether a `DISPATCH` movement names it. Ids and states only.
 */
export interface ReservationStatusView {
  reservationId: string;
  listingId: string;
  branchId: string;
  status: 'HELD' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED';
  expiresAt: Date;
  dispatched: boolean;
}

/**
 * Batch read of reservation state for Module 06's decline-recovery reconciler and its operational view
 * (one query, no locks). Unknown ids are simply absent from the result. Read-only.
 */
export interface IReservationStatusReadPort {
  findReservations(reservationIds: string[]): Promise<ReservationStatusView[]>;
}
