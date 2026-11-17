-- Work 136: the original paper prescription goes customer -> pharmacy on the delivery job, and the
-- pharmacist records checking it. Additive.
ALTER TABLE "delivery_jobs" ADD COLUMN "paperRxRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "paperCollectedAt" TIMESTAMP(3),
ADD COLUMN "goodsReadyAt" TIMESTAMP(3);

ALTER TABLE "orders" ADD COLUMN "paperRxVerifiedAt" TIMESTAMP(3),
ADD COLUMN "paperRxVerifiedById" TEXT;
