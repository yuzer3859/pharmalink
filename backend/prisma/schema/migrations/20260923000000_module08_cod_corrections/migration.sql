-- Module 08 — COD corrections and disputes (§3.5 F-COD-01, the design's Open Question 5).
--
-- The COD collection and remittance works made three tables append-only on purpose:
-- `cod_collections` holds a driver's declaration about a customer's money, `cod_remittances` an
-- operator's confirmation that it arrived, `cod_reconciliations` an operator's finding about the
-- two. None has an update path anywhere in the module, because evidence that can be edited is not
-- evidence.
--
-- That guarantee is only worth keeping if there is somewhere to put a genuine mistake. These two
-- tables are that somewhere, and **this migration adds no column to any of the three** — the
-- historical rows are untouched by it and by everything built on it.

-- ---------------------------------------------------------------------------------------------
-- 1. The two vocabularies.
--
-- `CodCorrectionType` names four *mistakes in the record* and deliberately nothing else. There is
-- no WRITE_OFF, RECOVERY, WAIVER or PENALTY, because each would answer the question nobody has
-- answered — who absorbs a shortfall — and would answer it from inside a delivery module.
--
-- `CodDisputeStatus` has two values for the same reason the resolution below is free text rather
-- than an enum: RECOVERED / WRITTEN_OFF / DRIVER_LIABLE are the values a richer lifecycle would
-- want, and every one of them is a commercial decision that has not been taken.
-- ---------------------------------------------------------------------------------------------
CREATE TYPE "CodCorrectionType" AS ENUM ('RECORDING_MISTAKE', 'REFERENCE_CORRECTION', 'RECONCILIATION_MISTAKE', 'ADMINISTRATIVE_ADJUSTMENT');
CREATE TYPE "CodDisputeStatus" AS ENUM ('OPEN', 'RESOLVED');

-- ---------------------------------------------------------------------------------------------
-- 2. `cod_corrections` — a compensating record, the shape `refunds` already takes against a
--    payment that cannot be un-charged.
--
-- Two typed value pairs rather than one stringly-typed one: money stays an integer (ADR-005) and a
-- reference stays text. A correction fills the pair its type calls for and leaves the other null.
-- Storing an amount as text so a single column could serve both would put money through a parser on
-- every read.
--
-- `reason` is NOT NULL. A correction without a stated reason is an unexplained change to the
-- financial record, which is the thing this table exists to prevent rather than to enable.
--
-- `createdByUserId` is a Module 01 user id — the operator. Never a `driver_profiles.id`: the
-- permission that reaches this table is `finance:settlement:any`, which no driver role holds.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "cod_corrections" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "remittanceId" TEXT,
    "reconciliationId" TEXT,
    "type" "CodCorrectionType" NOT NULL,
    "originalAmount" INTEGER,
    "correctedAmount" INTEGER,
    "originalReference" TEXT,
    "correctedReference" TEXT,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_corrections_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------------------------
-- 3. `cod_disputes` — the follow-up the reconciliation work had nowhere to record.
--
-- `CodReconciliation` can find a DISCREPANCY, which is something somebody has to act on, and until
-- now there was no record of anybody acting. Two states, two actors, a reason and a note: no queue,
-- no assignee, no SLA, no escalation, no message thread, no attachment.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "cod_disputes" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CodDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "openedByUserId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,

    CONSTRAINT "cod_disputes_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------------------------
-- 4. Idempotency: one key, one correction.
--
-- Corrections have no natural key — two different corrections of the same type against the same
-- collection are both legitimate — so identity is caller-supplied, exactly as `orders` and
-- `payments` do it. This index is what makes a double-submitted form, a retried request whose
-- response was lost, and two API nodes racing all converge on one row rather than on three
-- contradictory statements about the same mistake.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX "cod_corrections_idempotencyKey_key" ON "cod_corrections"("idempotencyKey");

-- ---------------------------------------------------------------------------------------------
-- 5. One *open* dispute per collection.
--
-- Partial, and the partiality is the point: two operators noticing the same shortfall converge on
-- one dispute instead of stacking two, while a collection that is legitimately queried again months
-- after an earlier dispute was resolved can still be. A plain unique index on `collectionId` would
-- forbid the second, honest dispute; no index at all would let a busy afternoon produce five
-- duplicates of the first.
--
-- Prisma's schema language cannot express a partial unique index, so this is raw SQL and the model
-- carries a doc comment pointing here — the same position `job_offers_one_live_per_job` takes, and
-- for the same reason: `prisma migrate deploy` runs hand-written migrations in this repository, and
-- the index is real regardless of whether the schema file can describe it.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX "cod_disputes_one_open_per_collection"
    ON "cod_disputes"("collectionId")
    WHERE "status" = 'OPEN';

-- ---------------------------------------------------------------------------------------------
-- 6. The operational reads.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "cod_corrections_collectionId_createdAt_idx" ON "cod_corrections"("collectionId", "createdAt");
CREATE INDEX "cod_corrections_type_createdAt_idx" ON "cod_corrections"("type", "createdAt");
CREATE INDEX "cod_disputes_collectionId_openedAt_idx" ON "cod_disputes"("collectionId", "openedAt");
CREATE INDEX "cod_disputes_status_openedAt_idx" ON "cod_disputes"("status", "openedAt");

-- ---------------------------------------------------------------------------------------------
-- 7. Foreign keys, all to Module 08's own tables.
--
-- `RESTRICT` throughout: a collection that has been corrected or disputed must not be deletable at
-- all, and a database that would quietly take the correction trail with it is not the backstop an
-- append-only financial record needs.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "cod_corrections" ADD CONSTRAINT "cod_corrections_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "cod_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cod_corrections" ADD CONSTRAINT "cod_corrections_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "cod_remittances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cod_corrections" ADD CONSTRAINT "cod_corrections_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "cod_reconciliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cod_disputes" ADD CONSTRAINT "cod_disputes_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "cod_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
