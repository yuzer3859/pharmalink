-- Module 01 / 16 — support impersonation (Work 85; module-16 F-AD-08, backend/docs/impersonation.md).
--
-- Additive (ADR-003): one enum value on `ApprovalEntityType`, one new enum, one new table and its
-- indexes. No existing row changes.

ALTER TYPE "ApprovalEntityType" ADD VALUE IF NOT EXISTS 'IMPERSONATION';

CREATE TYPE "ImpersonationStatus" AS ENUM ('AUTHORIZED', 'ACTIVE', 'ENDED', 'EXPIRED');

CREATE TABLE "impersonation_sessions" (
    "id" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ImpersonationStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "redeemBy" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "impersonation_sessions_approvalId_key" ON "impersonation_sessions"("approvalId");
CREATE INDEX "impersonation_sessions_requestedByUserId_createdAt_idx" ON "impersonation_sessions"("requestedByUserId", "createdAt");
CREATE INDEX "impersonation_sessions_targetUserId_createdAt_idx" ON "impersonation_sessions"("targetUserId", "createdAt");
