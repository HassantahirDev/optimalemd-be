-- CreateEnum
CREATE TYPE "public"."PaymentChannel" AS ENUM ('PLATFORM', 'POS', 'INVOICE');

-- CreateEnum
CREATE TYPE "public"."PaymentCategory" AS ENUM ('MEDICATION', 'MEMBERSHIP', 'APPOINTMENT', 'SIGNUP', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."PaymentBilling" AS ENUM ('ONE_TIME', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "public"."MedicationOrderStatus" AS ENUM ('ACTIVE', 'PAST');

-- CreateTable
CREATE TABLE "public"."payment_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "appointmentId" TEXT,
    "medicationPaymentId" TEXT,
    "welcomeOrderId" TEXT,
    "subscriptionTransactionId" TEXT,
    "channel" "public"."PaymentChannel" NOT NULL,
    "category" "public"."PaymentCategory" NOT NULL,
    "billing" "public"."PaymentBilling" NOT NULL DEFAULT 'ONE_TIME',
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "refundedAmount" DECIMAL(10,2),
    "stripePaymentIntentId" TEXT,
    "stripeInvoiceId" TEXT,
    "stripeChargeId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripeCustomerId" TEXT,
    "receiptUrl" TEXT,
    "hostedInvoiceUrl" TEXT,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "createdByType" TEXT,
    "createdById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "payment_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payment_line_items" (
    "id" TEXT NOT NULL,
    "paymentRecordId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "stripePriceId" TEXT,
    "medicationId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmount" DECIMAL(10,2) NOT NULL,
    "isSubscription" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "payment_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."medication_orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "public"."MedicationOrderStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "billing" "public"."PaymentBilling" NOT NULL DEFAULT 'ONE_TIME',
    "sourcePaymentRecordId" TEXT,
    "stripeSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medication_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."medication_order_items" (
    "id" TEXT NOT NULL,
    "medicationOrderId" TEXT NOT NULL,
    "medicationId" TEXT,
    "medicationName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "dosageSnapshot" TEXT,

    CONSTRAINT "medication_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payment_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "role" TEXT NOT NULL DEFAULT 'payment_staff',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_records_stripePaymentIntentId_key" ON "public"."payment_records"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_records_stripeInvoiceId_key" ON "public"."payment_records"("stripeInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_records_stripeChargeId_key" ON "public"."payment_records"("stripeChargeId");

-- CreateIndex
CREATE INDEX "payment_records_userId_idx" ON "public"."payment_records"("userId");

-- CreateIndex
CREATE INDEX "payment_records_category_status_idx" ON "public"."payment_records"("category", "status");

-- CreateIndex
CREATE INDEX "payment_records_channel_idx" ON "public"."payment_records"("channel");

-- CreateIndex
CREATE INDEX "payment_records_stripeSubscriptionId_idx" ON "public"."payment_records"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "payment_line_items_paymentRecordId_idx" ON "public"."payment_line_items"("paymentRecordId");

-- CreateIndex
CREATE INDEX "medication_orders_userId_status_idx" ON "public"."medication_orders"("userId", "status");

-- CreateIndex
CREATE INDEX "medication_order_items_medicationOrderId_idx" ON "public"."medication_order_items"("medicationOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_users_email_key" ON "public"."payment_users"("email");

-- AddForeignKey
ALTER TABLE "public"."payment_records" ADD CONSTRAINT "payment_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payment_line_items" ADD CONSTRAINT "payment_line_items_paymentRecordId_fkey" FOREIGN KEY ("paymentRecordId") REFERENCES "public"."payment_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."medication_orders" ADD CONSTRAINT "medication_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."medication_orders" ADD CONSTRAINT "medication_orders_sourcePaymentRecordId_fkey" FOREIGN KEY ("sourcePaymentRecordId") REFERENCES "public"."payment_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."medication_order_items" ADD CONSTRAINT "medication_order_items_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "public"."medication_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
