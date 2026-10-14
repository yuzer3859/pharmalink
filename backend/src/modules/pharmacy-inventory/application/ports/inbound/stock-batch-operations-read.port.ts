export const STOCK_BATCH_OPERATIONS_READ_PORT = Symbol('STOCK_BATCH_OPERATIONS_READ_PORT');

/** Every filter is a stored `stock_batches` column, its listing's fixed owner, or the expiry rule at `generatedAt`. */
export interface StockBatchOperationsFilter {
  listingId?: string;
  pharmacyId?: string;
  branchId?: string;
  catalogProductId?: string;
  /** Inclusive lower / exclusive upper bound on `expiryDate`. */
  expiresFrom?: Date;
  expiresTo?: Date;
  /** `SellableStockCalculator`'s rule at `generatedAt`: expired ⇔ `expiryDate <= generatedAt`. */
  isExpired?: boolean;
  /** Inclusive lower / exclusive upper bound on `createdAt`. */
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * One stock batch of a live listing (Work 49's population: batches of a soft-deleted listing are not
 * listed). No batch number, supplier, cost or reservation.
 *
 * - `quantity` — the batch's own **current on-hand** count, as Module 04 maintains it: set on receipt,
 *   moved by adjustments, drawn down by dispatch. Reservations do not touch it (they are the listing's
 *   `reserved`), and expiry does not either — an expired batch keeps its quantity; it simply stops
 *   counting toward sellable stock. It is not the listing's sellable figure (Work 49) and not a sum of
 *   movements (Work 50).
 * - `expiryDate` — never null in the schema.
 * - `isExpired` — `expiryDate <= generatedAt`, the complement of `SellableStockCalculator`'s
 *   `expiryDate > now`: a batch expiring exactly at `generatedAt` is expired. One `generatedAt` per
 *   response, so every row is classified against the same instant.
 * - `receivedAt` — the receipt date entered with the batch, when one was given.
 *
 * `stock_batches` has no `updatedAt` and no soft delete.
 */
export interface StockBatchOperationsView {
  batchId: string;
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  quantity: number;
  expiryDate: Date;
  isExpired: boolean;
  receivedAt: Date | null;
  createdAt: Date;
}

export interface StockBatchOperationsPage {
  generatedAt: Date;
  items: StockBatchOperationsView[];
  total: number;
  page: number;
  size: number;
}

export interface StockBatchOperationsDetail {
  generatedAt: Date;
  batch: StockBatchOperationsView;
}

/**
 * Module 04's exported, read-only contract for **administrative stock-batch and expiry review**
 * (module-16 Work 51). Soonest expiry first (`expiryDate`, then `id`). It writes nothing.
 */
export interface IStockBatchOperationsReadPort {
  listBatches(filter: StockBatchOperationsFilter, page: number, size: number, now?: Date): Promise<StockBatchOperationsPage>;
  /** `null` when there is no batch with this id on a live listing. */
  getBatch(batchId: string, now?: Date): Promise<StockBatchOperationsDetail | null>;
}
