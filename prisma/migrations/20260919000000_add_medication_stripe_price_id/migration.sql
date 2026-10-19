-- Explicit link from a medication to the Stripe price it is billed from.
-- Nullable and additive: existing rows keep working with no Stripe link.
ALTER TABLE "medications" ADD COLUMN IF NOT EXISTS "stripePriceId" TEXT;

-- Looked up by price id when reconciling Stripe -> catalogue.
CREATE INDEX IF NOT EXISTS "medications_stripePriceId_idx" ON "medications"("stripePriceId");
