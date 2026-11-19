-- Follow-up visits now reuse the patient's live medication subscription instead
-- of starting a second one, so several medication_payments rows can point at the
-- same Stripe subscription.
DROP INDEX "medication_payments_stripeSubscriptionId_key";

CREATE INDEX "medication_payments_stripeSubscriptionId_idx" ON "medication_payments"("stripeSubscriptionId");
