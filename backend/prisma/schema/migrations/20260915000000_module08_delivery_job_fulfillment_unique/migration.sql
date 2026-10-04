-- Module 08 — one delivery job per fulfillment
-- (architecture/module-08-delivery-tracking.md §5.3's "job per fulfillment" rationale, F-JOB-01).
--
-- The Phase-0 init migration created `delivery_jobs.fulfillmentId` as a plain column. It is the
-- job's natural key: because an order can split across pharmacies, one pickup location is one job
-- is one driver route, so a fulfillment has exactly one job for its whole life.
--
-- This index is what makes job creation idempotent rather than merely usually-idempotent. The
-- creating command checks for an existing job first, but that read can be raced by a redelivered
-- `order.ready` event or a concurrent retry, and losing that race would put two drivers on the
-- road to the same pharmacy for the same medicines. The database decides; the application resolves
-- the conflict by returning the winner.
--
-- Nothing writes `delivery_jobs` before this migration, so it runs against an empty table.

CREATE UNIQUE INDEX "delivery_jobs_fulfillmentId_key" ON "delivery_jobs"("fulfillmentId");

-- ---------------------------------------------------------------------------------------------
-- The item manifest (§3.2 F-JOB-02's "items summary"), which the Phase-0 table had no column for.
--
-- A snapshot read whole at handover and never queried or joined, so it is a Json column rather
-- than a child table: a table of delivery line items would invite a join back to `order_lines`,
-- which is the cross-context coupling ADR-002 forbids. It carries product id, name and quantity —
-- deliberately no price, no prescription reference and no health information, because delivery is
-- the least privileged context this data passes through.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "delivery_jobs" ADD COLUMN "items" JSONB;

-- ---------------------------------------------------------------------------------------------
-- The address snapshots are one legible line each, not a structured object.
--
-- Phase 0 typed them `JSONB` by symmetry with `orders.addressSnapshot`, but nothing reads a part
-- of a delivery address: it is shown to a driver and nothing else. A JSON column with no shape
-- invites a reader to start depending on one. `USING` converts any legacy value rather than
-- assuming emptiness, though nothing writes `delivery_jobs` before this migration.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "delivery_jobs"
    ALTER COLUMN "pickupAddress" TYPE TEXT USING (
        CASE WHEN "pickupAddress" IS NULL THEN NULL ELSE trim(both '"' from "pickupAddress"::text) END
    );

ALTER TABLE "delivery_jobs"
    ALTER COLUMN "dropoffAddress" TYPE TEXT USING (
        CASE WHEN "dropoffAddress" IS NULL THEN NULL ELSE trim(both '"' from "dropoffAddress"::text) END
    );
