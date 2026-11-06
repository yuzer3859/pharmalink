-- Module 16 — reporting (Work 90; module-16 §9.5 `/admin/finance/reports`, F-AD-23/24,
-- backend/docs/reports.md).
--
-- Additive (ADR-003): two new enums and one new table. No existing row changes.

CREATE TYPE "ReportType" AS ENUM ('PAYMENTS', 'REFUNDS', 'ORDERS', 'AUDIT', 'ANALYTICS_DAILY');
CREATE TYPE "ReportStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "report_jobs" (
    "id" TEXT NOT NULL,
    "type" "ReportType" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'QUEUED',
    "params" JSONB NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "rowCount" INTEGER,
    "bytes" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "storageRef" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    CONSTRAINT "report_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_jobs_requestedByUserId_idempotencyKey_key" ON "report_jobs"("requestedByUserId", "idempotencyKey");
CREATE INDEX "report_jobs_status_createdAt_idx" ON "report_jobs"("status", "createdAt");
CREATE INDEX "report_jobs_requestedByUserId_createdAt_idx" ON "report_jobs"("requestedByUserId", "createdAt");
