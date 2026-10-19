-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."PaymentStatus" ADD VALUE 'DISPUTED';
ALTER TYPE "public"."PaymentStatus" ADD VALUE 'INCOMPLETE';
ALTER TYPE "public"."PaymentStatus" ADD VALUE 'UNCAPTURED';

-- AlterTable
ALTER TABLE "public"."payment_records" ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "paymentMethodType" TEXT,
ADD COLUMN     "stripeCreated" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "payment_records_stripeCreated_idx" ON "public"."payment_records"("stripeCreated");

-- CreateIndex
CREATE INDEX "payment_records_billingEmail_idx" ON "public"."payment_records"("billingEmail");
