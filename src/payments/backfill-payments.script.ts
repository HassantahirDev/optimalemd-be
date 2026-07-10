/**
 * One-off, idempotent backfill of the unified payment ledger.
 *
 * Reads the existing source tables (Payment, MedicationPayment,
 * SubscriptionTransaction, WelcomeOrder) and upserts mirror rows into
 * PaymentRecord using the SAME idempotency keys as the live dual-write, so:
 *   - re-running is safe (no duplicates),
 *   - live dual-write + backfill never collide.
 *
 * SAFETY: this script READS the source tables and WRITES ONLY to PaymentRecord /
 * PaymentLineItem / MedicationOrder*. It never mutates a source table.
 *
 * Run with:
 *   npx ts-node src/payments/backfill-payments.script.ts
 * (after the migration that creates the ledger tables has been applied).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Channel = 'PLATFORM' | 'POS' | 'INVOICE';
type Category = 'MEDICATION' | 'MEMBERSHIP' | 'APPOINTMENT' | 'SIGNUP' | 'OTHER';
type Billing = 'ONE_TIME' | 'SUBSCRIPTION';
type Status = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';

interface Row {
  where: Record<string, string>; // idempotency (unique stripe id)
  data: any;
}

const round2 = (n: any) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function userExists(userId?: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  return u ? u.id : null;
}

async function upsertRecord(row: Row): Promise<'created' | 'updated' | 'skipped'> {
  const existing = await prisma.paymentRecord.findFirst({
    where: row.where,
    select: { id: true },
  });
  if (existing) {
    await prisma.paymentRecord.update({ where: { id: existing.id }, data: row.data });
    return 'updated';
  }
  await prisma.paymentRecord.create({ data: { ...row.data, ...row.where } });
  return 'created';
}

// --- Source: Payment (consult / appointment) -------------------------------
async function backfillPayments() {
  const rows = await prisma.payment.findMany();
  let created = 0;
  for (const p of rows) {
    if (!p.paymentIntent) continue;
    const appt = await prisma.appointment.findUnique({
      where: { id: p.appointmentId },
      select: { patientId: true },
    });
    const res = await upsertRecord({
      where: { stripePaymentIntentId: p.paymentIntent },
      data: {
        userId: await userExists(appt?.patientId),
        appointmentId: p.appointmentId,
        channel: 'PLATFORM' as Channel,
        category: 'APPOINTMENT' as Category,
        billing: 'ONE_TIME' as Billing,
        amount: round2(p.amount),
        currency: p.currency || 'usd',
        status: p.status as Status,
        paidAt: p.paidAt,
        createdByType: 'system',
        note: 'Backfill: consult payment',
      },
    });
    if (res === 'created') created++;
  }
  console.log(`Payment → PaymentRecord: ${created} created (of ${rows.length})`);
}

// --- Source: MedicationPayment ---------------------------------------------
async function backfillMedicationPayments() {
  const rows = await prisma.medicationPayment.findMany();
  let created = 0;
  for (const m of rows) {
    // Idempotency: prefer paymentIntent, else subscription-less rows are skipped.
    const key = m.paymentIntent
      ? { stripePaymentIntentId: m.paymentIntent }
      : null;
    if (!key) continue;
    const appt = await prisma.appointment.findUnique({
      where: { id: m.appointmentId },
      select: { patientId: true },
    });
    const res = await upsertRecord({
      where: key,
      data: {
        userId: await userExists(appt?.patientId),
        appointmentId: m.appointmentId,
        medicationPaymentId: m.id,
        stripeSubscriptionId: m.stripeSubscriptionId,
        stripeCustomerId: m.stripeCustomerId,
        channel: 'PLATFORM' as Channel,
        category: 'MEDICATION' as Category,
        billing: (m.stripeSubscriptionId ? 'SUBSCRIPTION' : 'ONE_TIME') as Billing,
        amount: round2(m.amount),
        currency: m.currency || 'usd',
        status: m.status as Status,
        paidAt: m.paidAt,
        createdByType: 'system',
        note: 'Backfill: medication payment',
      },
    });
    if (res === 'created') created++;
  }
  console.log(`MedicationPayment → PaymentRecord: ${created} created (of ${rows.length})`);
  console.log(
    'NOTE: medication-order sets are intentionally NOT reconstructed here (no reliable ' +
      'per-order line items historically). Active/past sets accrue from the first live ' +
      'medication payment after go-live.',
  );
}

// --- Source: SubscriptionTransaction (premium membership) ------------------
async function backfillSubscriptionTransactions() {
  const rows = await prisma.subscriptionTransaction.findMany();
  let created = 0;
  for (const s of rows) {
    const res = await upsertRecord({
      where: { stripeInvoiceId: s.stripeInvoiceId },
      data: {
        userId: await userExists(s.userId),
        subscriptionTransactionId: s.id,
        stripePaymentIntentId: s.stripePaymentIntentId,
        stripeSubscriptionId: s.stripeSubscriptionId,
        stripeCustomerId: s.stripeCustomerId,
        channel: 'PLATFORM' as Channel,
        category: 'MEMBERSHIP' as Category,
        billing: 'SUBSCRIPTION' as Billing,
        amount: round2(s.amount),
        currency: s.currency || 'usd',
        status: s.status as Status,
        cardBrand: s.cardBrand,
        cardLast4: s.cardLast4,
        receiptUrl: s.receiptUrl,
        hostedInvoiceUrl: s.invoiceUrl,
        paidAt: s.paidAt,
        createdByType: 'system',
        note: 'Backfill: premium subscription',
      },
    });
    if (res === 'created') created++;
  }
  console.log(`SubscriptionTransaction → PaymentRecord: ${created} created (of ${rows.length})`);
}

// --- Source: WelcomeOrder (signup) -----------------------------------------
async function backfillWelcomeOrders() {
  const rows = await prisma.welcomeOrder.findMany({
    where: { paymentStatus: 'SUCCEEDED' },
  });
  let created = 0;
  for (const w of rows) {
    if (!w.paymentIntentId) continue;
    const res = await upsertRecord({
      where: { stripePaymentIntentId: w.paymentIntentId },
      data: {
        userId: await userExists(w.userId),
        welcomeOrderId: w.id,
        channel: 'PLATFORM' as Channel,
        category: 'SIGNUP' as Category,
        billing: 'ONE_TIME' as Billing,
        amount: round2(w.finalAmount),
        currency: 'usd',
        status: 'SUCCEEDED' as Status,
        paidAt: w.paidAt,
        createdByType: 'system',
        note: `Backfill: signup order ${w.orderNumber}`,
      },
    });
    if (res === 'created') created++;
  }
  console.log(`WelcomeOrder → PaymentRecord: ${created} created (of ${rows.length})`);
}

async function main() {
  console.log('=== Payment ledger backfill (idempotent, read-only on sources) ===');
  await backfillPayments();
  await backfillMedicationPayments();
  await backfillSubscriptionTransactions();
  await backfillWelcomeOrders();

  const total = await prisma.paymentRecord.count();
  console.log(`\nDone. PaymentRecord now holds ${total} rows.`);
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
