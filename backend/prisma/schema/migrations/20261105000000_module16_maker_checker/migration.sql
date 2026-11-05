-- Module 16 — Admin: maker-checker (Work 82, NFR-SEC-06, backend/docs/maker-checker.md).
--
-- Extends the Phase 0 `approval_requests` table, which no code has ever written (it was scaffolded
-- with the schema and left unused until this work), so the NOT NULL columns below have no row to
-- fill. To check before applying:
--
--   SELECT COUNT(*) FROM "approval_requests";   -- expected 0
--
-- Additive (ADR-003): one enum value, new columns, three indexes. No existing column changes.

ALTER TYPE "ApprovalStatus" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TABLE "approval_requests"
  ADD COLUMN "actionType" TEXT NOT NULL,
  ADD COLUMN "requiredPermission" TEXT NOT NULL,
  ADD COLUMN "makerIdempotencyKey" TEXT NOT NULL,
  ADD COLUMN "summary" TEXT NOT NULL,
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "executedAt" TIMESTAMP(3),
  ADD COLUMN "executionResult" JSONB,
  ADD COLUMN "executionError" JSONB,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- A maker's retry with the same key finds the request it already made.
CREATE UNIQUE INDEX "approval_requests_requestedByUserId_actionType_makerIdempotencyKey_key"
  ON "approval_requests"("requestedByUserId", "actionType", "makerIdempotencyKey");

-- The expiry sweeper's scan.
CREATE INDEX "approval_requests_status_expiresAt_idx" ON "approval_requests"("status", "expiresAt");

-- At most one open request per action and target: two makers cannot queue the same payout.
-- Not expressible in the Prisma schema (partial index); kept here only.
CREATE UNIQUE INDEX "approval_requests_one_pending_per_target"
  ON "approval_requests"("actionType", "entityId")
  WHERE "status" = 'PENDING';
