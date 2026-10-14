import { StockMovementRefType, StockMovementType } from '../../../domain/enums';

export const STOCK_MOVEMENT_OPERATIONS_READ_PORT = Symbol('STOCK_MOVEMENT_OPERATIONS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 04's domain layer. */
export { StockMovementRefType, StockMovementType } from '../../../domain/enums';

/** Every filter is a stored `stock_movements` column, or the immutable owner of its listing. */
export interface StockMovementOperationsFilter {
  listingId?: string;
  /** Through the movement's listing (`inventory_listings.pharmacyId`, fixed when the listing is created). */
  pharmacyId?: string;
  /** Through the movement's listing (`inventory_listings.branchId`, fixed when the listing is created). */
  branchId?: string;
  batchId?: string;
  type?: StockMovementType;
  /** Inclusive lower / exclusive upper bound on `createdAt`. */
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * One recorded stock movement — an append-only ledger row; nothing on it is ever updated.
 *
 * `quantityDelta` is stored as written, in units, with the writer's sign. **Which figure it moved
 * depends on `type`** (Module 04's writers):
 *
 * | type     | writer                                      | sign | moves                         |
 * |----------|---------------------------------------------|------|-------------------------------|
 * | RECEIPT  | create listing / add batch                  |  +   | on-hand (a batch's quantity)  |
 * | ADJUST   | adjust batch                                |  ±   | on-hand (a batch's quantity)  |
 * | RESERVE  | reserve stock                               |  −   | sellable, via `reserved` (+)  |
 * | RELEASE  | release reservation / TTL expiry            |  +   | sellable, via `reserved` (−)  |
 * | DISPATCH | dispatch stock (one row per batch drawn)    |  −   | on-hand and `reserved` (−)    |
 * | EXPIRE, RETURN | no writer yet — enum values only      |      |                               |
 *
 * So deltas of different types are not one quantity and must not be added up as a balance. No
 * before/after balance is stored, and none is derived: the listing's current figures are its
 * *present* state (Work 49), not the result of any past movement.
 *
 * `pharmacyId`, `branchId` and `catalogProductId` come from the movement's listing; all three are
 * fixed at listing creation. The free-text `reason` (an operator's note, or an idempotency key), the
 * `refId` (an order or import id), the `reservationId` and the `actorUserId` are not part of this view.
 */
export interface StockMovementOperationsView {
  movementId: string;
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  batchId: string | null;
  type: StockMovementType;
  quantityDelta: number;
  /** What kind of source the writer recorded (ORDER, IMPORT, MANUAL, SYSTEM) — the kind only, never its id. */
  refType: StockMovementRefType | null;
  createdAt: Date;
}

export interface StockMovementOperationsPage {
  items: StockMovementOperationsView[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 04's exported, read-only contract for **administrative stock-movement history** (module-16
 * Work 50). Newest first (`createdAt`, then `id`). Movements of a since-deleted listing remain:
 * history is not erased by a soft delete. It writes nothing.
 */
export interface IStockMovementOperationsReadPort {
  listMovements(filter: StockMovementOperationsFilter, page: number, size: number): Promise<StockMovementOperationsPage>;
  /** `null` when no movement has this id. */
  getMovement(movementId: string): Promise<StockMovementOperationsView | null>;
}
