-- Work 96: when Module 07 captured a prepaid order's payment at fulfilment (module-07 §11.3).
-- Additive and nullable: COD orders, and prepaid orders not yet ready, keep NULL.
ALTER TABLE "orders" ADD COLUMN "paymentCapturedAt" TIMESTAMP(3);

-- The capture reconciler's sweep: prepaid orders with a payment that is not yet captured.
CREATE INDEX "orders_uncaptured_prepaid_idx" ON "orders" ("status")
  WHERE "isCod" = false AND "paymentId" IS NOT NULL AND "paymentCapturedAt" IS NULL;
