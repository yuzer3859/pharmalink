-- Module 04 — Pharmacy & Inventory, Slice 1 (backend/docs/04-pharmacy-inventory-spec.md §5.4/§8/§15).
-- `stock_reservations.idempotencyKey` persists the caller-supplied idempotency key so
-- `ReserveStockCommand` can dedup on it (previously accepted by the DTO but never persisted or
-- enforced — a pure application-layer pre-check on `(listingId, orderId)` outside the
-- transaction, racy under concurrency and not the spec's own idempotency key at all).
-- Nullable for backfill safety against any pre-existing rows; every new reservation always sets
-- it. Unique constraint is scoped per-listing — `(listingId, idempotencyKey)` — because the
-- resource an idempotent mutation protects here is a single listing's stock; the same key value
-- reused by a caller against a different listing is not the same logical operation.
ALTER TABLE "stock_reservations" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_listingId_idempotencyKey_key" ON "stock_reservations"("listingId", "idempotencyKey");
