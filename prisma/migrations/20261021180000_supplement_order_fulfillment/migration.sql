-- Supplements store: shipping status for the admin Orders page (pending ->
-- shipped -> delivered), with optional carrier/tracking and timestamps.

-- CreateEnum
CREATE TYPE "public"."SupplementFulfillmentStatus" AS ENUM ('PENDING', 'SHIPPED', 'DELIVERED');

-- AlterTable
ALTER TABLE "public"."supplement_orders" ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "fulfillmentStatus" "public"."SupplementFulfillmentStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "fulfillmentUpdatedById" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippedEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "trackingNumber" TEXT;

-- CreateIndex
CREATE INDEX "supplement_orders_fulfillmentStatus_createdAt_idx" ON "public"."supplement_orders"("fulfillmentStatus", "createdAt");

