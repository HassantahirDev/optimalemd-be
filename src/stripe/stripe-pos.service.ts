import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentLedgerService } from '../payments/payment-ledger.service';

type LedgerCategory =
  | 'MEDICATION'
  | 'MEMBERSHIP'
  | 'APPOINTMENT'
  | 'SIGNUP'
  | 'OTHER';

type PosCartItem = {
  priceId?: string;
  productId?: string;
  name?: string;
  defaultAmount?: number | null;
  amount?: number;
  currency?: string;
  interval?: string;
  /** Staff-assigned classification for this product line (obligatory at checkout). */
  category?: LedgerCategory;
};

@Injectable()
export class StripePosService {
  private stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly paymentLedger: PaymentLedgerService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_POS_SECRET_KEY');
    if (!stripeKey) {
      throw new Error(
        'STRIPE_POS_SECRET_KEY is not configured (Stripe Terminal POS)',
      );
    }
    this.stripe = new Stripe(stripeKey, {
      apiVersion: '2025-10-29.clover' as any,
    });
  }

  getStripe(): Stripe {
    return this.stripe;
  }

  async createPaymentIntent(amount: number) {
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
    });

    return {
      ok: true,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    };
  }

  async processPayment(readerId: string, paymentIntentId: string) {
    const reader = await this.stripe.terminal.readers.processPaymentIntent(
      readerId,
      {
        payment_intent: paymentIntentId,
        process_config: {
          enable_customer_cancellation: true,
        },
      },
    );

    return {
      ok: true,
      reader,
    };
  }

  async cancelPayment(readerId: string) {
    const reader = await this.stripe.terminal.readers.cancelAction(readerId);

    return {
      ok: true,
      reader,
    };
  }

  async createCustomer(name: string, email: string) {
    // Dedup: if a customer with this email already exists, reuse it.
    // Email-based lookup so the receptionist can't accidentally create duplicate
    // Stripe profiles for the same patient on follow-up charges.
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (normalizedEmail) {
      const existing = await this.stripe.customers.list({
        email: normalizedEmail,
        limit: 1,
      });
      if (existing.data.length > 0) {
        const found = existing.data[0];
        // Lightly backfill the name if the existing record didn't have one
        if (!found.name && name) {
          await this.stripe.customers.update(found.id, { name });
        }
        return {
          ok: true,
          customerId: found.id,
          reused: true,
        };
      }
    }

    const customer = await this.stripe.customers.create({
      name,
      email: normalizedEmail || email,
    });

    return {
      ok: true,
      customerId: customer.id,
      reused: false,
    };
  }

  async getSetupIntentStatus(setupIntentId: string) {
    const setupIntent = await this.stripe.setupIntents.retrieve(setupIntentId);
    return {
      ok: true,
      id: setupIntent.id,
      status: setupIntent.status,
      lastSetupError: setupIntent.last_setup_error
        ? {
            code: setupIntent.last_setup_error.code,
            message: setupIntent.last_setup_error.message,
          }
        : null,
    };
  }

  async searchCustomers(query: string, limit = 10) {
    const q = (query || '').trim();
    if (!q) {
      return { ok: true, customers: [] as any[] };
    }

    // Stripe's search supports `email:` and `name:` predicates with substring matching via `~`.
    const escaped = q.replace(/"/g, '\\"');
    const search = await this.stripe.customers.search({
      query: `email~"${escaped}" OR name~"${escaped}"`,
      limit,
    });

    return {
      ok: true,
      customers: search.data.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        created: c.created,
      })),
    };
  }

  async saveCardOnReader(readerId: string, customerId: string) {
    const setupIntent = await this.stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card_present'],
    });

    const reader = await this.stripe.terminal.readers.processSetupIntent(
      readerId,
      {
        setup_intent: setupIntent.id,
        allow_redisplay: 'always',
      },
    );

    return {
      ok: true,
      setupIntentId: setupIntent.id,
      reader,
    };
  }

  async createMembershipSubscription(body: {
    customerId: string;
    setupIntentId: string;
    oneTimeItems?: PosCartItem[];
    subscriptionItems?: PosCartItem[];
    userId?: string | null; // optional link to a real patient (Part C)
  }) {
    const {
      customerId,
      setupIntentId,
      oneTimeItems: rawOneTimeItems = [],
      subscriptionItems: rawSubscriptionItems = [],
      userId = null,
    } = body;

    if (rawOneTimeItems.length === 0 && rawSubscriptionItems.length === 0) {
      return {
        ok: false,
        error: 'No cart items were provided.',
        statusCode: 400,
      };
    }

    // Reclassify every item against its ACTUAL Stripe Price type — never trust which
    // cart section (one-time vs. subscription) the frontend happened to add it to. A
    // recurring-priced item put in the wrong bucket used to get charged as a flat
    // one-time fee with no subscription created at all, instead of billing monthly —
    // this is the guarantee that a subscription item always bills monthly and a
    // one-time item only ever bills once, no matter which section it was added from.
    // Only items backed by a real saved priceId can be checked this way; a pure
    // custom-priced item (price_data, no priceId) has no Stripe object to check
    // against, so its cart-section placement is trusted as the only signal of intent.
    const { oneTimeItems, subscriptionItems } = await this.reclassifyCartItems(
      rawOneTimeItems,
      rawSubscriptionItems,
    );

    const setupIntent = await this.stripe.setupIntents.retrieve(setupIntentId, {
      expand: ['latest_attempt'],
    });

    if (setupIntent.status !== 'succeeded') {
      return {
        ok: false,
        error: `SetupIntent is not ready yet. Current status: ${setupIntent.status}`,
        statusCode: 400,
      };
    }

    const latestAttempt = setupIntent.latest_attempt as Stripe.SetupAttempt | null;
    const generatedCardId =
      latestAttempt &&
      latestAttempt.payment_method_details &&
      (latestAttempt.payment_method_details as any).card_present &&
      (latestAttempt.payment_method_details as any).card_present.generated_card;

    if (!generatedCardId) {
      return {
        ok: false,
        error:
          'No generated_card was created. Try inserting the physical card instead of tapping, or use a supported card.',
        statusCode: 400,
      };
    }

    await this.stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: generatedCardId,
      },
    });

    const subscriptionLineItems = this.buildSubscriptionLineItems(subscriptionItems);
    const oneTimeInvoiceItems = this.buildOneTimeInvoiceItems(oneTimeItems);

    if (oneTimeItems.length > 0 && subscriptionItems.length === 0) {
      const charged = await this.chargeOneTimeOnly(
        customerId,
        generatedCardId,
        oneTimeInvoiceItems,
      );

      // --- Part C: mirror this in-person one-time sale into the ledger ---
      // Record-level category is DERIVED from the staff-assigned per-line tags:
      // if every line shares one category use it, otherwise fall back to
      // MEDICATION (one-time cart) and keep each line's own tag individually.
      await this.paymentLedger.upsertFromStripe({
        stripeInvoiceId: charged.invoiceId,
        stripeCustomerId: customerId,
        userId,
        channel: 'POS',
        category: this.deriveCategory(oneTimeItems, 'MEDICATION'),
        billing: 'ONE_TIME',
        amount: this.sumCartCents(oneTimeItems) / 100,
        currency: 'usd',
        status: charged.status === 'paid' ? 'SUCCEEDED' : 'PENDING',
        paidAt: new Date(),
        createdByType: 'payment_user',
        note: 'In-person POS sale',
        lineItems: this.cartToLineItems(oneTimeItems, false),
      });

      return {
        ok: true,
        generatedCardId,
        subscriptionId: null,
        invoiceId: charged.invoiceId,
        status: charged.status,
      };
    }

    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: subscriptionLineItems,
      add_invoice_items: oneTimeInvoiceItems,
      default_payment_method: generatedCardId,
      payment_behavior: 'error_if_incomplete',
      metadata: {
        created_from: 'local_pos_s710',
      },
      expand: ['latest_invoice'],
    });

    const latestInvoice = subscription.latest_invoice as Stripe.Invoice | null;

    // --- Part C: mirror this in-person subscription into the ledger ---
    // Subscription cart section maps to MEMBERSHIP. Any bundled one-time items
    // are attached as additional line items on the same invoice/charge.
    const subActive =
      subscription.status === 'active' || subscription.status === 'trialing';
    await this.paymentLedger.upsertFromStripe({
      stripeInvoiceId: latestInvoice ? latestInvoice.id : null,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customerId,
      userId,
      channel: 'POS',
      category: this.deriveCategory(
        [...subscriptionItems, ...oneTimeItems],
        'MEMBERSHIP',
      ),
      billing: 'SUBSCRIPTION',
      amount:
        (this.sumCartCents(subscriptionItems) + this.sumCartCents(oneTimeItems)) / 100,
      currency: 'usd',
      status: subActive ? 'SUCCEEDED' : 'PENDING',
      paidAt: subActive ? new Date() : null,
      createdByType: 'payment_user',
      note:
        oneTimeItems.length > 0
          ? 'In-person POS membership (with one-time items)'
          : 'In-person POS membership',
      lineItems: [
        ...this.cartToLineItems(subscriptionItems, true),
        ...this.cartToLineItems(oneTimeItems, false),
      ],
    });

    return {
      ok: true,
      generatedCardId,
      subscriptionId: subscription.id,
      invoiceId: latestInvoice ? latestInvoice.id : null,
      status: subscription.status,
    };
  }

  // Sum a POS cart section's amounts (POS item.amount is in cents).
  private sumCartCents(items: PosCartItem[]): number {
    return items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  }

  // Map POS cart items → ledger line items (unitAmount in dollars), carrying the
  // staff-assigned per-line category through to `PaymentLineItem.category`.
  private cartToLineItems(items: PosCartItem[], isSubscription: boolean) {
    return items.map((i) => ({
      description: i.name || (isSubscription ? 'Subscription item' : 'One-time item'),
      unitAmount: (Number(i.amount) || 0) / 100,
      quantity: 1,
      isSubscription,
      medicationId: null,
      category: (i.category || (isSubscription ? 'MEMBERSHIP' : 'MEDICATION')) as LedgerCategory,
    }));
  }

  // Derive the record-level category from the per-line tags: one distinct tag
  // across all lines → use it; a mixed cart → the section fallback.
  private deriveCategory(items: PosCartItem[], fallback: LedgerCategory): LedgerCategory {
    const distinct = Array.from(
      new Set(items.map((i) => i.category).filter(Boolean) as LedgerCategory[]),
    );
    return distinct.length === 1 ? distinct[0] : fallback;
  }

  // Search our own patients so the cashier can attach an in-person sale to a
  // real account (distinct from the Stripe-customer search for walk-ins).
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

  private async chargeOneTimeOnly(
    customerId: string,
    paymentMethodId: string,
    oneTimeInvoiceItems: Stripe.SubscriptionCreateParams.AddInvoiceItem[],
  ) {
    let itemsCreated = 0;
    for (const line of oneTimeInvoiceItems) {
      if (line.price) {
        await this.stripe.invoiceItems.create({
          customer: customerId,
          pricing: { price: line.price },
        });
        itemsCreated++;
      } else if (line.price_data) {
        await this.stripe.invoiceItems.create({
          customer: customerId,
          price_data: line.price_data as Stripe.InvoiceItemCreateParams.PriceData,
        });
        itemsCreated++;
      }
    }

    // Guard against the exact failure this is fixing: every cart line SHOULD have
    // resolved to a real price above (see buildOneTimeInvoiceItems) — if none did,
    // stop here with a clear error instead of creating and auto-finalizing a $0
    // invoice, which Stripe marks "paid" with nothing actually charged. That used to
    // look identical to a real successful sale.
    if (itemsCreated === 0) {
      throw new Error('No priced items to charge — cart items are missing a valid price.');
    }

    const invoice = await this.stripe.invoices.create({
      customer: customerId,
      default_payment_method: paymentMethodId,
      auto_advance: true,
      collection_method: 'charge_automatically',
      // THE actual root cause of every $0 POS invoice: this API version does not
      // auto-attach a customer's pending invoice items to a new invoice by default —
      // confirmed directly (an item created with a real $25 price, invoice created
      // right after, came back with total: 0 / zero line items until this was added).
      // Every one-time POS charge was affected regardless of which price-selection
      // branch ran above; this was never actually a pricing-logic bug.
      pending_invoice_items_behavior: 'include',
    });

    if (!invoice.id) {
      throw new Error('Invoice creation failed: missing invoice id.');
    }

    const finalized = await this.stripe.invoices.finalizeInvoice(invoice.id);
    const invoiceId = finalized.id ?? invoice.id;

    // Same guard, at the Stripe-authoritative level: if the finalized invoice's total
    // came out $0 despite priced items being sent, something upstream (a $0 price, a
    // missing catalog price) produced a free invoice Stripe auto-marks "paid" without
    // charging anything — surface that as an error rather than a false success.
    if ((finalized.total ?? 0) === 0) {
      throw new Error(
        `Invoice ${invoiceId} finalized with a $0 total — nothing was actually charged. Check the cart items' prices.`,
      );
    }

    const paid =
      finalized.status === 'paid'
        ? finalized
        : await this.stripe.invoices.pay(invoiceId);

    return {
      invoiceId: paid.id ?? invoiceId,
      status: paid.status,
    };
  }

  /**
   * Ground-truth reclassification: for every item with a real priceId, look up its
   * actual Stripe Price `type` and move it into the correct bucket if the frontend
   * put it in the wrong one — a saved recurring price must always end up billed as a
   * subscription, a saved one-time price must always end up billed once, regardless
   * of which cart section (one-time vs. subscription) it was added through. Items
   * with no priceId (pure custom price_data) have nothing to check against, so their
   * cart-section placement is trusted as-is.
   */
  private async reclassifyCartItems(
    rawOneTimeItems: PosCartItem[],
    rawSubscriptionItems: PosCartItem[],
  ): Promise<{ oneTimeItems: PosCartItem[]; subscriptionItems: PosCartItem[] }> {
    const allItems = [...rawOneTimeItems, ...rawSubscriptionItems];
    const priceIds = Array.from(
      new Set(allItems.map((i) => i.priceId).filter((id): id is string => !!id)),
    );

    const priceTypeById = new Map<string, Stripe.Price.Type>();
    await Promise.all(
      priceIds.map(async (id) => {
        try {
          const price = await this.stripe.prices.retrieve(id);
          priceTypeById.set(id, price.type);
        } catch {
          // Unretrievable price (deleted/invalid) — leave unclassified, item keeps
          // its original bucket and any downstream error (missing/invalid price)
          // still surfaces normally from the existing build/charge logic.
        }
      }),
    );

    const oneTimeItems: PosCartItem[] = [];
    const subscriptionItems: PosCartItem[] = [];

    for (const item of rawOneTimeItems) {
      const type = item.priceId ? priceTypeById.get(item.priceId) : undefined;
      (type === 'recurring' ? subscriptionItems : oneTimeItems).push(item);
    }
    for (const item of rawSubscriptionItems) {
      const type = item.priceId ? priceTypeById.get(item.priceId) : undefined;
      (type === 'one_time' ? oneTimeItems : subscriptionItems).push(item);
    }

    return { oneTimeItems, subscriptionItems };
  }

  private buildSubscriptionLineItems(subscriptionItems: PosCartItem[]) {
    return subscriptionItems.map((item) => {
      const amount = Number(item.amount);
      const defaultAmount = Number(item.defaultAmount);
      const label = item.name || 'Subscription item';

      if (!item.priceId && !item.productId) {
        throw new Error(
          `Subscription item "${label}" is missing both priceId and productId.`,
        );
      }

      // The cashier typed a different amount than this item's catalog default — that's
      // a deliberate override, and MUST use price_data with the real typed amount, not
      // the catalog's own price (charging the wrong amount is worse than the original
      // bug this replaced: silently using priceId here previously ignored every custom
      // override and charged the catalog default instead — for this test that default
      // happened to be $0, which is what produced the "$0 total" error).
      const isOverridden = Number.isFinite(defaultAmount) && amount !== defaultAmount;
      if (!isOverridden && item.priceId) {
        return { price: item.priceId };
      }

      if (!item.productId) {
        throw new Error(
          isOverridden
            ? `Subscription item "${label}" needs productId to charge its custom amount.`
            : `Subscription item "${label}" is missing productId for custom pricing.`,
        );
      }

      const interval = (item.interval || 'month') as Stripe.Price.Recurring.Interval;

      return {
        price_data: {
          currency: item.currency || 'usd',
          product: item.productId,
          recurring: { interval },
          unit_amount: amount,
        },
      };
    }) as Stripe.SubscriptionCreateParams.Item[];
  }

  private buildOneTimeInvoiceItems(oneTimeItems: PosCartItem[]) {
    return oneTimeItems.map((item) => {
      const amount = Number(item.amount);
      const defaultAmount = Number(item.defaultAmount);
      const label = item.name || 'One-time item';

      if (!item.priceId && !item.productId) {
        throw new Error(
          `One-time item "${label}" is missing both priceId and productId.`,
        );
      }

      // See the identical logic (and its comment) in buildSubscriptionLineItems above —
      // a custom-typed amount (differs from the catalog default) must use price_data
      // with the real typed amount, never the catalog's own priceId, or the item gets
      // charged at the wrong (catalog default) price instead of what the cashier entered.
      const isOverridden = Number.isFinite(defaultAmount) && amount !== defaultAmount;
      if (!isOverridden && item.priceId) {
        return { price: item.priceId };
      }

      if (!item.productId) {
        throw new Error(
          isOverridden
            ? `One-time item "${label}" needs productId to charge its custom amount.`
            : `One-time item "${label}" is missing productId for custom pricing.`,
        );
      }

      return {
        price_data: {
          currency: item.currency || 'usd',
          product: item.productId,
          unit_amount: amount,
        },
      };
    }) as Stripe.SubscriptionCreateParams.AddInvoiceItem[];
  }

  async catalogOneTime() {
    const prices = await this.stripe.prices.list({
      active: true,
      type: 'one_time',
      expand: ['data.product'],
      limit: 100,
    });

    return {
      ok: true,
      prices: prices.data.map((price) => {
        const product = price.product as Stripe.Product;
        return {
          id: price.id,
          productId: product.id,
          name: product.name,
          amount: price.unit_amount,
          currency: price.currency,
        };
      }),
    };
  }

  async catalogRecurring() {
    const prices = await this.stripe.prices.list({
      active: true,
      type: 'recurring',
      expand: ['data.product'],
      limit: 100,
    });

    return {
      ok: true,
      prices: prices.data.map((price) => {
        const product = price.product as Stripe.Product;
        return {
          id: price.id,
          productId: product.id,
          name: product.name,
          amount: price.unit_amount,
          currency: price.currency,
          interval: price.recurring!.interval,
        };
      }),
    };
  }
}
