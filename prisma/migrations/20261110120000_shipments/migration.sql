-- USPS shipments: tracking, labels and the "on its way" email log.
-- CreateEnum
CREATE TYPE "public"."ShipmentStatus" AS ENUM ('LABEL_CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'ALERT', 'UNKNOWN');

-- CreateTable
CREATE TABLE "public"."shipments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "carrier" TEXT NOT NULL DEFAULT 'USPS',
    "trackingNumber" TEXT NOT NULL,
    "mailClass" TEXT,
    "status" "public"."ShipmentStatus" NOT NULL DEFAULT 'LABEL_CREATED',
    "statusDetail" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "recipientName" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zipcode" TEXT NOT NULL,
    "labelSource" TEXT NOT NULL DEFAULT 'EXTERNAL',
    "labelPdf" BYTEA,
    "postage" DECIMAL(10,2),
    "weightOz" DECIMAL(8,2),
    "note" TEXT,
    "shippedEmailSentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."shipment_notifications" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "trigger" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_trackingNumber_key" ON "public"."shipments"("trackingNumber");

-- CreateIndex
CREATE INDEX "shipments_userId_idx" ON "public"."shipments"("userId");

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "public"."shipments"("status");

-- CreateIndex
CREATE INDEX "shipment_notifications_shipmentId_idx" ON "public"."shipment_notifications"("shipmentId");

-- AddForeignKey
ALTER TABLE "public"."shipments" ADD CONSTRAINT "shipments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_notifications" ADD CONSTRAINT "shipment_notifications_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

