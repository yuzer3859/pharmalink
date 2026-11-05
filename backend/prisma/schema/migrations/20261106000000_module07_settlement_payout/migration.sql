-- Module 07 — settlement approval and payout execution (Work 83; module-07 §15, ADR-022..026,
-- backend/docs/settlement-payout.md).
--
-- Additive (ADR-003): one enum value, two nullable columns on `settlements`, three new enums, two
-- new tables and their indexes. No existing row changes.

ALTER TYPE "SettlementStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

ALTER TABLE "settlements"
  ADD COLUMN "approvedByUserId" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3);

CREATE TYPE "PayoutRail" AS ENUM ('BANK_TRANSFER', 'TELEBIRR');
CREATE TYPE "PayoutBeneficiaryStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'SUPERSEDED', 'REVOKED');
CREATE TYPE "PayoutAttemptStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'UNKNOWN');

CREATE TABLE "payout_beneficiaries" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "rail" "PayoutRail" NOT NULL,
    "accountName" TEXT NOT NULL,
    "bankCode" TEXT,
    "accountIdentifierEncrypted" TEXT NOT NULL,
    "accountIdentifierLast4" TEXT NOT NULL,
    "status" "PayoutBeneficiaryStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "createdByUserId" TEXT NOT NULL,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "payableFrom" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payout_beneficiaries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payout_beneficiaries_pharmacyId_status_idx" ON "payout_beneficiaries"("pharmacyId", "status");
-- At most one verified and one pending beneficiary per pharmacy.
CREATE UNIQUE INDEX "payout_beneficiaries_one_verified_per_pharmacy"
  ON "payout_beneficiaries"("pharmacyId") WHERE "status" = 'VERIFIED';
CREATE UNIQUE INDEX "payout_beneficiaries_one_pending_per_pharmacy"
  ON "payout_beneficiaries"("pharmacyId") WHERE "status" = 'PENDING_VERIFICATION';

CREATE TABLE "payout_attempts" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "beneficiaryId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PayoutAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "failureReason" TEXT,
    "initiatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "payout_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payout_attempts_idempotencyKey_key" ON "payout_attempts"("idempotencyKey");
CREATE UNIQUE INDEX "payout_attempts_reference_key" ON "payout_attempts"("reference");
CREATE INDEX "payout_attempts_settlementId_createdAt_idx" ON "payout_attempts"("settlementId", "createdAt");
-- At most one open attempt per settlement: a second payout cannot start while one is unresolved.
CREATE UNIQUE INDEX "payout_attempts_one_open_per_settlement"
  ON "payout_attempts"("settlementId") WHERE "status" IN ('PENDING', 'UNKNOWN');

ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_beneficiaryId_fkey"
  FOREIGN KEY ("beneficiaryId") REFERENCES "payout_beneficiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
