-- Module 08 — COD collection recording (§3.5 F-COD-01, §8's `cod_collections`, BR-DEL-10).
--
-- `cod_collections` has existed since the Phase-0 schema and has never been written to: no code
-- path constructed a row, the `/deliver` route refused the `codCollected` field outright ("COD
-- reconciliation is a later work and has no store to record it in"), and neither enum below
-- existed. The table is therefore empty in every environment, and this migration reshapes it
-- rather than migrating data into it.
--
-- It is still written defensively — new NOT NULL columns land with a default and only then lose it
-- — so that it would behave correctly against a database somebody had populated by hand.

-- 1. The two vocabularies.
--
-- `CodCollectionMethod` deliberately names no provider: `ELECTRONIC` covers Telebirr, a bank
-- transfer and whatever rail comes next, because which one carried the money is a reconciliation
-- detail owned by the module that talks to providers. A `TELEBIRR` value here would make every new
-- rail a migration in the wrong module.
CREATE TYPE "CodCollectionMethod" AS ENUM ('CASH', 'ELECTRONIC');

-- `CodCollectionStatus` replaces the Phase-0 `reconciled` boolean, and the replacement is the
-- substantive change in this migration. A boolean can express "the driver said they took the
-- money" and "PharmaLink has verified it" only as the same value, which collapses three distinct
-- assertions by three distinct parties into one bit — and the bit would inevitably come to mean
-- "paid", which none of them do. The pharmacy being paid is a Module 07 settlement fact and
-- appears nowhere in this table.
CREATE TYPE "CodCollectionStatus" AS ENUM ('COLLECTED', 'REMITTED', 'RECONCILED');

-- 2. Module 06 references, as scalars (ADR-002) — never a Prisma relation across contexts.
--
-- Frozen at recording so a reconciliation can answer "which order is this cash for?" without
-- Module 07 joining into Module 08's tables. Added with a placeholder default so the statement is
-- safe against a pre-populated table, then stripped: every genuine recording resolves both from
-- the delivery job.
ALTER TABLE "cod_collections" ADD COLUMN "orderId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "cod_collections" ADD COLUMN "fulfillmentId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "cod_collections" ALTER COLUMN "orderId" DROP DEFAULT;
ALTER TABLE "cod_collections" ALTER COLUMN "fulfillmentId" DROP DEFAULT;

-- 3. Expected against collected — two columns, because they are two different facts.
--
-- The Phase-0 table had a single `amount`, which cannot express the one thing a COD reconciliation
-- exists to find: a driver who handed over less than the order was worth. `expectedAmount` is
-- copied from `delivery_jobs.codAmount` (itself frozen from `Order.grandTotal` at job creation);
-- `collectedAmount` is the driver's declaration. `amount` is renamed rather than dropped and
-- re-added so that a hand-populated row keeps its value as the collected figure, which is what it
-- meant.
ALTER TABLE "cod_collections" RENAME COLUMN "amount" TO "collectedAmount";
ALTER TABLE "cod_collections" ADD COLUMN "expectedAmount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "cod_collections" ALTER COLUMN "expectedAmount" DROP DEFAULT;

-- There is deliberately **no** `hasDiscrepancy` column. It is exactly
-- `collectedAmount <> expectedAmount`, and a stored copy of a derived fact is a copy that can
-- disagree with the two numbers it was derived from.

ALTER TABLE "cod_collections" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'ETB';

-- 4. How the money moved, and the one generic reference that helps reconcile it.
--
-- `providerReference` is an opaque string a human can quote — a transaction number — and nothing
-- more. No provider name, no callback body, no signature, no account or card number, no raw
-- provider response (§9, §12, §19). Nullable because cash has no reference to quote.
ALTER TABLE "cod_collections" ADD COLUMN "method" "CodCollectionMethod" NOT NULL DEFAULT 'CASH';
ALTER TABLE "cod_collections" ALTER COLUMN "method" DROP DEFAULT;
ALTER TABLE "cod_collections" ADD COLUMN "providerReference" TEXT;

-- 5. The lifecycle column, replacing the boolean.
--
-- Defaulted to `COLLECTED` because that is the only status this module writes: a row exists
-- because a driver declared a collection, and nothing about it has been verified yet.
ALTER TABLE "cod_collections" ADD COLUMN "status" "CodCollectionStatus" NOT NULL DEFAULT 'COLLECTED';
ALTER TABLE "cod_collections" DROP COLUMN "reconciled";
ALTER TABLE "cod_collections" ADD COLUMN "remittedAt" TIMESTAMP(3);

-- 6. When the money changed hands, and when the platform heard about it.
--
-- Two timestamps because a handset that queues a submission offline records it minutes later, and
-- a reconciliation that cannot separate the two cannot explain the gap.
ALTER TABLE "cod_collections" ADD COLUMN "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 7. The two questions an operator asks: what is this driver holding, and what is outstanding?
CREATE INDEX "cod_collections_driverId_status_idx" ON "cod_collections"("driverId", "status");
CREATE INDEX "cod_collections_status_collectedAt_idx" ON "cod_collections"("status", "collectedAt");
