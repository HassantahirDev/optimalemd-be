-- "New Encounter" (doctor-created follow-up on an existing patient, no slot or booking payment).

-- AlterTable
ALTER TABLE "public"."appointments" ADD COLUMN     "encounterSourceAppointmentId" TEXT,
ADD COLUMN     "isEncounter" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "appointments_isEncounter_idx" ON "public"."appointments"("isEncounter");

