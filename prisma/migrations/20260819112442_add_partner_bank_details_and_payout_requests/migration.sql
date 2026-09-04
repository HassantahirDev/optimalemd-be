-- CreateEnum
CREATE TYPE "public"."PayoutRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."referral_partners" ADD COLUMN     "bankAccountHolderName" TEXT,
ADD COLUMN     "bankAccountNumber" TEXT,
ADD COLUMN     "bankAccountType" TEXT,
ADD COLUMN     "bankDetailsUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "bankRoutingNumber" TEXT;

-- CreateTable
CREATE TABLE "public"."payout_requests" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "public"."PayoutRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "payoutBatchId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_requests_payoutBatchId_key" ON "public"."payout_requests"("payoutBatchId");

-- CreateIndex
CREATE INDEX "payout_requests_partnerId_idx" ON "public"."payout_requests"("partnerId");

-- CreateIndex
CREATE INDEX "payout_requests_status_idx" ON "public"."payout_requests"("status");

-- AddForeignKey
ALTER TABLE "public"."payout_requests" ADD CONSTRAINT "payout_requests_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "public"."referral_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payout_requests" ADD CONSTRAINT "payout_requests_payoutBatchId_fkey" FOREIGN KEY ("payoutBatchId") REFERENCES "public"."payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
