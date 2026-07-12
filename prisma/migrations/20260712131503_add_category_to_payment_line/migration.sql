-- AlterTable
ALTER TABLE "public"."payment_line_items" ADD COLUMN     "category" "public"."PaymentCategory" NOT NULL DEFAULT 'OTHER';
