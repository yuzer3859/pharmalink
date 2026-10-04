-- Module 08 — COD remittance and reconciliation (§3.5 F-COD-01, §9.5's
-- `/admin/delivery/cod-reconciliation`, the design's Open Question 5).
--
-- The COD work before this one could record only the first leg of the money's journey: a driver's
-- own declaration that a customer handed something over. `cod_collections.status` already named
-- `REMITTED` and `RECONCILED`, and `remittedAt`/`reconciledAt` already existed, but nothing wrote
-- them — deliberately, because the two later legs are assertions by PharmaLink about money
-- reaching and being verified by PharmaLink, and the only actor with a route near the aggregate
-- was the driver holding the cash.
--
-- This migration adds the two tables those assertions live in. It adds **no column** to
-- `cod_collections`: every fact that table already carries stays exactly where it was, and the
-- driver's declaration remains untouched by anything that happens later.

-- 1. The reconciliation's two honest answers.
--
-- Not a boolean, for the reason `CodCollectionStatus` is not one: "reconciled" and "reconciled,
-- and the amounts did not match" are different findings, and collapsing them would lose the only
-- finding anybody needs to act on. There is no `PARTIAL`, no `DISPUTED` and no `WRITTEN_OFF` —
-- each would encode a decision about who absorbs a shortfall, and nobody has taken it.
CREATE TYPE "CodReconciliationOutcome" AS ENUM ('ACCEPTED', 'DISCREPANCY');

-- 2. `cod_remittances` — the driver/channel handing the money to PharmaLink.
--
-- `remittedAmount` is its own column rather than an assumed copy of
-- `cod_collections.collectedAmount`: the gap between what a driver said they took and what they
-- actually handed over is the single thing a remittance check exists to find, so the two numbers
-- live on two immutable rows and neither is derived from the other.
--
-- `reference` is a **generic PharmaLink-side handle** — a deposit slip, a cash-office batch label.
-- Not `bankReference`, not `telebirrReference`: naming a rail here would put a provider into a
-- delivery table and make every new rail a migration in the wrong module.
--
-- `confirmedByUserId` is the separation of duties made durable. The driver who collected is named
-- on the collection row; whoever accepted the cash is named here, and the two can never be the
-- same authority — recording a collection needs `delivery:update:own`, confirming a remittance
-- needs `finance:settlement:any`, and no role in the catalogue holds both.
CREATE TABLE "cod_remittances" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "remittedAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ETB',
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "confirmedByUserId" TEXT NOT NULL,
    "remittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_remittances_pkey" PRIMARY KEY ("id")
);

-- 3. `cod_reconciliations` — PharmaLink checking that remittance against the collection.
--
-- The amounts are deliberately **not** repeated here. Expected, collected and remitted already sit
-- on two append-only rows this one points at, so a copy could only ever be a second answer to a
-- question that already has one. `outcome` is the exception, and is stored for the reason
-- `driver_earnings.total` is: it is the platform's recorded determination at a moment in time, and
-- "what still needs following up?" has to be an indexed scan rather than arithmetic over a join.
CREATE TABLE "cod_reconciliations" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "outcome" "CodReconciliationOutcome" NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "reconciledByUserId" TEXT NOT NULL,
    "reconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_reconciliations_pkey" PRIMARY KEY ("id")
);

-- 4. One remittance and one reconciliation per collection.
--
-- These two unique indexes are the whole of the idempotency story, and they are the reason it
-- survives two finance officers clicking at once on two API nodes — which no amount of
-- application-level deduplication can settle. A repeat converges on the committed row; it does not
-- create a second obligation, a second audit entry or a second event.
CREATE UNIQUE INDEX "cod_remittances_collectionId_key" ON "cod_remittances"("collectionId");
CREATE UNIQUE INDEX "cod_reconciliations_collectionId_key" ON "cod_reconciliations"("collectionId");

-- 5. §19's grouping, without a batch engine.
--
-- A real handover is one driver remitting a day's collections under one reference, so
-- reconstructing a batch is a lookup on `reference` rather than a table nobody has specified the
-- cadence for. `remittedAt` and `(outcome, reconciledAt)` answer the other two questions finance
-- actually asks: what came in over this period, and what is still outstanding.
CREATE INDEX "cod_remittances_reference_idx" ON "cod_remittances"("reference");
CREATE INDEX "cod_remittances_remittedAt_idx" ON "cod_remittances"("remittedAt");
CREATE INDEX "cod_reconciliations_outcome_reconciledAt_idx" ON "cod_reconciliations"("outcome", "reconciledAt");

-- 6. Both tables belong to Module 08 and reference only Module 08's own, so these are real foreign
-- keys. `RESTRICT` rather than `CASCADE`: a collection that has been remitted or reconciled must
-- not be deletable at all, and a database that would quietly take its evidence with it is not the
-- backstop an append-only financial record needs.
ALTER TABLE "cod_remittances" ADD CONSTRAINT "cod_remittances_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "cod_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cod_reconciliations" ADD CONSTRAINT "cod_reconciliations_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "cod_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
