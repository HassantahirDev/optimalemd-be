import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { MedicationsCombinedService } from './medications-combined.service';
import { PaymentFlowsCombinedService } from './payment-flows-combined.service';

const STATUS_MAP: Record<string, string> = {
  succeeded: 'SUCCEEDED',
  paid: 'SUCCEEDED',
  pending: 'PENDING',
  open: 'PENDING',
  draft: 'PENDING',
  failed: 'FAILED',
  canceled: 'CANCELLED',
  uncollectible: 'FAILED',
  void: 'CANCELLED',
};

/**
 * Payments portal reads. The LISTS (transactions/subscriptions/invoices) are
 * fetched LIVE from Stripe — the source of truth — across BOTH Stripe accounts
 * (main platform + in-clinic POS terminal), then enriched with our PaymentRecord
 * ledger for patient linking and our category/channel. The ledger keeps being
 * dual-written in the background; these reads never depend on it being complete.
 */
@Injectable()
export class PaymentsPortalService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsPortalService.name);

  // Warm the overview cache at boot so the first user load is instant.
  onModuleInit() {
    this.refreshOverviewInBackground();
  }
  private readonly stripeAccounts: { label: 'main' | 'pos'; client: Stripe }[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly medsCombined: MedicationsCombinedService,
    private readonly flowsCombined: PaymentFlowsCombinedService,
  ) {
    const mainKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    const posKey = this.configService.get<string>('STRIPE_POS_SECRET_KEY');

    // Only register DISTINCT Stripe accounts. If the POS key is the same account
    // as the platform key (common setup), querying both would return every
    // charge twice — so we dedupe by key here.
    const seenKeys = new Set<string>();
    const register = (label: 'main' | 'pos', key?: string) => {
      if (!key || seenKeys.has(key)) return;
      seenKeys.add(key);
      this.stripeAccounts.push({
        label,
        client: new Stripe(key, { apiVersion: '2025-10-29.clover' as any }),
      });
    };
    register('main', mainKey);
    register('pos', posKey);
  }

  // ---------------------------------------------------------------------------
  // Ledger enrichment: given a set of Stripe ids, return a lookup of our
  // PaymentRecord data (patient, category, channel) keyed by every stripe id.
  // ---------------------------------------------------------------------------
  private async buildLedgerIndex(ids: {
    paymentIntentIds?: string[];
    chargeIds?: string[];
    invoiceIds?: string[];
    subscriptionIds?: string[];
  }) {
    const or: any[] = [];
    if (ids.paymentIntentIds?.length) or.push({ stripePaymentIntentId: { in: ids.paymentIntentIds } });
    if (ids.chargeIds?.length) or.push({ stripeChargeId: { in: ids.chargeIds } });
    if (ids.invoiceIds?.length) or.push({ stripeInvoiceId: { in: ids.invoiceIds } });
    if (ids.subscriptionIds?.length) or.push({ stripeSubscriptionId: { in: ids.subscriptionIds } });

    const index = new Map<string, any>();
    if (!or.length) return index;

    const records = await this.prisma.paymentRecord.findMany({
      where: { OR: or },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, primaryEmail: true, patientId: true } },
      },
    });
    for (const r of records) {
      const enrich = {
        category: r.category,
        channel: r.channel,
        billing: r.billing,
        user: r.user,
        note: r.note,
        ledgerId: r.id,
      };
      for (const key of [
        r.stripePaymentIntentId,
        r.stripeChargeId,
        r.stripeInvoiceId,
        r.stripeSubscriptionId,
      ]) {
        if (key && !index.has(key)) index.set(key, enrich);
      }
    }
    return index;
  }

  private enrichmentFor(index: Map<string, any>, ...keys: (string | null | undefined)[]) {
    for (const k of keys) {
      if (k && index.has(k)) return index.get(k);
    }
    return null;
  }

  // Best available email for a charge: billing details, receipt, then the
  // expanded customer object.
  private chargeEmail(charge: Stripe.Charge): string | null {
    if (charge.billing_details?.email) return charge.billing_details.email;
    if (charge.receipt_email) return charge.receipt_email;
    const c = charge.customer;
    if (c && typeof c === 'object' && !('deleted' in c && c.deleted)) {
      return (c as Stripe.Customer).email || null;
    }
    return null;
  }

  // --- Payment Intent helpers (portal lists PIs to match the Stripe dashboard) ---
  private piCharge(pi: Stripe.PaymentIntent): Stripe.Charge | null {
    const ch = pi.latest_charge;
    return ch && typeof ch === 'object' ? (ch as Stripe.Charge) : null;
  }

  private piEmail(pi: Stripe.PaymentIntent): string | null {
    if (pi.receipt_email) return pi.receipt_email;
    const ch = this.piCharge(pi);
    if (ch?.billing_details?.email) return ch.billing_details.email;
    const c = pi.customer;
    if (c && typeof c === 'object' && !('deleted' in c && c.deleted)) {
      return (c as Stripe.Customer).email || null;
    }
    return null;
  }

  private piCustomerId(pi: Stripe.PaymentIntent): string | null {
    const c = pi.customer;
    return typeof c === 'string' ? c : c && typeof c === 'object' ? c.id : null;
  }

  // Dashboard-aligned status, derived from the latest charge's outcome exactly
  // like the Stripe "Payments" chips (Succeeded / Refunded / Disputed / Failed /
  // Uncaptured), falling back to the PI state when there's no charge.
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
    return 'INCOMPLETE'; // requires_payment_method / requires_confirmation / requires_action / processing
  }

  // Amount actually captured on a succeeded PI, net of refunds (dollars).
  private piNetCaptured(pi: Stripe.PaymentIntent): number {
    if (pi.status !== 'succeeded') return 0;
    const ch = this.piCharge(pi);
    const captured = ch?.amount_captured ?? pi.amount_received ?? pi.amount ?? 0;
    const refunded = ch?.amount_refunded ?? 0;
    return (captured - refunded) / 100;
  }

  // Remove duplicate Stripe objects (by id) in place — belt-and-suspenders in
  // case the same account is registered more than once.
  private dedupeById<T>(arr: T[], idOf: (item: T) => string): void {
    const seen = new Set<string>();
    let write = 0;
    for (let read = 0; read < arr.length; read++) {
      const id = idOf(arr[read]);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      arr[write++] = arr[read];
    }
    arr.length = write;
  }

  // Match Stripe billing emails against our patient accounts (fallback link when
  // the ledger has no record). Returns a lookup keyed by lowercased email.
  private async matchUsersByEmail(emails: (string | null | undefined)[]) {
    const map = new Map<string, any>();
    const lowered = Array.from(
      new Set(emails.filter(Boolean).map((e) => (e as string).toLowerCase())),
    );
    if (!lowered.length) return map;

    // Query on both raw and lowercased variants to tolerate mixed-case storage.
    const candidates = Array.from(new Set([...lowered]));
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { primaryEmail: { in: candidates } },
          { email: { in: candidates } },
        ],
      },
      select: { id: true, firstName: true, lastName: true, primaryEmail: true, email: true, patientId: true },
    });
    for (const u of users) {
      for (const e of [u.primaryEmail, u.email]) {
        if (e) map.set(e.toLowerCase(), u);
      }
    }
    return map;
  }

  // Overview is expensive (it walks every Stripe charge), so we cache it and
  // serve stale-while-revalidate: fresh cache → instant; stale cache → return
  // immediately AND refresh in the background; no cache → compute once.
  private overviewCache: { at: number; data: any } | null = null;
  private overviewRefreshing = false;
  private readonly OVERVIEW_TTL_MS = 60_000;

  async getOverview() {
    if (this.overviewCache) {
      const age = Date.now() - this.overviewCache.at;
      if (age > this.OVERVIEW_TTL_MS) this.refreshOverviewInBackground();
      return this.overviewCache.data;
    }
    const data = await this.computeOverview();
    this.overviewCache = { at: Date.now(), data };
    return data;
  }

  private refreshOverviewInBackground() {
    if (this.overviewRefreshing) return;
    this.overviewRefreshing = true;
    this.computeOverview()
      .then((data) => {
        this.overviewCache = { at: Date.now(), data };
      })
      .catch((e: any) => this.logger.warn(`[portal] overview refresh failed: ${e?.message}`))
      .finally(() => {
        this.overviewRefreshing = false;
      });
  }

  // Headline KPIs — computed from the SYNCED DB (fast). Numbers stay aligned to
  // Stripe because the sync mirrors Stripe's dashboard status buckets.
  private async computeOverview() {
    // All channels count — the sync dedupes every payment to a single row (an
    // online invoice's charge is ONE record, not an invoice + a charge), so there
    // is no double-counting to guard against.
    const [byStatus, byCategory, byChannel, capturedAgg, refundAgg] = await Promise.all([
      this.prisma.paymentRecord.groupBy({ by: ['status'], _count: { _all: true } } as any),
      this.prisma.paymentRecord.groupBy({
        by: ['category'],
        _count: { _all: true },
        _sum: { amount: true },
      } as any),
      this.prisma.paymentRecord.groupBy({ by: ['channel'], _count: { _all: true } } as any),
      this.prisma.paymentRecord.aggregate({
        where: { status: { in: ['SUCCEEDED', 'REFUNDED', 'DISPUTED'] as any } },
        _sum: { amount: true },
      }),
      this.prisma.paymentRecord.aggregate({
        where: { status: 'REFUNDED' as any },
        _sum: { refundedAmount: true },
      }),
    ]);

    const sc: Record<string, number> = {};
    let total = 0;
    for (const g of byStatus as any[]) {
      sc[g.status] = g._count._all;
      total += g._count._all;
    }
    const grossRevenue =
      Number(capturedAgg._sum.amount || 0) - Number(refundAgg._sum.refundedAmount || 0);

    return {
      counts: {
        total,
        succeeded: sc.SUCCEEDED || 0,
        refunded: sc.REFUNDED || 0,
        disputed: sc.DISPUTED || 0,
        failed: sc.FAILED || 0,
        uncaptured: sc.UNCAPTURED || 0,
        incomplete: (sc.INCOMPLETE || 0) + (sc.PENDING || 0),
        cancelled: sc.CANCELLED || 0,
        pending: (sc.INCOMPLETE || 0) + (sc.PENDING || 0),
      },
      grossRevenue: Math.round(grossRevenue * 100) / 100,
      byCategory: (byCategory as any[]).map((c) => ({
        category: c.category,
        _count: { _all: c._count._all },
        _sum: { amount: Number(c._sum.amount || 0) },
      })),
      byChannel: (byChannel as any[]).map((c) => ({
        channel: c.channel,
        _count: { _all: c._count._all },
      })),
      live: false,
    };
  }

  // How many recent charges to pull per Stripe account for the live feed.
  private readonly STRIPE_FETCH_LIMIT = 100;
  // Upper bound for the transactions list autopagination (per account).
  private readonly LIST_MAX_CHARGES = 1000;
  // Upper bound for the overview's full-history autopagination (per account).
  private readonly OVERVIEW_MAX_CHARGES = 5000;

  // Paginated, filterable transaction feed — served from the SYNCED DB.
  async listTransactions(params: {
    channel?: string;
    category?: string;
    status?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));

    const where: any = {};
    // One unified feed: platform self-checkout, in-clinic POS, AND online (staff)
    // invoices all live here. Payments are deduped to one row each by the sync, so
    // nothing double-counts. Filter by channel only when explicitly requested.
    if (params.channel) where.channel = params.channel;
    if (params.category) where.category = params.category;
    if (params.status) where.status = params.status;
    if (params.search) {
      const q = params.search.trim();
      where.OR = [
        { description: { contains: q, mode: 'insensitive' } },
        { billingEmail: { contains: q, mode: 'insensitive' } },
        { stripePaymentIntentId: { contains: q, mode: 'insensitive' } },
        { stripeChargeId: { contains: q, mode: 'insensitive' } },
        { user: { is: { firstName: { contains: q, mode: 'insensitive' } } } },
        { user: { is: { lastName: { contains: q, mode: 'insensitive' } } } },
        { user: { is: { primaryEmail: { contains: q, mode: 'insensitive' } } } },
      ];
    }

    const [records, total] = await Promise.all([
      this.prisma.paymentRecord.findMany({
        where,
        orderBy: [{ stripeCreated: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, primaryEmail: true, patientId: true } },
        },
      }),
      this.prisma.paymentRecord.count({ where }),
    ]);

    return {
      rows: records.map((r) => this.recordToRow(r)),
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
      live: false,
    };
  }

  // Map a stored PaymentRecord to the row shape the frontend expects.
  private recordToRow(r: any) {
    return {
      id: r.stripePaymentIntentId || r.id,
      createdAt: (r.stripeCreated || r.createdAt).toISOString(),
      amount: Number(r.amount),
      currency: r.currency,
      status: r.status,
      category: r.category === 'OTHER' ? null : r.category,
      channel: r.channel,
      billing: r.billing,
      user: r.user || null,
      external: !r.userId,
      description: r.description || r.note || null,
      paymentMethodType: r.paymentMethodType,
      cardBrand: r.cardBrand,
      cardLast4: r.cardLast4,
      receiptUrl: r.receiptUrl,
      billingEmail: r.billingEmail,
      stripePaymentIntentId: r.stripePaymentIntentId,
      stripeChargeId: r.stripeChargeId,
    };
  }

  // Subscriptions — from the SYNCED DB: one row per subscription-billed payment
  // record (grouped by Stripe subscription), most recent first.
  async listSubscriptions(params: { status?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));

    const where: any = { billing: 'SUBSCRIPTION', stripeSubscriptionId: { not: null } };
    if (params.status) where.status = params.status;

    // Distinct by subscription id — show the latest charge per subscription.
    const records = await this.prisma.paymentRecord.findMany({
      where,
      orderBy: [{ stripeCreated: 'desc' }, { createdAt: 'desc' }],
      distinct: ['stripeSubscriptionId'],
      include: {
        user: { select: { id: true, firstName: true, lastName: true, primaryEmail: true } },
      },
    });

    const rows = records.map((r) => ({
      id: r.stripeSubscriptionId || r.id,
      createdAt: (r.stripeCreated || r.createdAt).toISOString(),
      status: r.status,
      amount: Number(r.amount),
      currency: r.currency,
      category: r.category === 'OTHER' ? 'MEMBERSHIP' : r.category,
      channel: r.channel,
      user: r.user || null,
      external: !r.userId,
      billingEmail: r.billingEmail,
    }));

    const total = rows.length;
    const start = (page - 1) * pageSize;
    return {
      rows: rows.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
      live: false,
    };
  }

  // Emailed/platform invoices — the invoices we created/sent (channel INVOICE).
  async listInvoices() {
    const records = await this.prisma.paymentRecord.findMany({
      where: { channel: 'INVOICE' },
      orderBy: [{ stripeCreated: 'desc' }, { createdAt: 'desc' }],
      include: {
        user: { select: { id: true, firstName: true, lastName: true, primaryEmail: true } },
      },
    });

    return records.map((r) => ({
      id: r.stripeInvoiceId || r.id,
      createdAt: (r.stripeCreated || r.createdAt).toISOString(),
      amount: Number(r.amount),
      amountPaid: r.status === 'SUCCEEDED' ? Number(r.amount) : 0,
      currency: r.currency,
      status: r.status,
      hostedInvoiceUrl: r.hostedInvoiceUrl,
      category: r.category === 'OTHER' ? null : r.category,
      channel: r.channel,
      user: r.user || null,
      external: !r.userId,
      customerEmail: r.billingEmail,
      note: r.description || r.note,
    }));
  }

  // Search our own patients (for attaching an invoice to a real account).
  async searchPatients(q: string) {
    const query = (q || '').trim();
    if (query.length < 2) return [];
    return this.prisma.user.findMany({
      where: {
        OR: [
          { firstName: { contains: query, mode: 'insensitive' } },
          { lastName: { contains: query, mode: 'insensitive' } },
          { primaryEmail: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
          { patientId: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: 10,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        primaryEmail: true,
        email: true,
        patientId: true,
      },
    });
  }

  // Everything for one patient — pulled LIVE from Stripe (by their email /
  // linked customer) so it matches the rest of the portal, plus combined
  // active/past medications.
  async getPatientHistory(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        primaryEmail: true,
        email: true,
        patientId: true,
        stripeCustomerId: true,
      },
    });

    const combinedMeds = await this.medsCombined.getCombined(userId);
    if (!user) {
      return {
        user: null,
        payments: [],
        subscriptions: [],
        invoices: [],
        lifetimePaid: 0,
        combinedMedications: combinedMeds,
        paymentFlows: { appointments: [], signup: [], membership: [] },
      };
    }

    const emails = Array.from(
      new Set([user.primaryEmail, user.email].filter(Boolean).map((e) => (e as string).toLowerCase())),
    );

    // Everything for this patient from the SYNCED DB (fast). Matched by our
    // userId OR the billing email captured during sync (covers guest checkouts).
    const records = await this.prisma.paymentRecord.findMany({
      where: { OR: [{ userId }, { billingEmail: { in: emails } }] },
      orderBy: [{ stripeCreated: 'desc' }, { createdAt: 'desc' }],
      include: { lineItems: true },
    });

    // Transactions (actual charges) vs invoices — separated so nothing double-counts.
    const txnRecords = records.filter((r) => r.channel !== 'INVOICE');
    const invoiceRecords = records.filter((r) => r.channel === 'INVOICE');

    const catOrNull = (c: any) => (c === 'OTHER' ? null : c);
    const mapItems = (lineItems: any[]) =>
      (lineItems || []).map((li: any) => ({
        description: li.description,
        quantity: li.quantity,
        amount: Number(li.unitAmount) * li.quantity,
        isSubscription: li.isSubscription,
        category: catOrNull(li.category),
      }));

    let lifetimePaid = 0;
    // Payment history = the COMPLETE ledger for this patient (every channel, every
    // status). One row per payment (deduped by the sync), so nothing double-counts.
    const payments = records.map((r) => {
      if (['SUCCEEDED', 'REFUNDED', 'DISPUTED'].includes(r.status as any)) {
        lifetimePaid += Number(r.amount) - Number(r.refundedAmount || 0);
      }
      return {
        id: r.stripePaymentIntentId || r.stripeInvoiceId || r.id,
        createdAt: (r.stripeCreated || r.createdAt).toISOString(),
        amount: Number(r.amount),
        currency: r.currency,
        status: r.status,
        category: catOrNull(r.category),
        channel: r.channel,
        cardBrand: r.cardBrand,
        cardLast4: r.cardLast4,
        paymentMethodType: r.paymentMethodType,
        receiptUrl: r.receiptUrl,
        description: r.description || r.note || null,
        items: mapItems(r.lineItems),
      };
    });

    // Subscriptions: the patient's ACTUAL Stripe subscription objects.
    const subscriptions = await this.fetchPatientSubscriptions(user.stripeCustomerId, emails);

    // Invoices = EVERY Stripe invoice for this patient (so subscription-renewal
    // invoices show too, not only portal "send invoice" ones). Each is enriched
    // from our ledger by invoice id, so a portal invoice's category + status stay
    // consistent with the Transactions view.
    const invoicesLive = await this.fetchPatientInvoices(user.stripeCustomerId, emails);
    const ledgerByInvoice = new Map(
      invoiceRecords
        .filter((r) => r.stripeInvoiceId)
        .map((r) => [r.stripeInvoiceId as string, r]),
    );
    const enrichInvoice = (iv: any) => {
      const led = ledgerByInvoice.get(iv.id);
      if (!led) return iv; // subscription/external invoice — keep the live Stripe data
      const lineCats = Array.from(
        new Set((led.lineItems || []).map((li: any) => li.category).filter((c: any) => c && c !== 'OTHER')),
      );
      return {
        ...iv,
        status: led.status, // ledger status (updated by webhook/sync) → matches Transactions
        category: catOrNull(led.category),
        categories: lineCats.length ? lineCats : catOrNull(led.category) ? [led.category] : iv.categories || [],
        items: mapItems(led.lineItems),
        source: 'PLATFORM', // matched a portal INVOICE ledger row → definitely ours
      };
    };
    const invoicesOut = invoicesLive.length
      ? invoicesLive.map(enrichInvoice)
      : invoiceRecords.map((r) => {
          const lineCats = Array.from(
            new Set((r.lineItems || []).map((li: any) => li.category).filter((c: any) => c && c !== 'OTHER')),
          );
          return {
            id: r.stripeInvoiceId || r.id,
            number: null,
            createdAt: (r.stripeCreated || r.createdAt).toISOString(),
            amount: Number(r.amount),
            amountPaid: r.status === 'SUCCEEDED' ? Number(r.amount) : 0,
            currency: r.currency,
            status: r.status,
            hostedInvoiceUrl: r.hostedInvoiceUrl,
            category: catOrNull(r.category),
            categories: lineCats.length ? lineCats : catOrNull(r.category) ? [r.category] : [],
            items: mapItems(r.lineItems),
          };
        });

    // Old payment flows (appointment consult, signup order, premium membership)
    // read from their own source tables — deduped against the synced ledger by
    // Stripe payment-intent so a charge is never shown or counted twice.
    const ledgerIntentIds = new Set(
      txnRecords
        .map((r) => r.stripePaymentIntentId)
        .filter((id): id is string => !!id),
    );
    const paymentFlows = await this.flowsCombined.getCombined(
      userId,
      emails,
      ledgerIntentIds,
    );

    return {
      user,
      payments,
      subscriptions,
      invoices: invoicesOut,
      lifetimePaid: Math.round(lifetimePaid * 100) / 100,
      combinedMedications: combinedMeds,
      paymentFlows,
    };
  }

  // Cached Stripe product-name lookup (product ids repeat across patients).
  private productNameCache = new Map<string, string>();
  private async productName(client: Stripe, id: string): Promise<string | null> {
    if (this.productNameCache.has(id)) return this.productNameCache.get(id)!;
    try {
      const p = await client.products.retrieve(id);
      const name = (p as any).name || id;
      this.productNameCache.set(id, name);
      return name;
    } catch {
      return null;
    }
  }

  // Resolve this patient's Stripe customer(s) across accounts.
  private async resolvePatientCustomers(stripeCustomerId: string | null, emails: string[]) {
    const customers: { client: Stripe; id: string }[] = [];
    const seen = new Set<string>();
    for (const acct of this.stripeAccounts) {
      try {
        for (const email of emails) {
          const res = await acct.client.customers.list({ email, limit: 100 });
          for (const c of res.data) {
            const k = `${acct.label}:${c.id}`;
            if (!seen.has(k)) { seen.add(k); customers.push({ client: acct.client, id: c.id }); }
          }
        }
        if (stripeCustomerId) {
          const k = `${acct.label}:${stripeCustomerId}`;
          if (!seen.has(k)) { seen.add(k); customers.push({ client: acct.client, id: stripeCustomerId }); }
        }
      } catch (e: any) {
        this.logger.warn(`[portal] resolve customers failed: ${e?.message}`);
      }
    }
    return customers;
  }

  // Read-only: the patient's actual Stripe SUBSCRIPTIONS — recurring items only,
  // with the true recurring amount, products, renewal date and Stripe status.
  private async fetchPatientSubscriptions(stripeCustomerId: string | null, emails: string[]) {
    const customers = await this.resolvePatientCustomers(stripeCustomerId, emails);
    const out: any[] = [];
    const seen = new Set<string>();
    for (const cust of customers) {
      try {
        // NOTE: expand only to price (data.items.data.price = 4 levels, the max).
        // Product names are resolved separately via a cache.
        const list = await cust.client.subscriptions
          .list({
            customer: cust.id,
            status: 'all',
            limit: 100,
            expand: ['data.items.data.price', 'data.latest_invoice'],
          })
          .autoPagingToArray({ limit: 100 });
        for (const sub of list as any[]) {
          if (!sub.id || seen.has(sub.id)) continue;
          seen.add(sub.id);
          const items = await Promise.all(
            (sub.items?.data || []).map(async (it: any) => {
              const productId = typeof it.price?.product === 'string' ? it.price.product : it.price?.product?.id;
              const name =
                (typeof it.price?.product === 'object' && it.price.product?.name) ||
                (productId ? await this.productName(cust.client, productId) : null) ||
                it.price?.nickname ||
                'Item';
              return {
                name,
                quantity: it.quantity || 1,
                unitAmount: (it.price?.unit_amount || 0) / 100,
                interval: it.price?.recurring?.interval || 'month',
              };
            }),
          );
          const amount = items.reduce((s: number, i: any) => s + i.unitAmount * i.quantity, 0);

          // In the clover API `current_period_end` moved onto the subscription
          // items; fall back through the possible locations so "Renews/Cancels
          // {date}" always has a value.
          const periodEndEpoch =
            sub.current_period_end ??
            sub.items?.data?.[0]?.current_period_end ??
            (sub.latest_invoice && typeof sub.latest_invoice === 'object'
              ? (sub.latest_invoice as any).period_end
              : null) ??
            null;
          // When set to cancel at period end, Stripe fills `cancel_at` with the
          // exact stop date — use it for the "Cancels {date}" label.
          const cancelAtEpoch = sub.cancel_at ?? (sub.cancel_at_period_end ? periodEndEpoch : null);

          // A send-invoice subscription reports `active` in Stripe even while its
          // first (or a renewal) invoice is still unpaid. Cross-check the latest
          // invoice so we don't show "Active" for something that was never paid.
          const li: any = sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
          const invoiceUnpaid =
            !!li &&
            li.status !== 'paid' &&
            li.status !== 'void' &&
            Number(li.amount_remaining ?? li.amount_due ?? 0) > 0;

          let status: string =
            sub.status === 'active' || sub.status === 'trialing'
              ? 'ACTIVE'
              : sub.status === 'canceled'
              ? 'CANCELLED'
              : sub.status === 'past_due' || sub.status === 'unpaid'
              ? 'PAST_DUE'
              : sub.status === 'incomplete' || sub.status === 'incomplete_expired'
              ? 'INCOMPLETE'
              : (sub.status || 'ACTIVE').toUpperCase();
          // Honest state: created/active but the invoice hasn't actually been paid.
          if (status === 'ACTIVE' && invoiceUnpaid) status = 'UNPAID';

          out.push({
            id: sub.id,
            createdAt: new Date(sub.created * 1000).toISOString(),
            status,
            stripeStatus: sub.status,
            amount,
            currency: sub.currency,
            interval: items[0]?.interval || 'month',
            currentPeriodEnd: periodEndEpoch ? new Date(periodEndEpoch * 1000).toISOString() : null,
            cancelAt: cancelAtEpoch ? new Date(cancelAtEpoch * 1000).toISOString() : null,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
            invoiceUnpaid,
            invoiceStatus: li?.status || null,
            hostedInvoiceUrl: li?.hosted_invoice_url || null,
            // The UI shows actions only when we can actually manage it in Stripe.
            canManage: sub.status !== 'canceled' && sub.status !== 'incomplete_expired',
            products: items.map((i: any) => i.name),
            items,
          });
        }
      } catch (e: any) {
        this.logger.warn(`[portal] patient subscriptions.list failed: ${e?.message}`);
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  // Find which Stripe account owns a subscription (main vs POS), so we can manage
  // it without the caller needing to know the account.
  private async findSubscriptionAcct(id: string) {
    for (const acct of this.stripeAccounts) {
      try {
        const sub = await acct.client.subscriptions.retrieve(id);
        if (sub) return { client: acct.client, sub };
      } catch {
        /* not on this account — try the next */
      }
    }
    return null;
  }

  // Cancel a subscription. Default is graceful (stops at period end, reversible);
  // `immediate` ends it now — used for never-paid (incomplete/unpaid) ones.
  async cancelSubscription(id: string, immediate = false) {
    const found = await this.findSubscriptionAcct(id);
    if (!found) throw new NotFoundException('Subscription not found in Stripe');
    if (found.sub.status === 'canceled') {
      return { id, status: 'canceled', cancelAtPeriodEnd: false, alreadyCanceled: true };
    }
    const updated = immediate
      ? await found.client.subscriptions.cancel(id)
      : await found.client.subscriptions.update(id, { cancel_at_period_end: true });
    return {
      id: updated.id,
      status: updated.status,
      cancelAtPeriodEnd: updated.cancel_at_period_end,
      canceledAt: updated.canceled_at ? new Date(updated.canceled_at * 1000).toISOString() : null,
    };
  }

  // Undo a scheduled cancellation (only possible while it hasn't fully ended).
  async reactivateSubscription(id: string) {
    const found = await this.findSubscriptionAcct(id);
    if (!found) throw new NotFoundException('Subscription not found in Stripe');
    if (found.sub.status === 'canceled') {
      throw new BadRequestException(
        'This subscription has already fully canceled and cannot be reactivated — create a new one.',
      );
    }
    const updated = await found.client.subscriptions.update(id, { cancel_at_period_end: false });
    return {
      id: updated.id,
      status: updated.status,
      cancelAtPeriodEnd: updated.cancel_at_period_end,
    };
  }

  // Read-only: every Stripe invoice for this patient (across accounts), for the
  // Invoices tab/tile on the drill-down. Never counted in money totals.
  private async fetchPatientInvoices(stripeCustomerId: string | null, emails: string[]) {
    const customers: { client: Stripe; id: string }[] = [];
    const seenCust = new Set<string>();
    for (const acct of this.stripeAccounts) {
      try {
        for (const email of emails) {
          const res = await acct.client.customers.list({ email, limit: 100 });
          for (const c of res.data) {
            const k = `${acct.label}:${c.id}`;
            if (!seenCust.has(k)) { seenCust.add(k); customers.push({ client: acct.client, id: c.id }); }
          }
        }
        if (stripeCustomerId) {
          const k = `${acct.label}:${stripeCustomerId}`;
          if (!seenCust.has(k)) { seenCust.add(k); customers.push({ client: acct.client, id: stripeCustomerId }); }
        }
      } catch (e: any) {
        this.logger.warn(`[portal] patient invoice customers failed: ${e?.message}`);
      }
    }

    const out: any[] = [];
    const seenInv = new Set<string>();
    for (const cust of customers) {
      try {
        const list = await cust.client.invoices
          .list({ customer: cust.id, limit: 100 })
          .autoPagingToArray({ limit: 300 });
        for (const inv of list as any[]) {
          if (!inv.id || seenInv.has(inv.id)) continue;
          seenInv.add(inv.id);
          const lines = inv.lines?.data || [];
          // Distinct per-line categories (staff tags) → the UI shows all of them.
          const lineCategories: string[] = Array.from(
            new Set(
              lines
                .map((l: any) => l.metadata?.formamd_line_category)
                .filter((c: any): c is string => !!c && c !== 'OTHER'),
            ),
          );
          out.push({
            id: inv.id,
            number: inv.number || null,
            createdAt: new Date(inv.created * 1000).toISOString(),
            amount: (inv.total ?? inv.amount_due ?? 0) / 100,
            amountPaid: (inv.amount_paid ?? 0) / 100,
            currency: inv.currency,
            status: STATUS_MAP[inv.status || 'open'] || 'PENDING',
            hostedInvoiceUrl: inv.hosted_invoice_url || null,
            category: inv.metadata?.formamd_category || null,
            categories: lineCategories.length
              ? lineCategories
              : inv.metadata?.formamd_category && inv.metadata.formamd_category !== 'OTHER'
              ? [inv.metadata.formamd_category]
              : [],
            // Origin: created/sent from our portal (carries our metadata) vs made
            // directly in Stripe (dashboard or an auto subscription-renewal invoice).
            source: (inv.metadata?.formamd_category || inv.metadata?.formamd_user_id) ? 'PLATFORM' : 'STRIPE',
            items: lines.map((l: any) => ({
              description: l.description || l.price?.nickname || l.plan?.nickname || 'Item',
              quantity: l.quantity || 1,
              amount: (l.amount || 0) / 100,
            })),
          });
        }
      } catch (e: any) {
        this.logger.warn(`[portal] patient invoices.list failed: ${e?.message}`);
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }
}
