-- qADAM / IIEF / PHQ-9 answered by the patient before every booking (integer answers, summed for scores).

-- CreateTable
CREATE TABLE "public"."appointment_questionnaires" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "qadam" INTEGER[],
    "iief" INTEGER[],
    "phq9" INTEGER[],
    "phq9Difficulty" INTEGER,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointment_questionnaires_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointment_questionnaires_appointmentId_key" ON "public"."appointment_questionnaires"("appointmentId");

-- CreateIndex
CREATE INDEX "appointment_questionnaires_patientId_idx" ON "public"."appointment_questionnaires"("patientId");

-- AddForeignKey
ALTER TABLE "public"."appointment_questionnaires" ADD CONSTRAINT "appointment_questionnaires_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "public"."appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."appointment_questionnaires" ADD CONSTRAINT "appointment_questionnaires_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
