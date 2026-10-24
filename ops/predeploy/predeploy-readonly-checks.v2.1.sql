-- PharmaLink — pre-deployment READ-ONLY data checks, v2.1 (Work 55: cancellation, inventory and rematch changes)
-- UNEXECUTED: written for an authorised operator; not run against any database.
-- Run with psql as an authorised operator against PRODUCTION (or a fresh read replica of it).
-- Everything runs inside one READ ONLY, REPEATABLE READ transaction (one consistent snapshot) and
-- ends with ROLLBACK. There are no active write statements (INSERT/UPDATE/DELETE/DDL): every statement
-- is a SELECT, apart from SET LOCAL statement_timeout. The only UPDATE in this file is quoted inside a
-- comment in Check 4 to show what the migration's backfill will run — it is never executed here.
-- PostgreSQL itself rejects writes in a READ ONLY transaction. Output: ids and statuses only, no customer PII.
--
--   psql "<production connection>" -v ON_ERROR_STOP=1 -f predeploy-readonly-checks.v2.1.sql

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '120s';

-- ── 0. Environment verification (non-sensitive) ────────────────────────────────────────────────
-- Confirm database name and role before trusting any result; `read_only` must be `on`.
SELECT current_database()                     AS database,
       current_user                           AS role,
       current_setting('server_version')      AS pg_version,
       current_setting('transaction_read_only') AS read_only,
       pg_is_in_recovery()                    AS is_replica,
       now()                                  AS snapshot_at;

-- Which relevant migrations this database has, by their FINAL names:
--   20260827000000_stock_movement_reservation_id        — must be applied (finished_at not null)
--   20261015000000_module05_bind_match_request_order     — expected ABSENT before deployment
--   20261016000000_module06_order_cancellation_requests  — expected ABSENT before deployment
SELECT migration_name, finished_at, rolled_back_at
  FROM "_prisma_migrations"
 WHERE migration_name IN ('20260827000000_stock_movement_reservation_id',
                          '20261015000000_module05_bind_match_request_order',
                          '20261016000000_module06_order_cancellation_requests')
 ORDER BY migration_name;

-- Shared definitions used below (inlined in each statement — a READ ONLY transaction creates no views):
--   linked dispatch   : a DISPATCH movement whose "reservationId" = the reservation  (Module 04's rule)
--   unlinked dispatch : a DISPATCH movement on the listing with "reservationId" IS NULL (pre-20260827)
-- NOTE: an order's reservations are reached through "order_lines"."reservationId" — NOT through
-- "stock_reservations"."orderId". Before the Module 05 bind deploys, checkout reservations carry the
-- match request's id there; afterwards new ones carry the order id. The joins below are correct either way.

-- ── 1. Historical dispatches that threaten cancellation ────────────────────────────────────────
-- Cancellable orders with ≥1 CONFIRMED reservation on a listing that has an unlinked DISPATCH.
-- `has_linked_dispatch = true` rows are already protected (the batch release rejects them);
-- `has_linked_dispatch = false` rows are the real candidates: the release guard cannot tell whether
-- the unlinked dispatch consumed them. Candidates only — an unlinked movement is NOT proof.
-- 1a. Counts
WITH cand AS (
  SELECT o."id" AS order_id, r."id" AS reservation_id, r."listingId" AS listing_id,
         EXISTS (SELECT 1 FROM "stock_movements" m
                  WHERE m."reservationId" = r."id" AND m."type" = 'DISPATCH') AS has_linked_dispatch
    FROM "orders" o
    JOIN "order_lines" ol       ON ol."orderId" = o."id"
    JOIN "stock_reservations" r ON r."id" = ol."reservationId"
   WHERE o."status" IN ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'ACCEPTED')
     AND r."status" = 'CONFIRMED'
     AND EXISTS (SELECT 1 FROM "stock_movements" lm
                  WHERE lm."listingId" = r."listingId" AND lm."type" = 'DISPATCH' AND lm."reservationId" IS NULL)
)
SELECT count(DISTINCT order_id)                                             AS affected_orders,
       count(DISTINCT reservation_id)                                       AS affected_reservations,
       count(DISTINCT listing_id)                                           AS affected_listings,
       count(DISTINCT order_id)       FILTER (WHERE NOT has_linked_dispatch) AS unprotected_orders,
       count(DISTINCT reservation_id) FILTER (WHERE NOT has_linked_dispatch) AS unprotected_reservations
  FROM cand;

