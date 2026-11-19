-- Follow-up billing at prescription submit, and a "charge now" left for the patient to pay.
ALTER TABLE "medication_payments" ADD COLUMN "billingAppliedAt" TIMESTAMP(3);
ALTER TABLE "medication_payments" ADD COLUMN "pendingChargeInvoiceId" TEXT;
ALTER TABLE "medication_payments" ADD COLUMN "pendingChargeAmount" DECIMAL(10,2);
ALTER TABLE "medication_payments" ADD COLUMN "pendingChargeReason" TEXT;
