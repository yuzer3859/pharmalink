-- Work 168: booking doctors' slots (module-10 §6). A slot keeps its past appointments
-- (cancelled, rescheduled, no-show) so it can be booked again; at most one appointment per slot
-- is active at a time, enforced by the database so two concurrent bookings cannot both win.
DROP INDEX "appointments_slotId_key";
CREATE INDEX "appointments_slotId_idx" ON "appointments" ("slotId");
CREATE UNIQUE INDEX "appointments_one_active_per_slot" ON "appointments" ("slotId")
  WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS');
CREATE INDEX "appointments_patientUserId_scheduledStart_idx" ON "appointments" ("patientUserId", "scheduledStart");
CREATE INDEX "appointments_doctorId_scheduledStart_idx" ON "appointments" ("doctorId", "scheduledStart");
