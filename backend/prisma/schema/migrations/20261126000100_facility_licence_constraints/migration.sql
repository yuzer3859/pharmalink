-- Work 160: a facility licence records an approved licence number and is one pending request per
-- (administrator, organisation), exactly like a pharmacy licence (Work 67). Kept apart from the
-- migration that adds the enum value, and compared as text, because PostgreSQL refuses a new
-- enum value in the transaction that adds it.

ALTER TABLE "verification_requests" DROP CONSTRAINT "verification_requests_license_number_check";

ALTER TABLE "verification_requests"
  ADD CONSTRAINT "verification_requests_license_number_check"
  CHECK (
    "licenseNumber" IS NULL
    OR (
      "type"::text IN ('PHARMACY_LICENSE', 'FACILITY_LICENSE')
      AND char_length("licenseNumber") BETWEEN 1 AND 64
      AND "licenseNumber" = btrim("licenseNumber")
    )
  );

CREATE UNIQUE INDEX "verification_requests_one_pending_facility_license"
  ON "verification_requests"("userId", "organizationId")
  WHERE "type"::text = 'FACILITY_LICENSE' AND "status" = 'PENDING' AND "organizationId" IS NOT NULL;
