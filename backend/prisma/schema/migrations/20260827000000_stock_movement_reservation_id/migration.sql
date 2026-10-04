-- Module 04 — Pharmacy & Inventory hardening (backend/docs/04-pharmacy-inventory-spec.md §8/§9,
-- dispatch fulfillment scoping). `stock_movements.refId` (`refType=ORDER, refId=orderId`) alone
-- cannot unambiguously identify which reservation a DISPATCH/RESERVE/RELEASE movement belongs to
-- once a single order can hold more than one reservation (same or different listings) — scoping
-- a fulfillment lookup by `orderId` alone could match a sibling reservation's movement under the
-- same order. `reservationId` is nullable for backfill safety against pre-existing rows and
-- because non-reservation-scoped movement types (RECEIPT/ADJUST/EXPIRE/RETURN) never set it;
-- every RESERVE/RELEASE/DISPATCH movement written going forward always sets it. Mirrors the
-- nullable-for-backfill pattern of `stock_reservations.idempotencyKey`
-- (20260826000000_reservation_idempotency_key).
ALTER TABLE "stock_movements" ADD COLUMN "reservationId" TEXT;

-- CreateIndex
CREATE INDEX "stock_movements_reservationId_idx" ON "stock_movements"("reservationId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "stock_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
