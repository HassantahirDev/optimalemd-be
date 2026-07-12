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

      // Fields refreshed on every sync: money, status, card, receipt, links.
      // NOTE: channel/category/description are deliberately NOT here — those are
      // the record's "type", owned by whoever created it.
      const common = {
        userId,
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
        billingEmail: email,
        paidAt: pi.status === 'succeeded' ? new Date((ch?.created ?? pi.created) * 1000) : null,
        stripeCreated: new Date(pi.created * 1000),
      };

      const existing = await this.prisma.paymentRecord.findUnique({
        where: { stripePaymentIntentId: pi.id },
        select: { id: true },
      });

      if (existing) {
        // Already in our DB — created by an app flow (portal invoice, POS,
        // premium, medication, signup…) OR a previous import. KEEP its type:
        // never overwrite channel/category/description/createdByType here.
        await this.prisma.paymentRecord.update({ where: { id: existing.id }, data: common });
      } else {
        // New to us: it never originated in our app → imported from Stripe.
        await this.prisma.paymentRecord.create({
          data: {
            stripePaymentIntentId: pi.id,
            ...common,
            channel: 'IMPORTED' as any,
            category: 'OTHER' as any,
            billing: 'ONE_TIME' as any,
            description: ch?.description ?? pi.description ?? null,
            createdByType: 'system',
          },
        });
      }
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

  // Flip our not-yet-settled INVOICE records to paid/cancelled by checking Stripe
  // — a safety net so status updates even if the payment webhook isn't delivered.
  // Covers PENDING (placeholder) AND INCOMPLETE (promoted charge whose PI hadn't
  // been paid when first synced) — the latter is what left paid invoices stuck.
  private async reconcilePendingInvoices(acct: { label: 'main' | 'pos'; client: Stripe }) {
    const pending = await this.prisma.paymentRecord.findMany({
      where: {
        channel: 'INVOICE' as any,
        status: { in: ['PENDING', 'INCOMPLETE', 'UNCAPTURED'] as any },
        stripeInvoiceId: { not: null },
      },
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
        lines: { description: string; quantity: number; unitAmount: number; isSubscription: boolean; category: string | null }[];
        isSubscription: boolean;
        subscriptionId: string | null;
        invoiceId: string | null;
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
        // Per-line category the invoice builder stamped as metadata (100% for our
        // portal invoices); null → resolved from the existing row / a guess below.
        category: (l.metadata?.formamd_line_category as string) || null,
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
        if (piId) byPI.set(piId, { lines, isSubscription, subscriptionId, invoiceId: inv.id || null, hostedInvoiceUrl });
      }
    }

    // Which of these invoices/subscriptions came from OUR portal's "send invoice"
    // flow? The invoicing service writes an INVOICE-channel row for each at
    // creation time — its presence is the reliable "portal-created" signal. We use
    // it to (a) label the charge as an Online Invoice and (b) drop the empty
    // placeholder so there is exactly ONE row per payment.
    const invIds = Array.from(new Set(Array.from(byPI.values()).map((m) => m.invoiceId).filter((x): x is string => !!x)));
    const subIds = Array.from(new Set(Array.from(byPI.values()).map((m) => m.subscriptionId).filter((x): x is string => !!x)));
    const portalByInvoice = new Map<string, string>(); // invoiceId → staff-picked category
    const portalBySub = new Map<string, string>(); // subscriptionId → staff-picked category
    if (invIds.length || subIds.length) {
      const invoiceRows = await this.prisma.paymentRecord.findMany({
        where: {
          channel: 'INVOICE' as any,
          OR: [
            ...(invIds.length ? [{ stripeInvoiceId: { in: invIds } }] : []),
            ...(subIds.length ? [{ stripeSubscriptionId: { in: subIds } }] : []),
          ],
        },
        select: { stripeInvoiceId: true, stripeSubscriptionId: true, category: true },
      });
      for (const r of invoiceRows) {
        if (r.stripeInvoiceId) portalByInvoice.set(r.stripeInvoiceId, r.category as any);
        if (r.stripeSubscriptionId) portalBySub.set(r.stripeSubscriptionId, r.category as any);
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
          select: { id: true, channel: true },
        });
        if (!rec) continue;

        // Preserve any per-line category already stored (e.g. written by the
        // invoice builder) before we replace the rows, so re-syncing never loses
        // the staff-assigned tag when the Stripe line carries no metadata.
        const prevItems = await this.prisma.paymentLineItem.findMany({
          where: { paymentRecordId: rec.id },
          select: { description: true, category: true },
        });
        const prevCat = new Map(prevItems.map((p) => [p.description, p.category as string]));

        // Replace this record's line items (idempotent). Category resolution:
        // Stripe line metadata → previously stored → name-based guess.
        await this.prisma.paymentLineItem.deleteMany({ where: { paymentRecordId: rec.id } });
        await this.prisma.paymentLineItem.createMany({
          data: match.lines.map((li) => ({
            paymentRecordId: rec.id,
            description: li.description,
            quantity: li.quantity,
            unitAmount: li.unitAmount,
            isSubscription: li.isSubscription,
            category: (li.category || prevCat.get(li.description) || this.guessCategory([li.description])) as any,
          })),
        });
        lineCount += match.lines.length;

        // The description always carries the item names.
        const itemDesc = match.lines.map((l) => l.description).filter(Boolean).join(', ') || undefined;

        // Portal "send invoice" payment? Then this charge IS the Online Invoice
        // (channel INVOICE). Promote this real charge row to the single canonical
        // record and delete the empty PENDING placeholder the invoicing service
        // wrote at creation time.
        const portalCategory =
          (match.invoiceId && portalByInvoice.get(match.invoiceId)) ||
          (match.subscriptionId && portalBySub.get(match.subscriptionId)) ||
          null;
        const isPortalInvoice = !!portalCategory;

        if (isPortalInvoice) {
          // Free the unique invoiceId held by the placeholder before we claim it.
          await this.prisma.paymentRecord.deleteMany({
            where: {
              id: { not: rec.id },
              channel: 'INVOICE' as any,
              stripePaymentIntentId: null,
              OR: [
                ...(match.invoiceId ? [{ stripeInvoiceId: match.invoiceId }] : []),
                ...(match.subscriptionId
                  ? [{ stripeSubscriptionId: match.subscriptionId, stripeInvoiceId: null }]
                  : []),
              ],
            },
          });
          await this.prisma.paymentRecord.update({
            where: { id: rec.id },
            data: {
              channel: 'INVOICE' as any,
              category: portalCategory as any,
              billing: (match.isSubscription ? 'SUBSCRIPTION' : 'ONE_TIME') as any,
              stripeSubscriptionId: match.subscriptionId ?? undefined,
              stripeInvoiceId: match.invoiceId ?? undefined,
              hostedInvoiceUrl: match.hostedInvoiceUrl ?? undefined,
              description: itemDesc,
            },
          });
        } else if (rec.channel === 'IMPORTED') {
          // Imported from Stripe: refine its guessed category/billing from the
          // invoice, and set the item-name description.
          await this.prisma.paymentRecord.update({
            where: { id: rec.id },
            data: {
              category: this.guessCategory(match.lines.map((l) => l.description)) as any,
              billing: (match.isSubscription ? 'SUBSCRIPTION' : 'ONE_TIME') as any,
              stripeSubscriptionId: match.subscriptionId ?? undefined,
              hostedInvoiceUrl: match.hostedInvoiceUrl ?? undefined,
              description: itemDesc,
            },
          });
        } else {
          // App-created (PLATFORM / POS / etc.): KEEP its type. Only enrich the
          // description with item names + the invoice link.
          await this.prisma.paymentRecord.update({
            where: { id: rec.id },
            data: {
              hostedInvoiceUrl: match.hostedInvoiceUrl ?? undefined,
              description: itemDesc,
            },
          });
        }
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
