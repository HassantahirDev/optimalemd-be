import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Syncs Stripe → our DB so the payments portal can read fast from Postgres
 * instead of walking Stripe on every request.
 *
 *  - Payment Intents  → PaymentRecord (one row per transaction), userId resolved
 *    by billing email (transactions carry no appointmentId), status/amount/card/
 *    channel/description mirrored.
 *  - Invoices         → matched to their PaymentRecord by amount+time, their
 *    line items written to PaymentLineItem ("what was bought"), plus a category
 *    heuristic from the line descriptions.
 *
 * Idempotent: upserts on the unique Stripe id, so it can run repeatedly / on a
 * cron / from webhooks without creating duplicates.
 */
@Injectable()
export class PaymentSyncService implements OnModuleInit {
  private readonly logger = new Logger(PaymentSyncService.name);
  private readonly accounts: { label: 'main' | 'pos'; client: Stripe }[] = [];
  private running = false;

  // Warm recent data shortly after boot (quick, not full — a full sync only
  // runs when triggered from the button).
  onModuleInit() {
    setTimeout(
      () => this.syncAll({ sinceDays: 3 }).catch((e) => this.logger.warn(`[sync] boot sync failed: ${e?.message}`)),
      8000,
    );
  }

  // Quick incremental sync — only the last few days, runs every 30 minutes.
  // Full sync is manual only (the "Full sync" button / POST /payments/sync).
  @Cron('0 */30 * * * *') // every 30 minutes
  async scheduledQuickSync() {
    await this.syncAll({ sinceDays: 3 }).catch((e) => this.logger.warn(`[sync] quick cron failed: ${e?.message}`));
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    const seen = new Set<string>();
    const add = (label: 'main' | 'pos', key?: string) => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      this.accounts.push({ label, client: new Stripe(key, { apiVersion: '2025-10-29.clover' as any }) });
    };
    add('main', this.configService.get<string>('STRIPE_SECRET_KEY'));
    add('pos', this.configService.get<string>('STRIPE_POS_SECRET_KEY'));
  }

  // ---------------------------------------------------------------------------
  // A shared lock guards BOTH the quick and full sync so they never overlap —
  // this is what prevents any line-item race/duplication.
  async syncAll(opts?: { maxPerAccount?: number; sinceDays?: number }) {
    if (this.running) {
      this.logger.warn('[sync] already running — skipping');
      return { skipped: true };
    }
    this.running = true;
    const started = Date.now();
    const mode = opts?.sinceDays ? `quick(${opts.sinceDays}d)` : 'full';
    const sinceEpoch = opts?.sinceDays
      ? Math.floor(Date.now() / 1000) - opts.sinceDays * 86400
      : undefined;
    try {
      let piCount = 0;
      let lineCount = 0;
      for (const acct of this.accounts) {
        const r = await this.syncAccount(acct, opts?.maxPerAccount ?? 5000, sinceEpoch);
        piCount += r.piCount;
        lineCount += r.lineCount;
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      this.logger.log(`[sync:${mode}] done: ${piCount} payments, ${lineCount} line items in ${secs}s`);
      return { payments: piCount, lineItems: lineCount, seconds: Number(secs), mode };
    } finally {
      this.running = false;
    }
  }

  private async syncAccount(
    acct: { label: 'main' | 'pos'; client: Stripe },
    maxPerAccount: number,
    sinceEpoch?: number,
  ) {
    const createdFilter = sinceEpoch ? { created: { gte: sinceEpoch } } : {};

    // 1) Payment intents → PaymentRecord (only recent ones when incremental).
    const pis = await acct.client.paymentIntents
      .list({ limit: 100, expand: ['data.latest_charge', 'data.customer'], ...createdFilter })
      .autoPagingToArray({ limit: maxPerAccount });
    this.logger.log(`[sync:${acct.label}] fetched ${pis.length} payment intents`);

    // Resolve users by billing email in one batch.
    const emailMap = await this.matchUsersByEmail(pis.map((pi) => this.piEmail(pi)));

    let piCount = 0;
    let piErrors = 0;
    for (const pi of pis) {
      try {
      const ch = this.piCharge(pi);
      const email = this.piEmail(pi);
      const userId = email ? emailMap.get(email.toLowerCase())?.id ?? null : null;
      const data = {
        userId,
        channel: (acct.label === 'pos' ? 'POS' : 'PLATFORM') as any,
        category: 'OTHER' as any, // refined during invoice sync
        billing: 'ONE_TIME' as any, // refined to SUBSCRIPTION during invoice sync
        amount: pi.amount / 100,
        currency: pi.currency,
        status: this.piStatus(pi) as any,
        refundedAmount: ch && (ch.amount_refunded || 0) > 0 ? ch.amount_refunded / 100 : null,
        stripeChargeId: ch?.id ?? null,
        stripeCustomerId: this.piCustomerId(pi),
        receiptUrl: ch?.receipt_url ?? null,
        cardBrand: ch?.payment_method_details?.card?.brand ?? null,
        cardLast4: ch?.payment_method_details?.card?.last4 ?? null,
        paymentMethodType: ch?.payment_method_details?.type ?? null,
        description: ch?.description ?? pi.description ?? null,
        billingEmail: email,
        paidAt: pi.status === 'succeeded' ? new Date((ch?.created ?? pi.created) * 1000) : null,
        stripeCreated: new Date(pi.created * 1000),
        createdByType: 'system',
      };

      await this.prisma.paymentRecord.upsert({
        where: { stripePaymentIntentId: pi.id },
        create: { stripePaymentIntentId: pi.id, ...data },
        update: data,
      });
      piCount++;
      } catch (e: any) {
        piErrors++;
        if (piErrors <= 5) this.logger.warn(`[sync:${acct.label}] PI ${pi.id} failed: ${e?.message}`);
      }
    }
    this.logger.log(`[sync:${acct.label}] upserted ${piCount} records (${piErrors} errors)`);

    // 2) Invoices → line items + category, linked EXACTLY via invoice.payments.
    const invoices = await acct.client.invoices
      .list({ limit: 100, expand: ['data.payments'], ...createdFilter })
      .autoPagingToArray({ limit: maxPerAccount });
    this.logger.log(`[sync:${acct.label}] fetched ${invoices.length} invoices`);

    const lineCount = await this.applyInvoiceLineItems(pis, invoices);

    // 3) Reconcile status of our portal-created invoices (fallback for webhooks).
    await this.reconcilePendingInvoices(acct);

    return { piCount, lineCount };
  }

  // Flip our PENDING INVOICE records to paid/cancelled by checking Stripe —
  // a safety net so status updates even if the payment webhook isn't delivered.
  private async reconcilePendingInvoices(acct: { label: 'main' | 'pos'; client: Stripe }) {
    const pending = await this.prisma.paymentRecord.findMany({
      where: { channel: 'INVOICE' as any, status: 'PENDING' as any, stripeInvoiceId: { not: null } },
      select: { id: true, stripeInvoiceId: true },
    });
    for (const rec of pending) {
      try {
        const inv = await acct.client.invoices.retrieve(rec.stripeInvoiceId!);
        const status =
          inv.status === 'paid'
            ? 'SUCCEEDED'
            : inv.status === 'void' || inv.status === 'uncollectible'
            ? 'CANCELLED'
            : null;
        if (status) {
          await this.prisma.paymentRecord.update({
            where: { id: rec.id },
            data: { status: status as any, paidAt: status === 'SUCCEEDED' ? new Date() : null },
          });
        }
      } catch {
        // invoice may live on the other account — ignore
      }
    }
  }

  // Link invoice line items to the EXACT paying payment intent via
  // `invoice.payments[].payment.payment_intent` (the only reliable link in the
  // clover API). 100% precise — no amount/time/customer guessing.
  private async applyInvoiceLineItems(
    pis: Stripe.PaymentIntent[],
    invoices: Stripe.Invoice[],
  ): Promise<number> {
    // Build an exact map: paying PaymentIntent id → { lines, category, sub info }.
    const byPI = new Map<
      string,
      {
        lines: { description: string; quantity: number; unitAmount: number; isSubscription: boolean }[];
        isSubscription: boolean;
        subscriptionId: string | null;
        hostedInvoiceUrl: string | null;
      }
    >();

    for (const inv of invoices as any[]) {
      const lines = (inv.lines?.data || []).map((l: any) => ({
        description: l.description || l.price?.nickname || l.plan?.nickname || 'Item',
        quantity: l.quantity || 1,
        unitAmount: (l.amount || 0) / 100 / (l.quantity || 1),
        // recurring vs one-time is a PER-LINE property (each line has its own price)
        isSubscription: !!(l.price?.recurring || l.plan),
      }));
      if (!lines.length) continue;

      const l0 = inv.lines?.data?.[0];
      const subscriptionId =
        inv.subscription ||
        l0?.subscription ||
        l0?.parent?.subscription_item_details?.subscription ||
        null;
      const isSubscription = /subscription/.test(inv.billing_reason || '') || !!subscriptionId;
      const hostedInvoiceUrl = inv.hosted_invoice_url || null;

      // Attach the invoice's line items to EVERY payment intent Stripe links to
      // it via invoice.payments — paid (succeeded) AND open (incomplete) — so a
      // payment that was attempted but not completed still shows what it was for.
      // (Failed retries of an already-paid invoice aren't listed by Stripe, so
      // they can't be linked; the succeeded sibling shows the items.)
      for (const ip of inv.payments?.data || []) {
        const piId = ip.payment?.payment_intent;
        if (piId) byPI.set(piId, { lines, isSubscription, subscriptionId, hostedInvoiceUrl });
      }
    }

    // RELIABILITY: line items may ONLY come from an exact Stripe invoice link.
    // Bulk-clear items from every processed payment that Stripe does NOT link to
    // an invoice (unreliable retries, or residue from the old heuristic), so a
    // row shows a breakdown only when we're 100% certain of it.
    const unlinkedPIs = pis.map((p) => p.id).filter((id) => id && !byPI.has(id));
    if (unlinkedPIs.length) {
      const recs = await this.prisma.paymentRecord.findMany({
        where: { stripePaymentIntentId: { in: unlinkedPIs } },
        select: { id: true },
      });
      const ids = recs.map((r) => r.id);
      if (ids.length) {
        await this.prisma.paymentLineItem.deleteMany({ where: { paymentRecordId: { in: ids } } });
      }
    }

    let lineCount = 0;
    for (const pi of pis) {
      const match = byPI.get(pi.id);
      if (!match) continue; // no exact Stripe invoice link → no items (cleared above)
      try {
        const rec = await this.prisma.paymentRecord.findUnique({
          where: { stripePaymentIntentId: pi.id },
          select: { id: true },
        });
        if (!rec) continue;

        // Replace this record's line items (idempotent).
        await this.prisma.paymentLineItem.deleteMany({ where: { paymentRecordId: rec.id } });
        await this.prisma.paymentLineItem.createMany({
          data: match.lines.map((li) => ({
            paymentRecordId: rec.id,
            description: li.description,
            quantity: li.quantity,
            unitAmount: li.unitAmount,
            isSubscription: li.isSubscription,
          })),
        });
        lineCount += match.lines.length;

        await this.prisma.paymentRecord.update({
          where: { id: rec.id },
          data: {
            category: this.guessCategory(match.lines.map((l) => l.description)) as any,
            billing: (match.isSubscription ? 'SUBSCRIPTION' : 'ONE_TIME') as any,
            stripeSubscriptionId: match.subscriptionId ?? undefined,
            hostedInvoiceUrl: match.hostedInvoiceUrl ?? undefined,
          },
        });
      } catch (e: any) {
        this.logger.warn(`[sync] line-item write failed for ${pi.id}: ${e?.message}`);
      }
    }
    return lineCount;
  }

  private guessCategory(descriptions: string[]): string {
    const text = descriptions.join(' ').toLowerCase();
    if (/member|subscription|plan/.test(text)) return 'MEMBERSHIP';
    if (/supply|mg|ml|tablet|capsule|injection|cypionate|therapy|dhea|thyroid|omega|peptide/.test(text))
      return 'MEDICATION';
    return 'OTHER';
  }

  // --- helpers (shared shape with the portal read service) -------------------
  private piCharge(pi: Stripe.PaymentIntent): Stripe.Charge | null {
    const ch = pi.latest_charge;
    return ch && typeof ch === 'object' ? (ch as Stripe.Charge) : null;
  }
  private piCustomerId(pi: Stripe.PaymentIntent): string | null {
    const c = pi.customer;
    return typeof c === 'string' ? c : c && typeof c === 'object' ? c.id : null;
  }
  private piEmail(pi: Stripe.PaymentIntent): string | null {
    if (pi.receipt_email) return pi.receipt_email;
    const ch = this.piCharge(pi);
    if (ch?.billing_details?.email) return ch.billing_details.email;
    const c = pi.customer;
    if (c && typeof c === 'object' && !('deleted' in c && c.deleted)) return (c as Stripe.Customer).email || null;
    return null;
  }
  private piStatus(pi: Stripe.PaymentIntent): string {
    const ch = this.piCharge(pi);
    if (ch) {
      if ((ch as any).disputed) return 'DISPUTED';
      if ((ch.amount_refunded || 0) > 0) return 'REFUNDED';
      if (ch.status === 'succeeded') return pi.status === 'requires_capture' ? 'UNCAPTURED' : 'SUCCEEDED';
      if (ch.status === 'failed') return 'FAILED';
      if (ch.status === 'pending') return 'PENDING';
    }
    if (pi.status === 'canceled') return 'CANCELLED';
    if (pi.status === 'requires_capture') return 'UNCAPTURED';
    return 'INCOMPLETE';
  }

  private async matchUsersByEmail(emails: (string | null)[]) {
    const map = new Map<string, { id: string }>();
    const lowered = Array.from(new Set(emails.filter(Boolean).map((e) => (e as string).toLowerCase())));
    if (!lowered.length) return map;
    const users = await this.prisma.user.findMany({
      where: { OR: [{ primaryEmail: { in: lowered } }, { email: { in: lowered } }] },
      select: { id: true, primaryEmail: true, email: true },
    });
    for (const u of users) {
      for (const e of [u.primaryEmail, u.email]) if (e) map.set(e.toLowerCase(), { id: u.id });
    }
    return map;
  }
}
