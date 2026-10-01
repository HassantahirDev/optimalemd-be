-- Texas medical-marijuana intake.
-- Patients who opt in at signup pay a $150 welcome fee instead of $65 and are
-- exempt from the lab-results requirement when booking.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isMedicalMarijuana" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "welcome_orders" ADD COLUMN IF NOT EXISTS "isMedicalMarijuana" BOOLEAN NOT NULL DEFAULT false;
