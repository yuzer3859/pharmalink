-- Work 129 (owner decision 2026-11-16): the prescription is attached to the order at checkout and
-- the pharmacist reviews it on the order. Additive and nullable.
CREATE TYPE "OrderRxReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "orders" ADD COLUMN "prescriptionId" TEXT,
ADD COLUMN "rxReviewStatus" "OrderRxReviewStatus",
ADD COLUMN "rxReviewedAt" TIMESTAMP(3);
