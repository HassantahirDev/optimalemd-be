-- Supplements store: member pricing (20% off for active members), a soft link
-- from orders to the signed-in patient, and a SUPPLEMENT ledger category so
-- purchases appear in the patient's billing history.

-- AlterEnum
ALTER TYPE "public"."PaymentCategory" ADD VALUE 'SUPPLEMENT';

-- AlterTable
ALTER TABLE "public"."supplement_orders" ADD COLUMN     "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "isMember" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "public"."supplement_order_items" ADD COLUMN     "listPrice" DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "supplement_orders_userId_idx" ON "public"."supplement_orders"("userId");

