-- Appointment reminder emails (24h and 30m before the visit).
-- Both columns are nullable and additive; null means "not sent yet".
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "reminder24hSentAt" TIMESTAMP(3);
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "reminder30mSentAt" TIMESTAMP(3);

-- The sweep filters on status + date every few minutes; this keeps it cheap.
CREATE INDEX IF NOT EXISTS "appointments_reminder_sweep_idx"
  ON "appointments"("status", "appointmentDate");
