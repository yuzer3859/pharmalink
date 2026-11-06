-- Module 16 — general disputes (Work 86; module-16 §7, §9.6, §11.4, BRULE-50, backend/docs/disputes.md).
--
-- Additive (ADR-003): three new enums, two new tables and their indexes. No existing row changes.

CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLUTION_PENDING', 'RESOLVED', 'CLOSED');
CREATE TYPE "DisputeType" AS ENUM ('ORDER', 'DELIVERY', 'PAYMENT', 'CONTENT');
CREATE TYPE "DisputePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

CREATE TABLE "dispute_cases" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "type" "DisputeType" NOT NULL,
    "transactionType" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "complainantUserId" TEXT NOT NULL,
    "openedByUserId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "DisputePriority" NOT NULL DEFAULT 'NORMAL',
    "assignedAdminId" TEXT,
    "resolution" JSONB,
    "pendingApprovalId" TEXT,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispute_cases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dispute_cases_caseNumber_key" ON "dispute_cases"("caseNumber");
CREATE INDEX "dispute_cases_status_slaDueAt_idx" ON "dispute_cases"("status", "slaDueAt");
CREATE INDEX "dispute_cases_complainantUserId_openedAt_idx" ON "dispute_cases"("complainantUserId", "openedAt");
CREATE INDEX "dispute_cases_transactionType_transactionId_idx" ON "dispute_cases"("transactionType", "transactionId");
-- One open case per order and topic: a second complaint about the same thing joins the first.
CREATE UNIQUE INDEX "dispute_cases_one_open_per_transaction_type"
  ON "dispute_cases"("transactionType", "transactionId", "type")
  WHERE "status" NOT IN ('RESOLVED', 'CLOSED');

CREATE TABLE "dispute_messages" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderRole" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispute_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dispute_messages_caseId_createdAt_idx" ON "dispute_messages"("caseId", "createdAt");
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "dispute_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
