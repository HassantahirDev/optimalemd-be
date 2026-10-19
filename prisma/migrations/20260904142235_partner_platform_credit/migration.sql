-- AlterEnum
ALTER TYPE "public"."CommissionStatus" ADD VALUE 'CREDITED';

-- AlterTable
ALTER TABLE "public"."referral_partners" ADD COLUMN     "creditActiveEmail" TEXT,
ADD COLUMN     "creditBalanceCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."welcome_orders" ADD COLUMN     "partnerCreditAppliedCents" INTEGER DEFAULT 0,
ADD COLUMN     "partnerCreditDeducted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partnerCreditPartnerId" TEXT;

-- CreateTable
CREATE TABLE "public"."partner_credit_email_verifications" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_credit_email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_credit_email_verifications_partnerId_idx" ON "public"."partner_credit_email_verifications"("partnerId");

-- AddForeignKey
ALTER TABLE "public"."partner_credit_email_verifications" ADD CONSTRAINT "partner_credit_email_verifications_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."referral_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
