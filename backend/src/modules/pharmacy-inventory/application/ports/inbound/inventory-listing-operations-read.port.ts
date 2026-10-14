export const INVENTORY_LISTING_OPERATIONS_READ_PORT = Symbol('INVENTORY_LISTING_OPERATIONS_READ_PORT');

/** Every filter is a stored `inventory_listings` column or one of Module 04's existing rules at `now`. */
export interface InventoryListingOperationsFilter {
  pharmacyId?: string;
  branchId?: string;
  catalogProductId?: string;
  /** The stored `isEnabled` flag. */
  isEnabled?: boolean;
  /** The stored `sellable` column is above zero (`true`) or not (`false`). */
  hasStoredSellableStock?: boolean;
  /** Work 26's customer-purchasability rule holds now (`true`) or not (`false`). */
  customerPurchasable?: boolean;
  /** Inclusive lower / exclusive upper bound on `createdAt`. */
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * One live listing (`deletedAt IS NULL` — Work 08's tracked population, the one Work 25–27 count). No
 * product name, price, batch row, reservation row or user id.
 *
 * - `storedSellable` — the `sellable` column as last written by a stock change. It can lag: a batch
 *   that has expired since is still in it. Reported as stored, never reconciled by a read.
 * - `computedSellable` — `SellableStockCalculator.computeSellable` at `now`: `max(0, Σ quantity of
 *   batches with expiryDate > now − reserved)`, where `reserved` is the listing's own reserved column
 *   (the calculator's input), not a sum over reservation rows.
 * - `customerPurchasable` — Work 26's rule: discovery (`availableListingWhere`: enabled, live, stored
 *   `sellable > 0`, active branch, live eligible pharmacy) **and** `computedSellable > 0`.
 */
export interface InventoryListingOperationsView {
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  isEnabled: boolean;
  storedSellable: number;
  computedSellable: number;
  customerPurchasable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Detail-only aggregates, computed by the same rules. */
export interface InventoryListingOperationsDetail extends InventoryListingOperationsView {
  /** The listing's `reserved` column — the quantity the calculator subtracts. No reservation owner. */
  reserved: number;
  /** Batches with `expiryDate > now`, and their total quantity (the calculator's `onHandUnexpired`). */
  unexpiredBatchCount: number;
  unexpiredBatchQuantity: number;
  /** `storedSellable === computedSellable`; `false` means the stored column lags the calculator. */
  storedMatchesComputed: boolean;
}

export interface InventoryListingOperationsPage {
  items: InventoryListingOperationsView[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 04's exported, read-only contract for **administrative listing investigation** (module-16
 * Work 49). Newest first (`createdAt`, then `id`). It writes nothing — in particular it never
 * reconciles the stored `sellable` column.
 */
export interface IInventoryListingOperationsReadPort {
  listListings(filter: InventoryListingOperationsFilter, page: number, size: number, now?: Date): Promise<InventoryListingOperationsPage>;
  /** `null` when there is no live listing with this id. */
  getListing(listingId: string, now?: Date): Promise<InventoryListingOperationsDetail | null>;
}
