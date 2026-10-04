-- Module 08 — the Delivery-owned operational driver profile
-- (architecture/module-08-delivery-tracking.md §3.1 F-DRV-01..04, §5.1, §8's `driver_profiles`).
--
-- The Phase-0 table was a placeholder written before the approved design. It is reshaped here to
-- hold what dispatch and tracking actually need, and to stop holding what belongs to Module 01.
--
-- Nothing writes `driver_profiles` before this migration — no module has ever created a row — so
-- every statement below runs against an empty table and no data is at risk. The drops are
-- nonetheless written with IF EXISTS so a re-run is harmless.

-- ---------------------------------------------------------------------------------------------
-- 1. `isVerified` is dropped: Module 01 owns verification, and a copy of it here is a hazard.
--
-- §8 described the column as a "mirror of Module 1". A mirror of an authorization fact is not a
-- performance optimisation — it is a second, lagging answer to a safety question. If a driver's
-- DRIVER_DOCS approval is revoked or expires in Module 01 and this flag is not updated in the
-- same instant, Module 08 keeps handing that driver medicines to carry. The failure is silent,
-- and it fails *open*.
--
-- ADR-002 already prescribes the alternative and this module already uses it three times over:
-- an own-copy outbound port reading the owning module's tables. `IIdentityPort.getDriverIdentity`
-- reads `users` + `verification_requests` live, so the answer cannot be stale by construction.
-- There is no cached projection anywhere in the repository that this would be following; the one
-- thing that looks like one (`search` projections, ADR-011) is a read-model for ranking, never an
-- authorization input.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "driver_profiles" DROP COLUMN IF EXISTS "isVerified";

-- ---------------------------------------------------------------------------------------------
-- 2. `activeJobCount` is dropped: the count is derived from `delivery_jobs`, never stored.
--
-- §8 called it a "derived cache guarded by the concurrent-limit check at accept time", but a
-- mutable counter that guards a limit has to be incremented and decremented on every one of the
-- twelve job transitions, and a single missed decrement pins a driver at their limit forever
-- while a single missed increment lets them exceed it. `00-shared-conventions.md` §9 and ADR-006
-- state the project's position on exactly this shape: balances are *derived*, "never authoritative
-- mutable counters".
--
-- `IDeliveryJobRepository.countActiveJobs` counts the rows instead — an indexed count over one
-- driver's open jobs, which is a handful of rows, and which cannot drift from the jobs it counts.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "driver_profiles" DROP COLUMN IF EXISTS "activeJobCount";

-- ---------------------------------------------------------------------------------------------
-- 3. `maxConcurrent` becomes a nullable override (BRULE-28, F-DRV-04's "configurable").
--
-- Phase 0 declared it `INTEGER NOT NULL DEFAULT 1`, which meant every profile carried a literal
-- limit of 1 the moment it was created and the platform-wide `delivery.maxConcurrentJobs` setting
-- could never apply to anyone. Raising the limit would have been an UPDATE over every driver.
--
-- `NULL` now means "no per-driver override — use the platform limit". A number means this one
-- driver differs, which is what a per-driver limit is for.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "driver_profiles" ALTER COLUMN "maxConcurrent" DROP DEFAULT;
ALTER TABLE "driver_profiles" ALTER COLUMN "maxConcurrent" DROP NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. Shift status (§3.1 F-DRV-02), as one timestamp.
--
-- A driver is on shift exactly while `shiftStartedAt` is non-null. A boolean *plus* a timestamp
-- would allow "on shift, started never" and "off shift, started at 09:00" to be written; one
-- column makes both unrepresentable rather than merely invalid.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "driver_profiles" ADD COLUMN "shiftStartedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------------------------
-- 5. Last-known location (§5.1's `DriverLocation`, §3.1 F-DRV-03).
--
-- Current state, overwritten in place — not history. §8 already gives the sampled trail its own
-- table (`location_snapshots`), and §7 puts the live feed in Redis; this is the durable
-- last-known point that survives a restart and that dispatch reads to find nearby drivers.
--
-- `lastLocationAt` is not decoration. NFR-LOC-04 requires the driver app to tolerate intermittent
-- connectivity by buffering, which means points arrive out of order; without a recorded time
-- there is no way to tell a replayed five-minute-old fix from a fresh one, and the driver would
-- jump backwards on the customer's map.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "driver_profiles" ADD COLUMN "lastLat" DOUBLE PRECISION;
ALTER TABLE "driver_profiles" ADD COLUMN "lastLng" DOUBLE PRECISION;
ALTER TABLE "driver_profiles" ADD COLUMN "lastLocationAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------------------------
-- 6. The concurrent-limit count needs an index it can use.
--
-- `countActiveJobs` filters `delivery_jobs` by `assignedDriverId` and status. Phase 0 indexed
-- only `orderId`, so the count would have been a sequential scan of every delivery ever made —
-- on the path of every future accept (§11.2). Composite rather than two indexes because the query
-- always supplies both columns together.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX "delivery_jobs_assignedDriverId_status_idx"
    ON "delivery_jobs"("assignedDriverId", "status");
