-- Module 06 — Orders: durable customer-cancellation intent (Work 55).
--
-- Customer cancellation is a three-step saga across module-owned transactions (ADR-014): Module 04
-- releases the order's reservations all-or-nothing, Module 06 cancels the order, Module 07 reverses
-- the coupon. A crash or a non-retryable failure between those steps used to lose the customer's
-- intent. This table persists it BEFORE the first Module 04 write so the request path and a
-- scheduled reconciler can resume any step idempotently.
--
-- `orders.status` stays the only source of truth for whether an order is cancelled; `phase` is the
-- saga's progress. One row per order (`orderId` unique): an order is cancelled at most once, and a
-- dispatch rejection is irreversible. `(phase, nextAttemptAt)` serves the reconciler's pending scan;
-- `attentionRequiredAt` serves the operator view of permanent failures.
--
-- Purely additive (ADR-003): a new enum and a new table; no existing row or column changes.

-- CreateEnum
CREATE TYPE "OrderCancellationPhase" AS ENUM ('REQUESTED', 'STOCK_RELEASED', 'ORDER_CANCELLED', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "order_cancellation_requests" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "phase" "OrderCancellationPhase" NOT NULL DEFAULT 'REQUESTED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "attentionRequiredAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "order_cancellation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_cancellation_requests_orderId_key" ON "order_cancellation_requests"("orderId");
CREATE INDEX "order_cancellation_requests_phase_nextAttemptAt_idx" ON "order_cancellation_requests"("phase", "nextAttemptAt");
CREATE INDEX "order_cancellation_requests_attentionRequiredAt_idx" ON "order_cancellation_requests"("attentionRequiredAt");

-- AddForeignKey
ALTER TABLE "order_cancellation_requests" ADD CONSTRAINT "order_cancellation_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
