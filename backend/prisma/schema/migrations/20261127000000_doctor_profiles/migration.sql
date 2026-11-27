-- Work 166: doctors are registered by a platform administrator (Module 10). A doctor profile
-- carries the name patients see, its directory status, and its approved medical licence.
CREATE TYPE "DoctorStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "doctor_profiles"
  ADD COLUMN "fullName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "fullNameAm" TEXT,
  ADD COLUMN "status" "DoctorStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "licenseNumber" TEXT,
  ADD COLUMN "licenseExpiresAt" TIMESTAMP(3);

CREATE INDEX "doctor_profiles_status_specialty_idx" ON "doctor_profiles" ("status", "specialty");
CREATE UNIQUE INDEX "doctor_affiliations_doctor_provider_key" ON "doctor_affiliations" ("doctorId", "providerId");
