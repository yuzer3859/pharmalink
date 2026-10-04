-- Module 08 — Delivery Management & Tracking: the delivery-job state machine
-- (architecture/module-08-delivery-tracking.md §3.3 F-STS-01, §5.3, §6, §11.5).
--
-- The Phase-0 init migration created `delivery_jobs` and its `DeliveryJobStatus` enum as a
-- placeholder, before the Module 08 design was approved. The placeholder's values are not the
-- approved lifecycle:
--
--   placeholder : CREATED OFFERED ASSIGNED ACCEPTED EN_ROUTE_PICKUP PICKED_UP
--                 EN_ROUTE_DROPOFF DELIVERED FAILED CANCELLED
--   F-STS-01    : CREATED OFFERED ASSIGNED ARRIVED_PICKUP PICKED_UP EN_ROUTE
--                 ARRIVED_DROPOFF DELIVERED COMPLETED, branches CANCELLED REASSIGNING FAILED
--
-- Three approved states had no representation at all (`ARRIVED_PICKUP`, `ARRIVED_DROPOFF`,
-- `COMPLETED`, `REASSIGNING`), so the domain state machine could not be persisted without this.
-- This is the same situation, and the same remedy, as Module 07's `PaymentStatus`
-- (`20260908000000_module07_payment_ledger_foundation` §1): replace the placeholder with the
-- approved states and map any hypothetical legacy row rather than assuming emptiness.
--
-- Nothing in Modules 01–07 writes `delivery_jobs` — Module 06's `Fulfillment` stops at `READY`
-- and its `DISPATCHED`/`DELIVERED` values are explicitly unreachable (`FulfillmentStatusPolicy`
-- gives them an empty transition set) — so every statement below runs against an empty table.
-- The mapping is written anyway, because a USING clause that assumes emptiness is a migration
-- that fails in exactly the situation it was meant to handle.
--
-- Mapping rationale:
--   ACCEPTED         -> ASSIGNED   the approved lifecycle has one post-acceptance state; the
--                                  offer's own ACCEPTED lives on `job_offers.status`, which is
--                                  untouched.
--   EN_ROUTE_PICKUP  -> ASSIGNED   "driving to the pharmacy" is the assigned state; arrival is
--                                  its own event (`ARRIVED_PICKUP`).
--   EN_ROUTE_DROPOFF -> EN_ROUTE   renamed only; the approved name drops the leg suffix because
--                                  `ARRIVED_DROPOFF` now marks the end of that leg.
--
-- Only the enum changes. No table, column, index or constraint on `delivery_jobs` or any other
-- Module 08 table is altered by this migration.

ALTER TABLE "delivery_jobs" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE "DeliveryJobStatus" RENAME TO "DeliveryJobStatus_old";

CREATE TYPE "DeliveryJobStatus" AS ENUM (
    'CREATED',
    'OFFERED',
    'ASSIGNED',
    'ARRIVED_PICKUP',
    'PICKED_UP',
    'EN_ROUTE',
    'ARRIVED_DROPOFF',
    'DELIVERED',
    'COMPLETED',
    'REASSIGNING',
    'CANCELLED',
    'FAILED'
);

ALTER TABLE "delivery_jobs"
    ALTER COLUMN "status" TYPE "DeliveryJobStatus"
    USING (
        CASE "status"::text
            WHEN 'ACCEPTED' THEN 'ASSIGNED'
            WHEN 'EN_ROUTE_PICKUP' THEN 'ASSIGNED'
            WHEN 'EN_ROUTE_DROPOFF' THEN 'EN_ROUTE'
            ELSE "status"::text
        END
    )::"DeliveryJobStatus";

ALTER TABLE "delivery_jobs" ALTER COLUMN "status" SET DEFAULT 'CREATED';

DROP TYPE "DeliveryJobStatus_old";
