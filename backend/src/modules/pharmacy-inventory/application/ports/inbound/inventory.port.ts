import { ApiException } from '../../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../../shared/errors/error-codes';

export const INVENTORY_PORT = Symbol('INVENTORY_PORT');

export interface ReserveStockInput {
  listingId: string;
  quantity: number;
  orderId: string;
  idempotencyKey: string;
}

export interface ReserveStockResult {
  reservationId: string;
  expiresAt: Date;
}

export interface ReservationFulfillmentView {
  reservationId: string;
  status: string;
  dispatched: boolean;
  dispatchedQuantity: number;
}

/**
 * The module's own exported contract for reserve/confirm/release/dispatch (module-04 §10.3,
 * §14.6) — consumed in-process by other modules (Module 06, later) via Nest DI, never over
 * HTTP. Implemented by an application-layer service, not by a controller.
 */
export interface IInventoryPort {
  reserve(input: ReserveStockInput): Promise<ReserveStockResult>;
  confirm(input: { reservationId: string }): Promise<void>;
  release(input: { reservationId: string; reason?: string }): Promise<void>;
  dispatch(input: { reservationId: string; actorUserId?: string }): Promise<void>;
  getReservationFulfillment(reservationId: string): Promise<ReservationFulfillmentView>;
  /**
   * All-or-nothing release of a set of reservations in ONE transaction (Work 55, customer
   * cancellation): every reservation is locked (sorted id order) and checked before any write.
   * If any `CONFIRMED` reservation has already been dispatched the whole call rejects —
   * {@link isDispatchedReservationRejection} — and nothing is released. `RELEASED`/`EXPIRED`
   * reservations are no-ops, as for `release()`.
   */
  releaseAllUnlessDispatched(input: { reservationIds: string[]; reason?: string }): Promise<void>;
}

/** True for `releaseAllUnlessDispatched`'s (and `release()`'s) already-dispatched rejection. */
export function isDispatchedReservationRejection(err: unknown): boolean {
  if (!(err instanceof ApiException) || err.code !== ErrorCode.INVALID_RESERVATION_STATE) return false;
  const details = err.details as { from?: unknown } | undefined;
  return details?.from === 'DISPATCHED';
}
