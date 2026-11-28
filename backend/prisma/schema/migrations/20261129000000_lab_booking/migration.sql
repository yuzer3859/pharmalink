-- Work 172: booking lab tests at a centre (module-11 §7). A booking remembers its capacity slot,
-- the patient's note and why it was cancelled; a location has one slot per start time.
ALTER TABLE "diagnostic_bookings"
  ADD COLUMN "slotId" TEXT,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "cancelReason" TEXT;

CREATE INDEX "diagnostic_bookings_patientUserId_scheduledAt_idx" ON "diagnostic_bookings" ("patientUserId", "scheduledAt");
CREATE INDEX "diagnostic_bookings_providerId_scheduledAt_idx" ON "diagnostic_bookings" ("providerId", "scheduledAt");
CREATE UNIQUE INDEX "diagnostic_slots_locationId_startAt_key" ON "diagnostic_slots" ("locationId", "startAt");
-- Capacity can never be exceeded, whatever the code does.
ALTER TABLE "diagnostic_slots" ADD CONSTRAINT "diagnostic_slots_capacity_check" CHECK ("bookedCount" >= 0 AND "bookedCount" <= "capacity" AND "capacity" >= 1);