-- 1b. Candidate ids for investigation
WITH cand AS (
  SELECT o."id" AS order_id, o."status" AS order_status, r."id" AS reservation_id, r."listingId" AS listing_id,
         r."quantity", il."deletedAt" IS NOT NULL AS listing_deleted,
         EXISTS (SELECT 1 FROM "stock_movements" m
                  WHERE m."reservationId" = r."id" AND m."type" = 'DISPATCH') AS has_linked_dispatch
    FROM "orders" o
    JOIN "order_lines" ol         ON ol."orderId" = o."id"
    JOIN "stock_reservations" r   ON r."id" = ol."reservationId"
    JOIN "inventory_listings" il  ON il."id" = r."listingId"
   WHERE o."status" IN ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'ACCEPTED')
     AND r."status" = 'CONFIRMED'
     AND EXISTS (SELECT 1 FROM "stock_movements" lm
                  WHERE lm."listingId" = r."listingId" AND lm."type" = 'DISPATCH' AND lm."reservationId" IS NULL)
)
SELECT DISTINCT order_id, order_status, reservation_id, listing_id, quantity, listing_deleted, has_linked_dispatch
  FROM cand
 ORDER BY has_linked_dispatch, order_id, reservation_id;

-- ── 2. Soft-deleted listings that still have live reservations ─────────────────────────────────
-- Live = HELD, or CONFIRMED with no linked DISPATCH (ambiguous historical dispatches count as live) —
-- the same rule as the new deletion guard (`countLiveForListing`).
-- 2a. Counts
WITH live AS (
  SELECT il."id" AS listing_id, r."id" AS reservation_id, r."status" AS reservation_status
    FROM "inventory_listings" il
    JOIN "stock_reservations" r ON r."listingId" = il."id"
   WHERE il."deletedAt" IS NOT NULL
     AND (r."status" = 'HELD'
          OR (r."status" = 'CONFIRMED'
              AND NOT EXISTS (SELECT 1 FROM "stock_movements" m
                               WHERE m."reservationId" = r."id" AND m."type" = 'DISPATCH')))
)
SELECT count(DISTINCT live.listing_id)                                                  AS deleted_listings_with_live_reservations,
       count(DISTINCT live.reservation_id)                                              AS live_reservations,
       count(DISTINCT live.reservation_id) FILTER (WHERE reservation_status = 'HELD')      AS held,
       count(DISTINCT live.reservation_id) FILTER (WHERE reservation_status = 'CONFIRMED') AS confirmed_undispatched_or_ambiguous,
       count(DISTINCT ol."orderId")                                                     AS related_orders
  FROM live
  LEFT JOIN "order_lines" ol ON ol."reservationId" = live.reservation_id;

