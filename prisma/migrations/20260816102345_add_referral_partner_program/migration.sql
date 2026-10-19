-- CreateEnum
CREATE TYPE "public"."PartnerReferralStatus" AS ENUM ('PENDING', 'SIGNED_UP', 'QUALIFIED', 'VOIDED');

-- CreateEnum
CREATE TYPE "public"."CommissionType" AS ENUM ('FLAT', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "public"."CommissionStatus" AS ENUM ('OWED', 'PAID', 'VOIDED');

-- CreateTable
CREATE TABLE "public"."referral_partners" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "phone" TEXT,
    "companyName" TEXT,
    "referralCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "payoutMethod" TEXT,
    "payoutNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."partner_referrals" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "userId" TEXT,
    "landingUrl" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "status" "public"."PartnerReferralStatus" NOT NULL DEFAULT 'PENDING',
    "firstClickAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signedUpAt" TIMESTAMP(3),
    "qualifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."commission_rules" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT,
    "name" TEXT NOT NULL,
    "type" "public"."CommissionType" NOT NULL,
    "flatAmountCents" INTEGER,
    "percentBasisPoints" INTEGER,
    "serviceKeyword" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."commissions" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "partnerReferralId" TEXT NOT NULL,
    "ruleId" TEXT,
    "sourcePaymentRecordId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" "public"."CommissionStatus" NOT NULL DEFAULT 'OWED',
    "payoutBatchId" TEXT,
    "eligibleAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payout_batches" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_partners_email_key" ON "public"."referral_partners"("email");

-- CreateIndex
CREATE UNIQUE INDEX "referral_partners_referralCode_key" ON "public"."referral_partners"("referralCode");

-- CreateIndex
CREATE INDEX "partner_referrals_partnerId_idx" ON "public"."partner_referrals"("partnerId");

-- CreateIndex
CREATE INDEX "partner_referrals_visitorId_idx" ON "public"."partner_referrals"("visitorId");

-- CreateIndex
CREATE INDEX "partner_referrals_status_idx" ON "public"."partner_referrals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "partner_referral_user_unique" ON "public"."partner_referrals"("userId");

-- CreateIndex
CREATE INDEX "commission_rules_partnerId_idx" ON "public"."commission_rules"("partnerId");

-- CreateIndex
CREATE INDEX "commissions_partnerId_idx" ON "public"."commissions"("partnerId");

-- CreateIndex
CREATE INDEX "commissions_status_idx" ON "public"."commissions"("status");

-- CreateIndex
CREATE INDEX "payout_batches_partnerId_idx" ON "public"."payout_batches"("partnerId");

-- AddForeignKey
ALTER TABLE "public"."partner_referrals" ADD CONSTRAINT "partner_referrals_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."referral_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."commission_rules" ADD CONSTRAINT "commission_rules_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."referral_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."commissions" ADD CONSTRAINT "commissions_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."referral_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."commissions" ADD CONSTRAINT "commissions_partnerReferralId_fkey" FOREIGN KEY ("partnerReferralId") REFERENCES "public"."partner_referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."commissions" ADD CONSTRAINT "commissions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "public"."commission_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."commissions" ADD CONSTRAINT "commissions_payoutBatchId_fkey" FOREIGN KEY ("payoutBatchId") REFERENCES "public"."payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payout_batches" ADD CONSTRAINT "payout_batches_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."referral_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
