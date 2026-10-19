import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Combined per-patient view of the OLD payment flows, read straight from their
 * original source tables (never migrated / backfilled):
 *   - appointments : consult payments      → `Payment` (via Appointment.patientId)
 *   - signup       : welcome/signup orders → `WelcomeOrder`
 *   - membership   : monthly premium       → `SubscriptionTransaction`
 *
 * Mirrors `MedicationsCombinedService`: the old records keep rendering from their
 * own tables while new payments live in the ledger. Every item is flagged
 * `alsoInLedger` (matched by Stripe payment-intent id) so the UI can show old-flow
 * context WITHOUT ever listing or counting the same charge twice.
 */
@Injectable()
export class PaymentFlowsCombinedService {
  constructor(private readonly prisma: PrismaService) {}

  async getCombined(
    userId: string,
    emails: string[],
    ledgerIntentIds: Set<string>,
  ) {
    const [appts, welcome, membership] = await Promise.all([
      this.prisma.payment.findMany({
        where: { appointment: { patientId: userId } },
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          paymentIntent: true,
          paidAt: true,
          createdAt: true,
          appointmentId: true,
          appointment: {
            select: { appointmentDate: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.welcomeOrder.findMany({
        where: {
          OR: [{ userId }, ...(emails.length ? [{ email: { in: emails } }] : [])],
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.subscriptionTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const inLedger = (intent?: string | null) =>
      !!intent && ledgerIntentIds.has(intent);

    return {
      appointments: appts.map((p) => ({
        id: p.id,
        appointmentId: p.appointmentId,
        appointmentDate: p.appointment?.appointmentDate
          ? p.appointment.appointmentDate.toISOString()
          : null,
        appointmentStatus: p.appointment?.status || null,
        amount: Number(p.amount),
        currency: p.currency,
        status: p.status,
        paidAt: p.paidAt ? p.paidAt.toISOString() : null,
        date: (p.paidAt || p.createdAt).toISOString(),
        alsoInLedger: inLedger(p.paymentIntent),
      })),
      signup: welcome.map((w) => ({
        id: w.id,
        orderNumber: w.orderNumber,
        total: Number(w.totalAmount),
        discount: Number(w.discountAmount),
        final: Number(w.finalAmount),
        status: w.paymentStatus,
        paidAt: w.paidAt ? w.paidAt.toISOString() : null,
        date: (w.paidAt || w.createdAt).toISOString(),
        alsoInLedger: inLedger(w.paymentIntentId),
      })),
      membership: membership.map((s) => ({
        id: s.id,
        amount: Number(s.amount),
        currency: s.currency,
        status: s.status,
        periodStart: s.periodStart ? s.periodStart.toISOString() : null,
        periodEnd: s.periodEnd ? s.periodEnd.toISOString() : null,
        cardBrand: s.cardBrand,
        cardLast4: s.cardLast4,
        paidAt: s.paidAt ? s.paidAt.toISOString() : null,
        date: (s.paidAt || s.createdAt).toISOString(),
        alsoInLedger: inLedger(s.stripePaymentIntentId),
      })),
    };
  }
}