-- 2b. Ids for recovery planning (order columns are NULL for holds not attached to an order line)
WITH live AS (
  SELECT il."id" AS listing_id, il."deletedAt" AS listing_deleted_at, r."id" AS reservation_id,
         r."status" AS reservation_status, r."quantity", r."expiresAt",
         EXISTS (SELECT 1 FROM "stock_movements" lm
                  WHERE lm."listingId" = il."id" AND lm."type" = 'DISPATCH' AND lm."reservationId" IS NULL) AS listing_has_unlinked_dispatch
    FROM "inventory_listings" il
    JOIN "stock_reservations" r ON r."listingId" = il."id"
   WHERE il."deletedAt" IS NOT NULL
     AND (r."status" = 'HELD'
          OR (r."status" = 'CONFIRMED'
              AND NOT EXISTS (SELECT 1 FROM "stock_movements" m
                               WHERE m."reservationId" = r."id" AND m."type" = 'DISPATCH')))
)
SELECT DISTINCT live.listing_id, live.listing_deleted_at, live.reservation_id, live.reservation_status,
       live.quantity, live."expiresAt", live.listing_has_unlinked_dispatch,
       ol."orderId" AS order_id, o."status" AS order_status
  FROM live
  LEFT JOIN "order_lines" ol ON ol."reservationId" = live.reservation_id
  LEFT JOIN "orders" o       ON o."id" = ol."orderId"
 ORDER BY live.listing_id, live.reservation_id;

-- ── 3. Work 54 reservation-integrity `undetermined` signal (verbatim definition) ────────────────
-- Copied from PrismaReservationIntegrityReadAdapter.classifiedListings with no pharmacy/branch filter:
-- a LIVE listing (deletedAt IS NULL) with a CONFIRMED reservation that has no linked DISPATCH, while
-- the listing has an unlinked DISPATCH.
WITH live AS (
  SELECT il."id", il."pharmacyId", il."branchId", il."catalogProductId", il."reserved"
    FROM "inventory_listings" il
   WHERE il."deletedAt" IS NULL
),
undetermined AS (
  SELECT DISTINCT r."listingId"
    FROM "stock_reservations" r JOIN live ON live."id" = r."listingId"
   WHERE r."status" = 'CONFIRMED'
     AND NOT EXISTS (SELECT 1 FROM "stock_movements" m WHERE m."reservationId" = r."id" AND m."type" = 'DISPATCH')
     AND EXISTS (SELECT 1 FROM "stock_movements" lm
                  WHERE lm."listingId" = r."listingId" AND lm."type" = 'DISPATCH' AND lm."reservationId" IS NULL)
)
SELECT (SELECT count(*) FROM undetermined)                           AS listings_undetermined,
       (SELECT array_agg("listingId" ORDER BY "listingId") FROM undetermined) AS listing_ids;

-- ── 4. Preview of the Module 05 bind backfill (20261015000000_module05_bind_match_request_order) ─
-- The migration runs: UPDATE match_requests SET "orderId" = o.id FROM orders o
--                     WHERE o."matchRequestId" = match_requests.id AND match_requests."orderId" IS NULL.
-- 4a. How many unbound match requests it would bind (expected: every pre-change checkout order).
SELECT count(DISTINCT mr."id") AS requests_to_bind
  FROM "match_requests" mr
  JOIN "orders" o ON o."matchRequestId" = mr."id"
 WHERE mr."orderId" IS NULL;

-- 4b. Ambiguity: a match request referenced by more than one order. UPDATE … FROM would bind it to an
-- arbitrary one of them, so this MUST be zero before deploying the backfill (ids for review).
SELECT o."matchRequestId" AS match_request_id, count(*) AS orders, array_agg(o."id" ORDER BY o."id") AS order_ids
  FROM "orders" o
 WHERE o."matchRequestId" IS NOT NULL
 GROUP BY o."matchRequestId"
HAVING count(*) > 1;

-- 4c. Orders whose matchRequestId points to no match request (the backfill skips them; review only).
SELECT count(*) AS orders_with_missing_match_request
  FROM "orders" o
 WHERE o."matchRequestId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "match_requests" mr WHERE mr."id" = o."matchRequestId");

-- 4d. Requests already bound to a DIFFERENT order than the one referencing them (left untouched; review).
SELECT count(*) AS conflicting_bindings
  FROM "orders" o
  JOIN "match_requests" mr ON mr."id" = o."matchRequestId"
 WHERE mr."orderId" IS NOT NULL AND mr."orderId" <> o."id";

ROLLBACK;
