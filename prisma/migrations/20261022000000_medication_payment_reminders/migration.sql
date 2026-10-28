-- Patient chart: track staff-sent medication payment reminders per appointment.

-- AlterTable
ALTER TABLE "public"."appointments" ADD COLUMN     "medicationPaymentReminderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "medicationPaymentReminderSentAt" TIMESTAMP(3);

