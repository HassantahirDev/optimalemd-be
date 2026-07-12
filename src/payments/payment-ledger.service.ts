import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  LedgerLineItemInput,
  UpsertPaymentInput,
} from './dto/ledger.types';

/**
 * PaymentLedgerService — the single dual-write helper for the unified payment
 * ledger (Part A) and the set-based medication-order lifecycle (Part B, PDF).
 *
 * GUIDING PRINCIPLE (non-negotiable): this is a DERIVED/MIRROR layer.
 *  - It only ever WRITES to `PaymentRecord`, `PaymentLineItem`, `MedicationOrder`
 *    and `MedicationOrderItem`.
 *  - It only READS from source tables (never writes them).
 *  - It must NEVER throw into the caller's flow — a ledger failure can never
 *    break a real payment/webhook. Every public method is wrapped defensively.
 */
@Injectable()
export class PaymentLedgerService {
  private readonly logger = new Logger(PaymentLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Public: idempotent upsert of one payment event across any channel.
  // Idempotency key = the strongest unique Stripe id present
  // (paymentIntent > invoice > charge). Returns the PaymentRecord id, or null.
  // ---------------------------------------------------------------------------
  async upsertFromStripe(input: UpsertPaymentInput): Promise<string | null> {
    try {
      const where = this.buildIdempotencyWhere(input);
      if (!where) {
        this.logger.warn(
          '[ledger] upsert skipped — no unique Stripe id (paymentIntent/invoice/charge) present',
        );
        return null;
      }

      // FK safety: only link a user that actually exists (relation is SetNull).
      const userId = await this.resolveUserId(input.userId);

      const scalar = {
        userId,
        appointmentId: input.appointmentId ?? null,
        medicationPaymentId: input.medicationPaymentId ?? null,
        welcomeOrderId: input.welcomeOrderId ?? null,
        subscriptionTransactionId: input.subscriptionTransactionId ?? null,

        channel: input.channel as any,
        category: input.category as any,
        billing: (input.billing ?? 'ONE_TIME') as any,

        amount: this.round2(input.amount),
        currency: input.currency ?? 'usd',
        status: input.status as any,
        refundedAmount:
          input.refundedAmount != null ? this.round2(input.refundedAmount) : null,

        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
        stripeInvoiceId: input.stripeInvoiceId ?? null,
        stripeChargeId: input.stripeChargeId ?? null,
        stripeSubscriptionId: input.stripeSubscriptionId ?? null,
        stripeCustomerId: input.stripeCustomerId ?? null,
        receiptUrl: input.receiptUrl ?? null,
        hostedInvoiceUrl: input.hostedInvoiceUrl ?? null,

        cardBrand: input.cardBrand ?? null,
        cardLast4: input.cardLast4 ?? null,

        createdByType: input.createdByType ?? 'system',
        createdById: input.createdById ?? null,
        note: input.note ?? null,
        paidAt: input.paidAt ?? (input.status === 'SUCCEEDED' ? new Date() : null),
      };

      const existing = await this.prisma.paymentRecord.findFirst({
        where,
        select: { id: true },
      });

      let recordId: string;
      if (existing) {
        await this.prisma.paymentRecord.update({
          where: { id: existing.id },
          data: scalar,
        });
        recordId = existing.id;
        // Line items are only written on first create to avoid duplication.
      } else {
        const created = await this.prisma.paymentRecord.create({
          data: {
            ...scalar,
            lineItems: input.lineItems?.length
              ? { create: input.lineItems.map((li) => this.lineItemData(li)) }
              : undefined,
          },
          select: { id: true },
        });
        recordId = created.id;
      }

      // Medication lifecycle runs only for SUCCEEDED medication payments tied to
      // a real user (POS walk-ins with no account are skipped).
      if (
        input.category === 'MEDICATION' &&
        input.status === 'SUCCEEDED' &&
        userId
      ) {
        await this.runMedicationLifecycle({
          paymentRecordId: recordId,
          userId,
          billing: input.billing ?? 'ONE_TIME',
          paidAt: input.paidAt ?? new Date(),
          stripeSubscriptionId: input.stripeSubscriptionId ?? null,
          items: (input.lineItems ?? []).map((li) => ({
            medicationId: li.medicationId ?? null,
            medicationName: li.description,
            quantity: li.quantity ?? 1,
            dosageSnapshot: li.dosageSnapshot ?? null,
          })),
        });
      }

      return recordId;
    } catch (err: any) {
      this.logger.error(`[ledger] upsertFromStripe failed: ${err?.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public: mark a record refunded (charge.refunded webhook). Idempotent.
  // ---------------------------------------------------------------------------
  async markRefunded(
    keys: { stripeChargeId?: string | null; stripePaymentIntentId?: string | null },
    refundedAmount?: number | null,
  ): Promise<void> {
    try {
      const where = keys.stripeChargeId
        ? { stripeChargeId: keys.stripeChargeId }
        : keys.stripePaymentIntentId
        ? { stripePaymentIntentId: keys.stripePaymentIntentId }
        : null;
      if (!where) return;

      const rec = await this.prisma.paymentRecord.findFirst({
        where,
        select: { id: true },
      });
      if (!rec) return;

      await this.prisma.paymentRecord.update({
        where: { id: rec.id },
        data: {
          status: 'REFUNDED' as any,
          refundedAmount: refundedAmount != null ? this.round2(refundedAmount) : undefined,
        },
      });
    } catch (err: any) {
      this.logger.error(`[ledger] markRefunded failed: ${err?.message}`);
    }
  }

  // ===========================================================================
  // Medication order lifecycle (SET/ORDER based — per the client PDF)
  // ---------------------------------------------------------------------------
  // The latest paid medication order defines the current ACTIVE set. When a new
  // set is paid, the whole previous ACTIVE set flips to PAST (endedAt=now) and
  // the new order becomes ACTIVE (startedAt=paidAt). A subscription that simply
  // renews the SAME set keeps its ACTIVE order (startedAt holds).
  // ===========================================================================
  private async runMedicationLifecycle(params: {
    paymentRecordId: string;
    userId: string;
    billing: 'ONE_TIME' | 'SUBSCRIPTION';
    paidAt: Date;
    stripeSubscriptionId?: string | null;
    items: {
      medicationId?: string | null;
      medicationName: string;
      quantity?: number;
      dosageSnapshot?: string | null;
    }[];
  }): Promise<void> {
    const { paymentRecordId, userId, billing, paidAt, stripeSubscriptionId, items } = params;
    try {
      // Idempotency: if we already created an order for this paying record, stop.
      const already = await this.prisma.medicationOrder.findFirst({
        where: { sourcePaymentRecordId: paymentRecordId },
        select: { id: true },
      });
      if (already) return;

      const medItems = (items ?? []).filter((li) => li.medicationId || li.medicationName);
      if (!medItems.length) return; // nothing to build a set from

      const subId = stripeSubscriptionId ?? null;

      // Subscription renewal of the SAME set → keep the existing ACTIVE order.
      if (billing === 'SUBSCRIPTION' && subId) {
        const renewing = await this.prisma.medicationOrder.findFirst({
          where: { userId, status: 'ACTIVE' as any, stripeSubscriptionId: subId },
          select: { id: true },
        });
        if (renewing) {
          await this.prisma.medicationOrder.update({
            where: { id: renewing.id },
            data: { sourcePaymentRecordId: paymentRecordId, updatedAt: new Date() },
          });
          return;
        }
      }

      // New/different order supersedes the current ACTIVE set.
      await this.prisma.medicationOrder.updateMany({
        where: { userId, status: 'ACTIVE' as any },
        data: { status: 'PAST' as any, endedAt: paidAt },
      });

      await this.prisma.medicationOrder.create({
        data: {
          userId,
          status: 'ACTIVE' as any,
          startedAt: paidAt,
          billing: billing as any,
          sourcePaymentRecordId: paymentRecordId,
          stripeSubscriptionId: subId,
          items: {
            create: medItems.map((li) => ({
              medicationId: li.medicationId ?? null,
              medicationName: li.medicationName,
              quantity: li.quantity ?? 1,
              dosageSnapshot: li.dosageSnapshot ?? null,
            })),
          },
        },
      });
    } catch (err: any) {
      this.logger.error(`[ledger] runMedicationLifecycle failed: ${err?.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Public: transition an INVOICE record when its Stripe invoice is paid/failed
  // (Part D webhook). Uses the line items already stored on the PENDING record,
  // so the medication lifecycle runs without re-passing them.
  // ---------------------------------------------------------------------------
  async markInvoiceStatus(
    stripeInvoiceId: string,
    status: 'SUCCEEDED' | 'FAILED',
    opts?: { paidAt?: Date | null; receiptUrl?: string | null },
  ): Promise<string | null> {
    try {
      const rec = await this.prisma.paymentRecord.findFirst({
        where: { stripeInvoiceId },
        include: { lineItems: true },
      });
      if (!rec) return null;

      await this.prisma.paymentRecord.update({
        where: { id: rec.id },
        data: {
          status: status as any,
          paidAt: status === 'SUCCEEDED' ? opts?.paidAt ?? new Date() : rec.paidAt,
          receiptUrl: opts?.receiptUrl ?? rec.receiptUrl,
        },
      });

      if (status === 'SUCCEEDED' && rec.category === 'MEDICATION' && rec.userId) {
        await this.runMedicationLifecycle({
          paymentRecordId: rec.id,
          userId: rec.userId,
          billing: (rec.billing as any) ?? 'ONE_TIME',
          paidAt: opts?.paidAt ?? new Date(),
          stripeSubscriptionId: rec.stripeSubscriptionId,
          items: (rec.lineItems ?? []).map((li: any) => ({
            medicationId: li.medicationId,
            medicationName: li.description,
            quantity: li.quantity,
            dosageSnapshot: null,
          })),
        });
      }

      return rec.id;
    } catch (err: any) {
      this.logger.error(`[ledger] markInvoiceStatus failed: ${err?.message}`);
      return null;
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================
  private buildIdempotencyWhere(input: UpsertPaymentInput) {
    if (input.stripePaymentIntentId) {
      return { stripePaymentIntentId: input.stripePaymentIntentId };
    }
    if (input.stripeInvoiceId) {
      return { stripeInvoiceId: input.stripeInvoiceId };
    }
    if (input.stripeChargeId) {
      return { stripeChargeId: input.stripeChargeId };
    }
    return null;
  }

  private async resolveUserId(userId?: string | null): Promise<string | null> {
    if (!userId) return null;
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return u ? u.id : null;
  }

  private lineItemData(li: LedgerLineItemInput) {
    return {
      description: li.description,
      stripePriceId: li.stripePriceId ?? null,
      medicationId: li.medicationId ?? null,
      quantity: li.quantity ?? 1,
      unitAmount: this.round2(li.unitAmount),
      isSubscription: li.isSubscription ?? false,
      category: (li.category ?? 'OTHER') as any,
    };
  }

  private round2(n: number): number {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }
}
