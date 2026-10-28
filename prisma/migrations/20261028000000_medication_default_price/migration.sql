-- Per-medication default prescription price (takes priority over the linked Stripe
-- price in the doctor's prescribing dialog). Null = unchanged behaviour.

-- AlterTable
ALTER TABLE "public"."medications" ADD COLUMN     "defaultPrice" DECIMAL(10,2);


-- Finasteride Oral Therapy (production row): default price $35.
-- No-op in databases without this row (e.g. staging).
UPDATE "public"."medications" SET "defaultPrice" = 35.00 WHERE "id" = 'ef991981-0026-4ff9-a4f5-6060b13fbf95';
