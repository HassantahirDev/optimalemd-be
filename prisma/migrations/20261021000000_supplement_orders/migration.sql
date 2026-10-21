-- CreateEnum
CREATE TYPE "public"."SupplementOrderStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateTable
CREATE TABLE "public"."supplement_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "public"."SupplementOrderStatus" NOT NULL DEFAULT 'PENDING',
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "shippingLine1" TEXT NOT NULL,
    "shippingLine2" TEXT,
    "shippingCity" TEXT NOT NULL,
    "shippingState" TEXT NOT NULL,
    "shippingPostalCode" TEXT NOT NULL,
    "shippingCountry" TEXT NOT NULL DEFAULT 'US',
    "subtotal" DECIMAL(10,2) NOT NULL,
    "shippingAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripePaymentIntentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "confirmationEmailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplement_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."supplement_order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productSlug" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotal" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "supplement_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplement_orders_orderNumber_key" ON "public"."supplement_orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "supplement_orders_stripePaymentIntentId_key" ON "public"."supplement_orders"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "supplement_orders_email_idx" ON "public"."supplement_orders"("email");

-- CreateIndex
CREATE INDEX "supplement_orders_status_createdAt_idx" ON "public"."supplement_orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "supplement_order_items_orderId_idx" ON "public"."supplement_order_items"("orderId");

-- AddForeignKey
ALTER TABLE "public"."supplement_order_items" ADD CONSTRAINT "supplement_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."supplement_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
