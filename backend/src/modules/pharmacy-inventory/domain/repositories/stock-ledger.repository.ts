import { StockBatchProps } from '../entities/stock-batch.entity';
import { StockMovementProps } from '../entities/stock-movement.entity';
import { StockMovementRefType, StockMovementType } from '../enums';

export const STOCK_LEDGER_REPOSITORY = Symbol('STOCK_LEDGER_REPOSITORY');

export interface NewMovementInput {
  listingId: string;
  batchId?: string | null;
  type: StockMovementType;
  quantityDelta: number;
  reason?: string | null;
  refType?: StockMovementRefType | null;
  refId?: string | null;
  actorUserId?: string | null;
  /** Explicit `StockReservation.id` back-reference (module-04 hardening) — see the doc comment
   * on `StockMovement.reservationId` in the schema. Always set by RESERVE/RELEASE/DISPATCH
   * movements; omitted for movement types that are never reservation-scoped. */
  reservationId?: string | null;
}

export interface IStockLedgerRepository {
  addBatch(
    batch: Omit<StockBatchProps, 'id' | 'createdAt'> & { id: string },
    tx?: unknown,
  ): Promise<void>;
  findBatchById(id: string, tx?: unknown): Promise<StockBatchProps | null>;
  /**
   * `SELECT ... FOR UPDATE` on a single batch row (module-04 §8/§17.3) — used by
   * `AdjustBatchCommand` to re-read the batch's current `quantity` INSIDE the transaction
   * before computing the new quantity, instead of trusting a pre-transaction `findBatchById`
   * read (racy under two concurrent adjustments to the same batch). Requires the interactive
   * transaction client.
   */
  lockBatchForUpdate(id: string, tx: unknown): Promise<StockBatchProps | null>;
  /** All non-empty batches for a listing, used by FEFO/sellable computation (§3.9). */
  findBatchesByListing(listingId: string, tx?: unknown): Promise<StockBatchProps[]>;
  /**
   * `SELECT ... FOR UPDATE` on every non-empty batch row for a listing, ordered FEFO
   * (module-04 hardening — global lock order, §8/§12: reservation → listing → affected
   * batches). Used by `DispatchStockCommand` after it has already locked the reservation and
   * the listing, so the batch rows it is about to decrement via FEFO allocation are explicitly
   * protected too — not just implicitly serialized by the listing lock — keeping the same lock
   * order (listing before batch) that `AdjustBatchCommand` now also follows, so the two flows
   * can never deadlock against each other.
   */
  lockBatchesForListing(listingId: string, tx: unknown): Promise<StockBatchProps[]>;
  adjustBatchQuantity(batchId: string, newQuantity: number, tx?: unknown): Promise<void>;
  recordMovement(movement: NewMovementInput & { id: string }, tx?: unknown): Promise<void>;
  listMovements(
    listingId: string,
    page: number,
    size: number,
    tx?: unknown,
  ): Promise<{ items: StockMovementProps[]; total: number }>;
  /** Reconciliation check (§3.10.4/§17.3): Σ(quantityDelta) grouped by listing. */
  sumMovementDeltas(listingId: string, tx?: unknown): Promise<number>;
}
