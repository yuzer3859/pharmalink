import { ReservationStatus } from '../../../domain/enums';

export const STOCK_RESERVATION_OPERATIONS_READ_PORT = Symbol('STOCK_RESERVATION_OPERATIONS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 04's domain layer. */
export { ReservationStatus } from '../../../domain/enums';

/** Every filter is a stored `stock_reservations` column, its listing's fixed owner, or a Module 04 rule at `generatedAt`. */
export interface StockReservationOperationsFilter {
  listingId?: string;
  pharmacyId?: string;
  branchId?: string;
  status?: ReservationStatus;
  /** The TTL sweeper's own selection rule at `generatedAt`: `status = HELD AND expiresAt < generatedAt`. */
  heldPastExpiry?: boolean;
  /** Inclusive lower / exclusive upper bound on `createdAt`. */
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * One recorded stock reservation, as Module 04's writers leave it. No order id, idempotency key or any
 * customer/owner identifier.
 *
 * - `quantity` — the units this reservation holds/held, as written by the reserve command. It is one
 *   reservation's figure, **not** the listing's `reserved` column (Work 49), which is the listing's own
 *   running total and is never re-derived from these rows.
 * - `status` — stored: `HELD` (reserve) → `CONFIRMED` (confirm) → stays `CONFIRMED` through dispatch;
 *   `RELEASED` (release) and `EXPIRED` (the TTL sweeper's release) are terminal.
 * - `expiresAt` — the hold's TTL as written at reserve time; it only governs `HELD` rows.
 * - `heldPastExpiry` — the sweeper's predicate (`HELD` and `expiresAt < generatedAt`, strictly): a hold
 *   past its TTL that the sweeper has not yet expired. Reading never expires it.
 * - `dispatched` — at least one `DISPATCH` stock movement names this reservation
 *   (`IReservationRepository.findDispatchMovements`' rule). Movements recorded before the
 *   `reservationId` column existed do not name one, so such a reservation reads `false`.
 *
 * The schema records no released, confirmed or dispatched timestamp and no `updatedAt`; none is shown.
 */
export interface StockReservationOperationsView {
  reservationId: string;
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: Date;
  heldPastExpiry: boolean;
  dispatched: boolean;
  createdAt: Date;
}

export interface StockReservationOperationsPage {
  generatedAt: Date;
  items: StockReservationOperationsView[];
  total: number;
  page: number;
  size: number;
}

export interface StockReservationOperationsDetail {
  generatedAt: Date;
  reservation: StockReservationOperationsView;
}

/**
 * Module 04's exported, read-only contract for **administrative reservation visibility** (module-16
 * Work 52). Newest first (`createdAt`, then `id`). Reservations of a since-deleted listing remain
 * visible — they are records of commitments made. It writes nothing; in particular it never expires
 * a lapsed hold.
 */
export interface IStockReservationOperationsReadPort {
  listReservations(filter: StockReservationOperationsFilter, page: number, size: number, now?: Date): Promise<StockReservationOperationsPage>;
  /** `null` when no reservation has this id. */
  getReservation(reservationId: string, now?: Date): Promise<StockReservationOperationsDetail | null>;
}
