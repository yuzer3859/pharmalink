-- Module 01 — Identity: pharmacy licence approval lifecycle (Work 67).
--
-- - `verification_requests.licenseNumber`: the licence number an administrator approved for a
--   PHARMACY_LICENSE request. Null for every other verification type and for every request that
--   existed before this migration. Stored trimmed, 1 to 64 characters.
-- - A composite index on (organizationId, type, status): approval, expiry and Module 04's
--   activation check look up a pharmacy organisation's licence requests by these columns.
-- - A partial unique index: at most one PENDING PHARMACY_LICENSE request per (owner, organisation).
--   Submissions append to that request; two concurrent submissions cannot open two of them.
--
-- Additive (ADR-003): one nullable column, one CHECK constraint, two indexes. No existing row is
-- changed. The unique index can only fail to build if two PENDING PHARMACY_LICENSE requests
-- already exist for the same owner and organisation; before Work 67 submissions were serialized
-- per (user, type), so none are expected. To check before applying:
--
--   SELECT "userId", "organizationId", COUNT(*) FROM "verification_requests"
--   WHERE "type" = 'PHARMACY_LICENSE' AND "status" = 'PENDING' AND "organizationId" IS NOT NULL
--   GROUP BY 1, 2 HAVING COUNT(*) > 1;

ALTER TABLE "verification_requests" ADD COLUMN "licenseNumber" TEXT;

ALTER TABLE "verification_requests"
  ADD CONSTRAINT "verification_requests_license_number_check"
  CHECK (
    "licenseNumber" IS NULL
    OR (
      "type" = 'PHARMACY_LICENSE'
      AND char_length("licenseNumber") BETWEEN 1 AND 64
      AND "licenseNumber" = btrim("licenseNumber")
    )
  );

CREATE INDEX "verification_requests_organizationId_type_status_idx"
  ON "verification_requests"("organizationId", "type", "status");

CREATE UNIQUE INDEX "verification_requests_one_pending_pharmacy_license"
  ON "verification_requests"("userId", "organizationId")
  WHERE "type" = 'PHARMACY_LICENSE' AND "status" = 'PENDING' AND "organizationId" IS NOT NULL;
