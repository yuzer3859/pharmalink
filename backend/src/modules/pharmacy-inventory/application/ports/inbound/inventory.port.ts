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
}
