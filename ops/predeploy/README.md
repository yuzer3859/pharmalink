# Pre-deployment data checks — inventory, cancellation and rematch changes

Read-only data review required **before** deploying the changes merged in #1 ("Harden inventory cancellation and decline recovery") and running its two migrations in production.

> [!IMPORTANT]
> **Deployment is on hold until this review is complete.** Passing CI does not clear these risks: CI runs on disposable test data only. The hold lifts only after an authorised operator has run `predeploy-readonly-checks.v2.1.sql` in the approved environment, the results have been reviewed, and the release owner has recorded a decision (see [Release decision](#7-release-decision)). Query results are evidence for that decision, **not** permission to deploy.

| File | Purpose |
|---|---|
| `predeploy-readonly-checks.v2.1.sql` | The checks, unchanged from the reviewed v2.1 draft. SHA-256 `d237af6dbb14d18c1b57d5793b5d6b5c976432f978cdf5f9024b965981b507d8` (CRLF line endings; `.gitattributes` here keeps the bytes identical on every checkout). |
| `README.md` | This runbook and the audit. |

Verify the file before use:

```bash
sha256sum ops/predeploy/predeploy-readonly-checks.v2.1.sql
```

---

## 1. What the checks look for

| Check | Risk | Must be zero to deploy? |
|---|---|---|
| 1a / 1b | Cancellable orders holding a `CONFIRMED` reservation on a listing that has a historical `DISPATCH` movement with no `reservationId` | Not strictly; the release owner decides. Rows with `has_linked_dispatch = false` need investigation. |
| 2a / 2b | Soft-deleted listings that still hold live reservations | Not strictly; each one needs a recovery decision. |
| 3 | Live listings in the Work 54 `undetermined` state (same signal as the admin reservation-integrity view) | Informational context for check 1. |
| 4a | Number of match requests the Module 05 backfill would bind | Informational (expected: roughly every checkout order created before the change). |
| 4b | A match request referenced by more than one order | **Yes. Must be zero** before the backfill migration runs. |
| 4c | Orders whose `matchRequestId` points at no match request | Not strictly; review. |
| 4d | Match requests already bound to a different order than the one referencing them | Not strictly; review. |
| 0 | Environment identity, read-only status and migration state | Must match the expected target (see §4). |

---

## 2. Audit (against `main` at `128e310`)

### 2.1 Read-only behaviour

Every statement was reviewed, not only the leading keyword:

- **Transaction:** `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` … `ROLLBACK`. PostgreSQL rejects any write, DDL or `nextval()` in a read-only transaction, and the final `ROLLBACK` discards anything that could remain. Repeatable read gives every query the same snapshot.
- **Statements executed:** one `SET LOCAL statement_timeout = '120s'` (transaction-scoped session setting, discarded at `ROLLBACK`) and `SELECT`s only.
- **Functions called:** `current_database()`, `current_user`, `current_setting()`, `pg_is_in_recovery()`, `now()`, `count()`, `array_agg()`, plus `EXISTS` subqueries. None of them writes, sends notifications, takes advisory locks, or calls out of the database. No user-defined functions, views, triggers or sequences are referenced, so no hidden code runs.
- **Write keywords:** the only `UPDATE` in the file is inside a comment (check 4, quoting the migration). No `INSERT`, `DELETE`, `MERGE`, DDL, `COPY`, `CALL`, `DO`, `LOCK`, `VACUUM`/`ANALYZE`, `GRANT` or `dblink`.
- **Locks:** ordinary `SELECT`s take `ACCESS SHARE` locks, which block nothing except `ACCESS EXCLUSIVE` (e.g. DDL). If a DDL statement is already waiting on a table, a `SELECT` queues behind it. Run outside deployment/migration windows and use `lock_timeout` (§5) so the check gives up instead of waiting.
- **Load:** checks 1–3 use correlated `EXISTS` subqueries over `stock_movements`; `stock_movements` has indexes on `listingId` and `reservationId`. `statement_timeout` caps each statement at 120 s. Prefer a read replica if the primary is busy.

**Conclusion:** no write path was found. The read-only transaction and `ROLLBACK` are a second line of defence, not the only one. Still connect with a role that has no write privileges (§3): defence in depth.

### 2.2 Personal data in the output

The output contains ids (UUIDs), statuses, quantities, timestamps and counts. It selects no names, phone numbers, addresses, prescriptions or payment data. UUIDs and timestamps are still internal operational data: keep the full output inside the approved secure environment and share only aggregate counts outside it (§6).

### 2.3 Schema compatibility

Every table, column and enum value used exists on `main` with these exact names (no `@map` renames):

| Table | Columns used |
|---|---|
| `stock_movements` | `listingId`, `type` (`StockMovementType`: `DISPATCH`), `reservationId` (nullable) |
| `stock_reservations` | `id`, `listingId`, `status` (`ReservationStatus`: `HELD`, `CONFIRMED`), `quantity`, `expiresAt` |
| `inventory_listings` | `id`, `deletedAt`, `pharmacyId`, `branchId`, `catalogProductId`, `reserved` |
| `orders` | `id`, `status` (`OrderStatus`: `DRAFT`, `PENDING_PAYMENT`, `PAID`, `ACCEPTED`), `matchRequestId` (nullable, **not unique**) |
| `order_lines` | `orderId`, `reservationId` (nullable) |
| `match_requests` | `id`, `orderId` (nullable) |
| `_prisma_migrations` | `migration_name`, `finished_at`, `rolled_back_at` |

The script does not reference `order_cancellation_requests`, so it should run both before and after the new migrations; that is not yet confirmed on a live database (§8).

### 2.4 Query by query

**Check 0 — environment.** Prints the database name, role, server version, `transaction_read_only`, whether the server is a replica, and the snapshot time; then the state of three migrations.
- *Expect before deployment:* `read_only = on`; `20260827000000_stock_movement_reservation_id` present with `finished_at` set and `rolled_back_at` null; `20261015000000_module05_bind_match_request_order` and `20261016000000_module06_order_cancellation_requests` **absent**.
- *If the 2026-08-27 migration is missing,* every historical dispatch is unlinked and checks 1–3 are not meaningful: stop. *If either new migration is present,* the release already ran (or partly ran): stop and escalate.

**Check 1 — historical dispatches that threaten cancellation (1a counts, 1b ids).**
- *Records:* orders in the cancellable statuses (`DRAFT`, `PENDING_PAYMENT`, `PAID`, `ACCEPTED`, identical to `CancellationPolicy`), joined through `order_lines.reservationId` to a `CONFIRMED` reservation, whose listing has at least one `DISPATCH` movement with `reservationId IS NULL` (recorded before 2026-08-27, when movements started carrying the reservation id).
- *Why:* the new release guard refuses to release a reservation only if a `DISPATCH` movement is *linked* to it. If an old unlinked dispatch actually consumed this reservation, a cancellation would release (re-credit) stock that has already left the pharmacy.
- *`has_linked_dispatch = true`* rows are already protected by the guard. *`has_linked_dispatch = false`* rows (`unprotected_*` in 1a) are the real candidates.
- *Zero means:* no cancellable order currently holds a confirmed reservation on a listing with any unlinked dispatch. *It does not mean* historical stock counts are correct, nor that orders in `READY` or later are safe (they can't be customer-cancelled, so they are out of scope here).
- *Non-zero requires:* for each unprotected reservation, compare the listing's unlinked `DISPATCH` movements (time, quantity) with the reservation's confirmation and the order's fulfilment history to decide whether the stock really left. Options: mark it handled operationally, or block cancellation of that order until resolved.
- *Completeness:* this is a candidate list; an unlinked movement on the same listing is not proof that it consumed this reservation. It is enough to size the risk and drive the investigation, not to auto-resolve it.

**Check 2 — soft-deleted listings with live reservations (2a counts, 2b ids).**
- *Records:* listings with `deletedAt` set that still have a `HELD` reservation, or a `CONFIRMED` one with no linked `DISPATCH`. This is the same "live" rule the new deletion guard uses (`countLiveForListing`), so ambiguous historical dispatches count as live.
- *Why:* the new guard stops *new* deletions while live reservations exist; listings deleted earlier may already be in that state. The reserve path refuses soft-deleted listings, so release/confirm flows for those reservations may fail or need manual recovery.
- *Zero means:* no soft-deleted listing holds a live reservation right now. *It does not mean* expired/released reservations on deleted listings were accounted correctly.
- *Non-zero requires:* per reservation (2b), decide with the business owner: let a `HELD` one expire (TTL is 15 minutes, so persistent `HELD` rows on deleted listings are themselves suspicious), complete the order, or plan a manual recovery. `listing_has_unlinked_dispatch` flags rows that overlap with check 1.
- *Completeness:* sufficient for the release decision on this risk.

**Check 3 — Work 54 `undetermined` listings.**
- *Records:* live (not deleted) listings with a `CONFIRMED` reservation that has no linked `DISPATCH`, while the listing has an unlinked `DISPATCH`. A verbatim copy of the admin reservation-integrity view's definition, unfiltered.
- *Why:* context for check 1: it counts listings regardless of order status. *Zero / non-zero:* compare with check 1; a listing here but not in check 1 has such reservations only on non-cancellable orders, or on reservations not attached to an order line.
- *Output note:* `listing_ids` is one array of every listing id; it can be long.

**Check 4 — Module 05 bind backfill preview.**
- The migration (`20261015000000_module05_bind_match_request_order`) runs `UPDATE match_requests SET "orderId" = o.id FROM orders o WHERE o."matchRequestId" = match_requests.id AND match_requests."orderId" IS NULL`.
- *4a:* number of unbound match requests that at least one order references, i.e. how many rows the backfill would update. Expected: about one per checkout order created before the change. A value far from that is worth understanding before deploying.
- *4b:* match requests referenced by **more than one** order. `orders.matchRequestId` is not unique, and `UPDATE … FROM` with several matching rows binds an **arbitrary** one. **Must be zero.** If not, resolve each case (decide which order owns the match request) before the migration runs.
- *4c:* orders whose `matchRequestId` points at a non-existent match request. The backfill skips them; after deployment those orders can't be re-matched through the bound path. Review.
- *4d:* match requests already bound to a *different* order than one that references them. The backfill leaves them untouched (it only updates `orderId IS NULL`). Each one is a data inconsistency that the new `MATCH_REQUEST_ORDER_BOUND` guard will enforce against the referencing order. Review.
- *Zero in all of 4b–4d means:* the backfill is deterministic and leaves no known inconsistency. *It does not* validate orders that have no `matchRequestId` at all (they are not affected by the backfill).
- *Completeness:* sufficient for the backfill decision.

### 2.5 Known gaps (accepted for this release check, not fixed in the script)

- Check 1 does not compare movement timestamps with reservation timestamps; it over-reports by design.
- Checks 1–3 look only at reservations reachable through current data; they don't reconstruct historical stock balances.
- Reservations not attached to an order line (e.g. holds abandoned mid-checkout) appear in checks 2 and 3 but not in check 1. Cancellation never releases them, so check 1 doesn't need them.
- Check 3's single `array_agg` can produce a very long cell on large datasets.
- The script header still says "UNEXECUTED … not run against any database". That remains true for production; the file was left byte-identical rather than edited, so its checksum stays traceable to the reviewed draft.

---

## 3. Who runs it, and where

- **Role:** an authorised database operator, connecting as a database role with **read-only privileges** (e.g. a member of `pg_read_all_data`, or `SELECT`-only grants on the tables above). Never the application role or a migration/owner role.
- **Target:** production, or a **fresh** read replica of production, as chosen by the release owner. "Fresh" means replication lag is negligible at run time (check `snapshot_at` and the replica's lag). A stale replica or a restored backup is not acceptable without the release owner's explicit approval.
- **Timing:** outside deployment or migration windows.
- **Never:** run this from CI, from a developer laptop holding a copied production connection string, or against an unknown database.

## 4. Confirm the target before running

From the approved bastion or operations host, open the session and confirm the target **before** running the file:

```sql
SELECT current_database(), current_user, inet_server_addr(), pg_is_in_recovery(),
       current_setting('default_transaction_read_only');
```

The database, host and role must match what the release owner approved. Do not continue if any value is unexpected. Check 0 in the script repeats this inside the transaction, and its output is part of the evidence.

## 5. Run it read-only

The script opens its own read-only transaction. Make the whole session read-only as well, so even a mistyped extra command cannot write:

```bash
PGOPTIONS='-c default_transaction_read_only=on -c lock_timeout=5s' \
  psql "service=<approved-service-name>" \
       -v ON_ERROR_STOP=1 -X --echo-errors \
       -f ops/predeploy/predeploy-readonly-checks.v2.1.sql \
       > predeploy-results-$(date -u +%Y%m%dT%H%M%SZ).txt 2>&1
```

- Use a `pg_service.conf` entry or your secrets manager for the connection. **Never** put a password or connection string on the command line, in shell history, in this repository or in a ticket.
- `-X` ignores any personal `.psqlrc`, `ON_ERROR_STOP=1` stops at the first error, and `lock_timeout` makes the run fail fast instead of queueing behind DDL.
- If the run stops with an error (timeout, lock timeout, permission denied), record it, fix the cause (e.g. use the replica), and re-run the whole file. A partial run is not evidence.

## 6. Store and share results

- Keep the full output file inside the approved secure environment (the restricted operations share or ticket attachment store the release owner designates). Don't email it, paste it into chat, or commit it.
- Outside that environment, share only: the check 0 identity values (database name, replica yes/no, snapshot time), the migration-state rows, and the **aggregate counts** from 1a, 2a, 3 (`listings_undetermined` only), 4a, 4b (number of rows), 4c and 4d.
- Retain the file as long as release evidence must be kept, then delete it per the data-retention policy.

## 7. Release decision

The release owner records, in the release ticket:

1. Target, operator, run time (`snapshot_at`) and the SHA-256 of the script used.
2. The aggregate counts from §6.
3. For each non-zero check: **accept** (with a reason), **remediate** (with an owner and the follow-up ticket), or **hold**.
4. One of:
   - **Cleared:** 4b is zero and every other finding is accepted or remediated. Deployment may be *scheduled* through the normal release process.
   - **Hold continues:** with the blocking items listed.

Without that record, the hold stays in place. If more than a few days pass between the check and the deployment, or if a large data change happens in between, re-run the check.

## 8. Validation on a disposable database

**Status: not yet validated on a live database.** The script has not been executed anywhere: not in production, and not yet on a disposable database either.

What has been checked:
- **Static schema check:** every table, column and enum value in §2.3 was compared with the Prisma schema on `main` at `128e310`, and the three migration names with `backend/prisma/schema/migrations/`. All match.
- **Read-only review:** see §2.1.

Still to do before handing this to an operator (on a disposable database only):
1. Start a throwaway `postgres:16` container (the same image the e2e suite uses) with a database named `pharmalink_predeploy_validation`, bound to `127.0.0.1` on a random port.
2. Apply the repository's migrations to that container only, first **without** `20261015000000` and `20261016000000` (the production pre-deployment state), then with all migrations.
3. Run the script in both states with `ON_ERROR_STOP=1` and confirm every statement parses and runs. Empty results are expected and say nothing about production.
4. Confirm a write attempted inside the same `READ ONLY` transaction is rejected.
5. Destroy the container.

Never reuse an existing developer database for this, and never point it at production.
