import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { PaymentLedgerService } from '../payments/payment-ledger.service';
import { StripeService } from '../stripe/stripe.service';
import {
  findSupplement,
  MEMBER_DISCOUNT_PERCENT,
  memberPrice,
  SUPPLEMENT_CATALOG,
  SUPPLEMENT_PI_KIND,
} from './supplements.catalog';
import { CreateSupplementCheckoutDto } from './dto/checkout.dto';

export { SUPPLEMENT_PI_KIND };

const orderWithItems = Prisma.validator<Prisma.SupplementOrderDefaultArgs>()({
  include: { items: true },
});
type OrderWithItems = Prisma.SupplementOrderGetPayload<typeof orderWithItems>;

/** Who is checking out, from the optional JWT (null = guest). */
export type StoreViewer = { id: string; userType: string } | null;

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class SupplementsService {
  private readonly logger = new Logger(SupplementsService.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
    private readonly ledger: PaymentLedgerService,
    private readonly stripeService: StripeService,
  ) {
    this.stripe = new Stripe(this.config.get<string>('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2025-10-29.clover' as any,
    });
  }

  /** Catalogue with the price this viewer would pay (members get the discount). */
  async listProducts(viewer: StoreViewer) {
    const member = await this.resolveMember(viewer);
    return {
      isMember: !!member?.isSubscribed,
      memberDiscountPercent: MEMBER_DISCOUNT_PERCENT,
      products: SUPPLEMENT_CATALOG.map((p) => ({
        ...p,
        memberPrice: memberPrice(p.price),
      })),
    };
  }

  /**
   * Signed-in patient (userType 'user') and whether they're a member; null for
   * guests/staff. Membership comes from the same check as the "Performance
   * Member" badge (getSubscriptionStatus), which reconciles with Stripe live —
   * the stored isSubscribed flag alone can lag behind a renewal or webhook.
   */
  private async resolveMember(viewer: StoreViewer) {
    if (!viewer?.id || viewer.userType !== 'user') return null;
    const user = await this.prisma.user.findUnique({
      where: { id: viewer.id },
      select: { id: true, isSubscribed: true, stripeCustomerId: true },
    });
    if (!user) return null;
    try {
      const status = await this.stripeService.getSubscriptionStatus(user.id);
      return { ...user, isSubscribed: !!status?.isSubscribed };
    } catch (err: any) {
      this.logger.warn(`Membership check fell back to stored flag for ${user.id}: ${err?.message}`);
      return user;
    }
  }

  /**
   * Creates a PENDING order priced from the server catalogue, then a card
   * PaymentIntent for it. The client confirms the card with the returned secret
   * and calls confirmCheckout (the payment_intent.succeeded webhook is the
   * fallback if the tab closes first).
   */
  async createCheckout(dto: CreateSupplementCheckoutDto, viewer: StoreViewer = null) {
    const patient = await this.resolveMember(viewer);
    const isMember = !!patient?.isSubscribed;

    // Merge duplicate lines and price every line from the catalogue.
    const qtyBySlug = new Map<string, number>();
    for (const item of dto.items) {
      if (!findSupplement(item.slug)) throw new BadRequestException(`Unknown product: ${item.slug}`);
      qtyBySlug.set(item.slug, (qtyBySlug.get(item.slug) || 0) + item.quantity);
    }
    const lines = [...qtyBySlug.entries()].map(([slug, quantity]) => {
      const product = findSupplement(slug)!;
      const unitPrice = isMember ? memberPrice(product.price) : product.price;
      return {
        productSlug: slug,
        productName: product.name,
        unitPrice,
        listPrice: product.price,
        quantity,
        lineTotal: round2(unitPrice * quantity),
      };
    });
    const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
    const discountAmount = round2(lines.reduce((sum, l) => sum + (l.listPrice - l.unitPrice) * l.quantity, 0));
    const shippingAmount = 0; // free shipping
    const total = subtotal + shippingAmount;
    const amountCents = Math.round(total * 100);
    if (amountCents < 50) throw new BadRequestException('Order total is too low');

    const email = dto.email.trim().toLowerCase();
    const order = await this.createOrderWithUniqueNumber({
      userId: patient?.id ?? null,
      isMember,
      discountAmount,
      email,
      firstName: dto.firstName.trim(),
      lastName: dto.lastName.trim(),
      phone: dto.phone?.trim() || null,
      shippingLine1: dto.shipping.line1.trim(),
      shippingLine2: dto.shipping.line2?.trim() || null,
      shippingCity: dto.shipping.city.trim(),
      shippingState: dto.shipping.state,
      shippingPostalCode: dto.shipping.postalCode,
      subtotal,
      shippingAmount,
      total,
      items: { create: lines },
    });

    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await this.stripe.paymentIntents.create(
        {
          amount: amountCents,
          currency: 'usd',
          payment_method_types: ['card'],
          receipt_email: email,
          // Signed-in patients pay on their own Stripe customer, so the charge
          // sits with the rest of their billing in Stripe too.
          customer: patient?.stripeCustomerId || undefined,
          description: `FormaMD Supplements — order ${order.orderNumber}`,
          shipping: {
            name: `${order.firstName} ${order.lastName}`,
            phone: order.phone || undefined,
            address: {
              line1: order.shippingLine1,
              line2: order.shippingLine2 || undefined,
              city: order.shippingCity,
              state: order.shippingState,
              postal_code: order.shippingPostalCode,
              country: 'US',
            },
          },
          metadata: {
            kind: SUPPLEMENT_PI_KIND,
            supplementOrderId: order.id,
            orderNumber: order.orderNumber,
            userId: patient?.id || '',
            memberPricing: isMember ? 'true' : 'false',
            items: lines.map((l) => `${l.productSlug} x${l.quantity}`).join(', '),
          },
        },
        { idempotencyKey: `supplement-order-${order.id}` },
      );
    } catch (err: any) {
      await this.prisma.supplementOrder.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      this.logger.error(`PaymentIntent creation failed for ${order.orderNumber}: ${err?.message}`);
      throw new BadRequestException('Could not start payment. Please try again.');
    }

    await this.prisma.supplementOrder.update({
      where: { id: order.id },
      data: { stripePaymentIntentId: paymentIntent.id },
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      clientSecret: paymentIntent.client_secret,
      isMember,
      subtotal,
      discountAmount,
      shippingAmount,
      total,
      items: lines,
    };
  }

  /** Called by the storefront after stripe.confirmCardPayment resolves. */
  async confirmCheckout(paymentIntentId: string) {
    const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.metadata?.kind !== SUPPLEMENT_PI_KIND) throw new NotFoundException('Order not found');
    const order = await this.handlePaymentSucceeded(pi);
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PAID') {
      throw new BadRequestException('Payment has not completed yet.');
    }
    return this.publicSummary(order);
  }

  /**
   * Idempotent: safe to call from both the confirm endpoint and the webhook.
   * Marks the order PAID once Stripe says the PaymentIntent succeeded, and sends
   * the emails exactly once (claimed via confirmationEmailSentAt).
   */
  async handlePaymentSucceeded(pi: Stripe.PaymentIntent): Promise<OrderWithItems | null> {
    const orderId = pi.metadata?.supplementOrderId;
    if (!orderId) return null;

    const existing = await this.prisma.supplementOrder.findUnique({ where: { id: orderId } });
    if (!existing || existing.stripePaymentIntentId !== pi.id) return null;

    if (pi.status === 'succeeded') {
      await this.prisma.supplementOrder.updateMany({
        where: { id: orderId, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PAID', paidAt: new Date() },
      });

      const claim = await this.prisma.supplementOrder.updateMany({
        where: { id: orderId, status: 'PAID', confirmationEmailSentAt: null },
        data: { confirmationEmailSentAt: new Date() },
      });
      if (claim.count === 1) {
        const paid = await this.prisma.supplementOrder.findUnique({ where: { id: orderId }, ...orderWithItems });
        if (paid) {
          await this.recordInLedger(paid, pi);
          void this.sendOrderEmails(paid);
        }
      }
    }

    return this.prisma.supplementOrder.findUnique({ where: { id: orderId }, ...orderWithItems });
  }

  /**
   * Mirrors the paid order into the unified payment ledger so it shows in the
   * patient's billing history (matched by userId, or by email for guests) and in
   * the payments portal. One-time charge. The ledger never throws.
   */
  private async recordInLedger(order: OrderWithItems, pi: Stripe.PaymentIntent) {
    const charge = await this.stripe.charges
      .list({ payment_intent: pi.id, limit: 1 })
      .then((r) => r.data[0])
      .catch(() => undefined);
    await this.ledger.upsertFromStripe({
      stripePaymentIntentId: pi.id,
      stripeChargeId: charge?.id ?? null,
      stripeCustomerId: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null,
      userId: order.userId,
      channel: 'PLATFORM',
      category: 'SUPPLEMENT',
      billing: 'ONE_TIME',
      amount: Number(order.total),
      status: 'SUCCEEDED',
      receiptUrl: charge?.receipt_url ?? null,
      cardBrand: charge?.payment_method_details?.card?.brand ?? null,
      cardLast4: charge?.payment_method_details?.card?.last4 ?? null,
      billingEmail: order.email,
      createdByType: order.userId ? 'patient' : 'system',
      createdById: order.userId,
      note: `Supplements order ${order.orderNumber}${order.isMember ? ` (member pricing, ${MEMBER_DISCOUNT_PERCENT}% off)` : ''}`,
      paidAt: order.paidAt ?? new Date(),
      lineItems: order.items.map((i) => ({
        description: i.productName,
        quantity: i.quantity,
        unitAmount: Number(i.unitPrice),
        category: 'SUPPLEMENT' as const,
      })),
    });
  }

  /** charge.refunded for a supplements PaymentIntent: reflect a full refund on the order. */
  async handleRefund(paymentIntentId: string, fullyRefunded: boolean) {
    if (!fullyRefunded) return;
    await this.prisma.supplementOrder.updateMany({
      where: { stripePaymentIntentId: paymentIntentId, status: 'PAID' },
      data: { status: 'REFUNDED' },
    });
  }

  private async sendOrderEmails(order: OrderWithItems) {
    const payload = {
      orderNumber: order.orderNumber,
      firstName: order.firstName,
      lastName: order.lastName,
      email: order.email,
      phone: order.phone,
      address: [
        order.shippingLine1,
        order.shippingLine2,
        `${order.shippingCity}, ${order.shippingState} ${order.shippingPostalCode}`,
      ].filter(Boolean) as string[],
      items: order.items.map((i) => ({
        name: i.productName,
        quantity: i.quantity,
        lineTotal: Number(i.lineTotal),
      })),
      total: Number(order.total),
      discount: Number(order.discountAmount),
    };

    try {
      await this.mailer.sendSupplementOrderConfirmation(payload);
    } catch (err: any) {
      this.logger.error(`Customer confirmation failed for ${order.orderNumber}: ${err?.message}`);
    }

    const opsInbox =
      this.config.get<string>('SUPPLEMENT_ORDERS_EMAIL') ||
      this.config.get<string>('APPOINTMENT_SMTP_FROM') ||
      this.config.get<string>('SMTP_FROM');
    if (opsInbox) {
      try {
        await this.mailer.sendSupplementOrderNotification(opsInbox, payload);
      } catch (err: any) {
        this.logger.error(`Fulfilment notification failed for ${order.orderNumber}: ${err?.message}`);
      }
    }
  }

  private publicSummary(order: OrderWithItems) {
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      email: order.email,
      firstName: order.firstName,
      isMember: order.isMember,
      discountAmount: Number(order.discountAmount),
      total: Number(order.total),
      items: order.items.map((i) => ({
        slug: i.productSlug,
        name: i.productName,
        quantity: i.quantity,
        lineTotal: Number(i.lineTotal),
      })),
    };
  }

  private async createOrderWithUniqueNumber(data: Omit<Prisma.SupplementOrderCreateInput, 'orderNumber'>) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNumber = `SUP-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
      try {
        return await this.prisma.supplementOrder.create({ data: { ...data, orderNumber } });
      } catch (err: any) {
        // P2002 = orderNumber collision; anything else is a real error.
        if (err?.code !== 'P2002') throw err;
      }
    }
    throw new BadRequestException('Could not create order. Please try again.');
  }
}
