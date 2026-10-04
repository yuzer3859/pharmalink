-- Module 08 — dispatch, job offers, accept/decline and reassignment
-- (architecture/module-08-delivery-tracking.md §3.2 F-JOB-03..05, §6, §11.2, §11.5).
--
-- The Phase-0 `job_offers` table has the right columns and no constraints at all. This migration
-- adds the ones the dispatch workflow's correctness actually rests on, plus the reason column the
-- design's §13 audit requirement needs. Nothing writes `job_offers` before this migration, so
-- every statement runs against an empty table.

-- ---------------------------------------------------------------------------------------------
-- 1. Why an offer ended.
--
-- §13's must-log list includes "offered (to whom)" and reassignment reasons. A decline without a
-- reason is a dead end for anyone asking why a job took 40 minutes to place; an expiry without one
-- is indistinguishable from a decline once `respondedAt` is set.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "job_offers" ADD COLUMN "reason" TEXT;

-- ---------------------------------------------------------------------------------------------
-- 2. One offer per job per dispatch round.
--
-- `round` is the dispatch attempt number. Making it unique per job turns a retried dispatch — an
-- at-least-once `delivery.job.created` redelivery (ADR-010), a `Serializable` retry, an operator
-- clicking twice — into a convergent operation rather than a growing pile of offers to the same
-- driver. It is the same deterministic-natural-key discipline `delivery_jobs.fulfillmentId` uses
-- for job creation.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX "job_offers_jobId_round_key" ON "job_offers"("jobId", "round");

-- ---------------------------------------------------------------------------------------------
-- 3. **At most one live offer per job** — the constraint the whole dispatch design rests on.
--
-- §6's rationale is explicit that dispatch is sequential rather than a broadcast: "sequential
-- offer-with-TTL (vs broadcast-to-all) prevents race conditions on acceptance and respects
-- concurrent limits". Sequential offering is only a race-free design if "sequential" is enforced.
-- Two live offers for one job means two drivers can each be told the job is theirs to take, and
-- one of them then arrives at a pharmacy to collect medicines somebody else already has.
--
-- A partial unique index is the right instrument: the uniqueness applies only while an offer is
-- live, so the same job can accumulate any number of DECLINED, EXPIRED and ACCEPTED offers over
-- its dispatch history — which is exactly what makes reassignment (§11.5) possible, since the
-- previous driver's ACCEPTED offer must survive alongside the new live one rather than being
-- erased.
--
-- Prisma's schema language cannot express a partial unique index, so this is raw SQL and the
-- model carries a doc comment pointing here. That is not a workaround: `prisma migrate deploy`
-- runs hand-written migrations in this repository, and the index is real regardless of whether
-- the schema file can describe it.
--
-- Deliberately **not** extended to ACCEPTED. A unique index over `('OFFERED','ACCEPTED')` would
-- read as "one assignment per job" and would be wrong: after a reassignment the previous driver's
-- ACCEPTED offer and the new driver's eventual one both exist, and both are true records of what
-- happened. Single assignment is guaranteed where it belongs — by the compare-and-set on
-- `delivery_jobs.status`, which only one accept can win.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX "job_offers_one_live_per_job"
    ON "job_offers"("jobId")
    WHERE "status" = 'OFFERED';

-- ---------------------------------------------------------------------------------------------
-- 4. A driver's own offers, by status.
--
-- The accept and decline paths both resolve "this driver's live offer" before doing anything
-- else, and §9.1's `GET /driver/jobs` will read the same shape.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "job_offers_driverId_status_idx" ON "job_offers"("driverId", "status");

-- ---------------------------------------------------------------------------------------------
-- 5. The expiry lookup.
--
-- Live offers past their TTL, which is how the dispatcher retires an offer nobody answered and
-- how a later sweeper will find them without scanning every offer ever made.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "job_offers_status_expiresAt_idx" ON "job_offers"("status", "expiresAt");

-- ---------------------------------------------------------------------------------------------
-- 6. The candidate query's index.
--
-- Dispatch begins by finding drivers who are ONLINE and on shift. That runs once per job and once
-- per re-offer, so it is on the critical path of every delivery the platform makes; without an
-- index it is a sequential scan of every driver who has ever registered.
--
-- `availability` alone rather than a composite with `shiftStartedAt`: the invariant enforced by
-- `DriverAvailabilityPolicy.isConsistent` means ONLINE already implies an open shift, so the
-- second predicate is a re-assertion that eliminates almost nothing. It is still applied in the
-- query, as a check against a row that has drifted.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "driver_profiles_availability_idx" ON "driver_profiles"("availability");
