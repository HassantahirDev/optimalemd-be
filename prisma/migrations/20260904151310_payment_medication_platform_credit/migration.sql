-- AlterTable
ALTER TABLE "public"."medication_payments" ADD COLUMN     "partnerCreditAppliedCents" INTEGER DEFAULT 0,
ADD COLUMN     "partnerCreditDeducted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partnerCreditPartnerId" TEXT;

-- AlterTable
ALTER TABLE "public"."payments" ADD COLUMN     "partnerCreditAppliedCents" INTEGER DEFAULT 0,
ADD COLUMN     "partnerCreditDeducted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partnerCreditPartnerId" TEXT;
