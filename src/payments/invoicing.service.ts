import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { LedgerCategory } from './dto/ledger.types';

export interface OneTimeItemInput {
  priceId?: string; // catalog price
  description?: string; // custom line
  unitAmount?: number; // dollars (custom)
  quantity?: number;
}
export interface RecurringItemInput {
  priceId: string; // catalog recurring price
  quantity?: number;
}

export interface CreateInvoiceInput {
  userId?: string | null;
  email?: string | null;
  oneTimeItems?: OneTimeItemInput[];
  recurringItems?: RecurringItemInput[];
  collectionMethod?: 'send_invoice' | 'charge_automatically';
  paymentMethodId?: string | null; // saved card to charge (charge_automatically)
  daysUntilDue?: number;
  note?: string;
  category?: LedgerCategory;
}

/**
 * Invoicing — creates REAL Stripe invoices/subscriptions from the payments
 * portal (Stripe emails the hosted invoice, exactly like the dashboard).
 *  - one-time items → a Stripe invoice.
 *  - recurring items → a real Stripe subscription.
 *  - delivery: email the pay-link (send_invoice) OR charge the saved card
 *    immediately (charge_automatically).
 * Immediately mirrors the result into the ledger so it shows in the portal.
 */
@Injectable()
export class InvoicingService {
  private readonly logger = new Logger(InvoicingService.name);
  private stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ledger: PaymentLedgerService,
  ) {
    const key = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    this.stripe = new Stripe(key, { apiVersion: '2025-10-29.clover' as any });
  }

  // ---------------------------------------------------------------------------
  // Product catalog (one-time + recurring) for the invoice builder.
  // ---------------------------------------------------------------------------
  async getCatalog() {
    const [oneTime, recurring] = await Promise.all([
      this.stripe.prices.list({ active: true, type: 'one_time', expand: ['data.product'], limit: 100 }),
      this.stripe.prices.list({ active: true, type: 'recurring', expand: ['data.product'], limit: 100 }),
    ]);
    const map = (p: Stripe.Price) => {
      const product = p.product as Stripe.Product;
      return {
        priceId: p.id,
        productId: product?.id,
        name: product?.name || 'Product',
        amount: p.unit_amount != null ? p.unit_amount / 100 : null,
        currency: p.currency,
        interval: p.recurring?.interval || null,
      };
    };
    return {
      oneTime: oneTime.data.filter((p) => (p.product as any)?.active !== false).map(map),
      recurring: recurring.data.filter((p) => (p.product as any)?.active !== false).map(map),
    };
  }

  // ---------------------------------------------------------------------------
  // Billing context for a patient: saved cards + previous purchases to repeat.
  // ---------------------------------------------------------------------------
  async getBillingContext(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, primaryEmail: true, email: true, firstName: true, lastName: true, stripeCustomerId: true },
    });
    if (!user) throw new BadRequestException('Patient not found');

    const emails = Array.from(
      new Set([user.primaryEmail, user.email].filter(Boolean).map((e) => (e as string).toLowerCase())),
    );

    const customerId = await this.resolveCustomerId(user.stripeCustomerId, emails);

    let cards: any[] = [];
    let defaultCardId: string | null = null;
    if (customerId) {
      try {
        const [pms, cust] = await Promise.all([
          this.stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 20 }),
          this.stripe.customers.retrieve(customerId),
        ]);
        defaultCardId =
          !('deleted' in cust) && cust.invoice_settings?.default_payment_method
            ? (typeof cust.invoice_settings.default_payment_method === 'string'
                ? cust.invoice_settings.default_payment_method
                : cust.invoice_settings.default_payment_method.id)
            : null;
        cards = pms.data.map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand,
          last4: pm.card?.last4,
          expMonth: pm.card?.exp_month,
          expYear: pm.card?.exp_year,
          isDefault: pm.id === defaultCardId,
        }));
        if (!defaultCardId && cards[0]) defaultCardId = cards[0].id;
      } catch (e: any) {
        this.logger.warn(`[invoicing] billing-context cards failed: ${e?.message}`);
      }
    }

    // Previous purchases (from the synced ledger) with their line items — repeatable.
    const previous = await this.prisma.paymentRecord.findMany({
      where: { OR: [{ userId }, { billingEmail: { in: emails } }] },
      orderBy: [{ stripeCreated: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      include: { lineItems: true },
    });

    return {
      customerId,
      email: user.primaryEmail || user.email,
      hasSavedCard: cards.length > 0,
      cards,
      defaultCardId,
      previous: previous.map((p) => ({
        id: p.id,
        date: (p.stripeCreated || p.createdAt).toISOString(),
        amount: Number(p.amount),
        status: p.status,
        description: p.description || p.note,
        billing: p.billing,
        items: (p.lineItems || []).map((li) => ({
          description: li.description,
          quantity: li.quantity,
          unitAmount: Number(li.unitAmount),
        })),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Create + send / charge.
  // ---------------------------------------------------------------------------
  async createInvoice(input: CreateInvoiceInput) {
    const oneTime = (input.oneTimeItems || []).filter(
      (i) => i.priceId || (i.description && (i.unitAmount || 0) > 0),
    );
    const recurring = (input.recurringItems || []).filter((i) => i.priceId);
    if (!oneTime.length && !recurring.length) {
      throw new BadRequestException('Select at least one product or line item');
    }

    const collectionMethod = input.collectionMethod || 'send_invoice';
    const category = input.category || (recurring.length ? 'MEMBERSHIP' : 'OTHER');

    // Resolve recipient + customer.
    let email = input.email?.trim() || null;
    let userId = input.userId || null;
    let recipientName: string | undefined;
    let existingCustomerId: string | null = null;
    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { primaryEmail: true, email: true, firstName: true, lastName: true, stripeCustomerId: true },
      });
      if (!user) throw new BadRequestException('Patient not found');
      email = user.primaryEmail || user.email || email;
      existingCustomerId = user.stripeCustomerId || null;
      recipientName = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
    }
    if (!email) throw new BadRequestException('A recipient email (or a linked patient) is required');

    let customerId = existingCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email,
        name: recipientName,
        metadata: { formamd_user_id: userId || '' },
      });
      customerId = customer.id;
    }

    // For charge_automatically, resolve a card and set it as default.
    let paymentMethodId = input.paymentMethodId || null;
    if (collectionMethod === 'charge_automatically') {
      if (!paymentMethodId) {
        const pms = await this.stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
        paymentMethodId = pms.data[0]?.id || null;
      }
      if (!paymentMethodId) {
        throw new BadRequestException('This patient has no saved card to charge. Use "Email invoice" instead.');
      }
      await this.stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    const metadata = { formamd_category: category, formamd_user_id: userId || '' };
    const daysUntilDue = input.daysUntilDue ?? 7;

    let invoiceId: string | undefined;
    let hostedInvoiceUrl: string | null = null;
    let subscriptionId: string | undefined;
    let total = 0;
    let stripeStatus = '';
    let invoiceLines: any[] = []; // captured from the finalized Stripe invoice

    if (recurring.length) {
      // ----- Subscription path (real recurring billing) -----
      const sub = await this.stripe.subscriptions.create({
        customer: customerId,
        items: recurring.map((r) => ({ price: r.priceId, quantity: r.quantity || 1 })),
        add_invoice_items: oneTime
          .filter((i) => i.priceId)
          .map((i) => ({ price: i.priceId!, quantity: i.quantity || 1 })),
        collection_method: collectionMethod,
        ...(collectionMethod === 'send_invoice'
          ? { days_until_due: daysUntilDue }
          : { default_payment_method: paymentMethodId!, payment_behavior: 'allow_incomplete' as any }),
        metadata,
        expand: ['latest_invoice'],
      });
      subscriptionId = sub.id;
      const inv = sub.latest_invoice as Stripe.Invoice | null;
      if (inv) {
        invoiceId = inv.id;
        hostedInvoiceUrl = inv.hosted_invoice_url || null;
        total = (inv.amount_due ?? inv.total ?? 0) / 100;
        stripeStatus = inv.status || '';
        invoiceLines = inv.lines?.data || [];
        if (collectionMethod === 'send_invoice' && inv.id && inv.status !== 'paid') {
          try {
            if (inv.status === 'draft') await this.stripe.invoices.finalizeInvoice(inv.id);
            const sent = await this.stripe.invoices.sendInvoice(inv.id);
            hostedInvoiceUrl = (sent as any).hosted_invoice_url || hostedInvoiceUrl;
          } catch (e: any) {
            this.logger.warn(`[invoicing] send subscription invoice failed: ${e?.message}`);
          }
        }
      }
    } else {
      // ----- One-time invoice path -----
      const invoice = await this.stripe.invoices.create({
        customer: customerId,
        collection_method: collectionMethod,
        ...(collectionMethod === 'send_invoice' ? { days_until_due: daysUntilDue } : {}),
        auto_advance: collectionMethod === 'charge_automatically',
        description: input.note || undefined,
        metadata,
      });
      invoiceId = invoice.id;
      if (!invoiceId) throw new BadRequestException('Stripe did not return an invoice id');

      for (const item of oneTime) {
        const qty = item.quantity && item.quantity > 0 ? item.quantity : 1;
        if (item.priceId) {
          await this.stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoiceId,
            pricing: { price: item.priceId },
            quantity: qty,
          } as any);
        } else {
          const amountCents = Math.round((item.unitAmount || 0) * qty * 100);
          await this.stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoiceId,
            amount: amountCents,
            currency: 'usd',
            description: item.description || 'Item',
          });
        }
      }

      const finalized = await this.stripe.invoices.finalizeInvoice(invoiceId);
      total = (finalized.amount_due ?? finalized.total ?? 0) / 100;
      invoiceLines = finalized.lines?.data || [];
      if (collectionMethod === 'charge_automatically') {
        const paid = await this.stripe.invoices.pay(invoiceId).catch((e) => {
          this.logger.warn(`[invoicing] auto-charge failed: ${e?.message}`);
          return finalized;
        });
        hostedInvoiceUrl = (paid as any).hosted_invoice_url || null;
        stripeStatus = (paid as any).status || '';
      } else {
        const sent = await this.stripe.invoices.sendInvoice(invoiceId);
        hostedInvoiceUrl = (sent as any).hosted_invoice_url || null;
        stripeStatus = (sent as any).status || '';
      }
    }

    // Mirror into the ledger immediately (sync/webhook reconciles on payment).
    // The description carries the product/item names right away — the "Online
    // Invoice" tag already conveys that it was emailed, so no "Emailed invoice".
    const itemNames = invoiceLines
      .map((l: any) => l.description || l.price?.nickname || l.plan?.nickname)
      .filter(Boolean)
      .join(', ');
    const paid = stripeStatus === 'paid';
    await this.ledger.upsertFromStripe({
      stripeInvoiceId: invoiceId || null,
      stripeSubscriptionId: subscriptionId || null,
      stripeCustomerId: customerId,
      userId,
      channel: 'INVOICE',
      category,
      billing: recurring.length ? 'SUBSCRIPTION' : 'ONE_TIME',
      amount: total,
      currency: 'usd',
      status: paid ? 'SUCCEEDED' : 'PENDING',
      hostedInvoiceUrl,
      note: itemNames || input.note || (recurring.length ? 'Subscription invoice' : 'Emailed invoice'),
      createdByType: 'payment_user',
      paidAt: paid ? new Date() : null,
      lineItems: invoiceLines.map((l: any) => ({
        description: l.description || l.price?.nickname || l.plan?.nickname || 'Item',
        quantity: l.quantity || 1,
        unitAmount: (l.amount || 0) / 100 / (l.quantity || 1),
        isSubscription: !!(l.price?.recurring || l.plan),
      })),
    });

    this.logger.log(
      `[invoicing] ${recurring.length ? 'subscription' : 'invoice'} ${invoiceId} (${collectionMethod}) → ${email} $${total.toFixed(2)}`,
    );

    return {
      invoiceId,
      subscriptionId: subscriptionId || null,
      hostedInvoiceUrl,
      status: stripeStatus,
      charged: paid,
      amount: total,
      email,
    };
  }

  // Back-compat wrapper for the old signature.
  async createAndSendInvoice(input: any) {
    return this.createInvoice({
      userId: input.userId,
      email: input.email,
      oneTimeItems: (input.items || []).map((i: any) => ({
        description: i.description,
        unitAmount: i.unitAmount,
        quantity: i.quantity,
      })),
      collectionMethod: 'send_invoice',
      note: input.note,
      category: input.category,
      daysUntilDue: input.daysUntilDue,
    });
  }

  // ---------------------------------------------------------------------------
  private async resolveCustomerId(stripeCustomerId: string | null, emails: string[]): Promise<string | null> {
    if (stripeCustomerId) return stripeCustomerId;
    for (const email of emails) {
      const res = await this.stripe.customers.list({ email, limit: 1 });
      if (res.data[0]) return res.data[0].id;
    }
    return null;
  }
}
