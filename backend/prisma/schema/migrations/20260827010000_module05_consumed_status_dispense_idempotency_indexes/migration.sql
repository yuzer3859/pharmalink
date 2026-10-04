-- Module 05 — Prescription & Matching, Slice 1 prerequisite schema changes
-- (backend/docs/05-prescription-matching-spec.md §6.2/§6.3/§6.4/§6.6). Architecture review found
-- Module 05's schema was DRAFT — NOT READY FOR IMPLEMENTATION pending exactly two required,
-- correctness-blocking gaps plus one bundled set of recommended indexes:
--
-- 1. `PrescriptionStatus` was missing `CONSUMED` (§6.2), the terminal state a single-use
--    prescription line reaches once fully dispensed (`remainingDispensable = 0`) — the parent
--    architecture doc (`architecture/module-05-prescription-matching.md` §5.2) already named it;
--    leaving it out is stale/incomplete code, not a design choice. Additive enum value only
--    (ADR-003 / `00-domain-event-catalog.md` §3 rule 1) — safe, no existing rows reference it
--    (Module 05 is unimplemented, `prescriptions`/`dispense_records` are empty).
-- 2. `dispense_records` had no uniqueness constraint guarding against a retried `DispenseMedicine`
--    call creating a second ledger entry for the same logical dispense (§6.3, resolves §20 Q7) —
--    a genuine BRULE-12 anti-reuse safety gap, the same class of bug as `DEFECT-PROFILES-001`.
--    `idempotencyKey` is added as required (client/caller-supplied on every insert, mirroring
--    Module 04's `stock_reservations.idempotencyKey` pattern from
--    `20260826000000_reservation_idempotency_key`) with a DB-enforced
--    `@@unique([prescriptionLineId, idempotencyKey])`, preferred over an application-only check
--    per the review's explicit instruction. Not nullable-for-backfill like Module 04's column,
--    because `dispense_records` has zero existing rows to backfill (Module 05 is unimplemented).
-- 3. Recommended, non-blocking performance indexes (§6.4), bundled into this same migration per
--    the review's instruction rather than shipped as a follow-up: `prescriptions` gets
--    `(verifyingPharmacyId, status)` for the verification queue's
--    `WHERE status = 'PENDING_VERIFICATION' AND verifyingPharmacyId = ?` query and
--    `(customerUserId)` for "list own prescriptions" (F-RX-06); `match_requests` gets
--    `(status, updatedAt)` for a future `MatchTimeoutSweeper` scan (not built in Slice 1, §8.4).
--
-- This migration only touches Module 05 tables — it does not modify Module 01-04 schema/data.
-- AlterEnum
ALTER TYPE "PrescriptionStatus" ADD VALUE 'CONSUMED';

-- AlterTable
ALTER TABLE "dispense_records" ADD COLUMN     "idempotencyKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "dispense_records_prescriptionLineId_idempotencyKey_key" ON "dispense_records"("prescriptionLineId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "prescriptions_verifyingPharmacyId_status_idx" ON "prescriptions"("verifyingPharmacyId", "status");

-- CreateIndex
CREATE INDEX "prescriptions_customerUserId_idx" ON "prescriptions"("customerUserId");

-- CreateIndex
CREATE INDEX "match_requests_status_updatedAt_idx" ON "match_requests"("status", "updatedAt");
