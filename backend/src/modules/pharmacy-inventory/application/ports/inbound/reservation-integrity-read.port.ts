export const RESERVATION_INTEGRITY_READ_PORT = Symbol('RESERVATION_INTEGRITY_READ_PORT');

/**
 * Module 04's read-only diagnostic of `InventoryListing.reserved` against its reservation records
 * (consumed by Module 16 Work 54). Detection only — nothing is repaired, released, expired or
 * recomputed, and no audit or outbox row is written.
 *
 * The invariant, from Module 04's own writers (the only writers of `reserved`):
 *  - `ReserveStockCommand` adds `quantity` and creates the reservation `HELD`, in one transaction;
 *  - `ReleaseReservationCommand` subtracts it as `HELD`/`CONFIRMED` becomes `RELEASED`;
 *  - `expireLapsedHold` (TTL sweeper, and confirm since Work 53) subtracts it as `HELD` becomes `EXPIRED`;
 *  - `DispatchStockCommand` subtracts it for a `CONFIRMED` reservation, writes `DISPATCH` movements
 *    carrying its `reservationId`, and leaves it `CONFIRMED`; its own already-dispatched guard is
 *    "a `DISPATCH` movement with this `reservationId` exists";
 *  - `ConfirmReservationCommand` (`HELD -> CONFIRMED`) does not change it; create-listing sets it to 0.
 * So a reservation contributes its `quantity` while it is `HELD` (even past `expiresAt`, until the
 * expiry commits) or `CONFIRMED` with no `DISPATCH` movement referencing it; `RELEASED` and `EXPIRED`
 * reservations, and dispatched ones, contribute nothing.
 *
 * Limitation: `stock_movements.reservationId` is nullable for movements written before it existed
 * (and is `SET NULL` if a reservation row were ever deleted). A `DISPATCH` movement without it cannot
 * be tied to a reservation, so on a listing that has one, an undispatched-looking `CONFIRMED`
 * reservation may in fact have been dispatched. Such a listing is `undetermined` — counted
 * separately, never as consistent and never as a discrepancy.
 *
 * Population: live listings (`deletedAt IS NULL`), as Work 49. Module 04's listing lock ignores
 * soft-deleted listings, so no release/expiry/dispatch can maintain their counter any more.
 */
export interface ReservationIntegrityFilter {
  pharmacyId?: string;
  branchId?: string;
}

/** One live listing whose stored counter differs from the reservation-derived one. */
export interface ReservationIntegrityDiscrepancy {
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  /** `inventory_listings.reserved` as stored. */
  storedReserved: number;
  /** Σ `quantity` of the contributing reservations (the rule above). */
  reservationDerivedReserved: number;
  /** `storedReserved - reservationDerivedReserved`; never 0 here. */
  difference: number;
  /** How many reservation rows contribute. */
  contributingReservations: number;
}

export interface ReservationIntegrityPage {
  generatedAt: Date;
  items: ReservationIntegrityDiscrepancy[];
  total: number;
  page: number;
  size: number;
}

/** Every live listing in scope falls in exactly one of the three classes. */
export interface ReservationIntegritySummary {
  generatedAt: Date;
  listingsChecked: number;
  listingsConsistent: number;
  listingsWithDiscrepancy: number;
  listingsUndetermined: number;
}

export interface IReservationIntegrityReadPort {
  /** Discrepancies only, largest `|difference|` first, then `listingId`. One snapshot for rows and total. */
  listDiscrepancies(filter: ReservationIntegrityFilter, page: number, size: number): Promise<ReservationIntegrityPage>;
  /** Class counts over the same population, from one snapshot. */
  getSummary(filter: ReservationIntegrityFilter): Promise<ReservationIntegritySummary>;
}
