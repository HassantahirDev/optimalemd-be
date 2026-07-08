-- AlterTable
ALTER TABLE "public"."PatientDocument" ADD COLUMN     "labOrderId" TEXT;

-- CreateIndex
CREATE INDEX "PatientDocument_labOrderId_idx" ON "public"."PatientDocument"("labOrderId");

-- AddForeignKey
ALTER TABLE "public"."PatientDocument" ADD CONSTRAINT "PatientDocument_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "public"."lab_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
