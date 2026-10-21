import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { FulfillmentStatus, ListSupplementOrdersQueryDto, UpdateFulfillmentDto } from './dto/admin-orders.dto';

/** Staff view of supplements orders: listing, filtering and shipping updates. */
@Injectable()
export class SupplementOrdersAdminService {
  private readonly logger = new Logger(SupplementOrdersAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  async list(q: ListSupplementOrdersQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const payment = q.payment ?? 'PAID';

    const paymentWhere: Prisma.SupplementOrderWhereInput =
      payment === 'ALL'
        ? {}
        : payment === 'UNPAID'
          ? { status: { in: ['PENDING', 'FAILED', 'CANCELLED'] } }
          : { status: payment };

    const search = q.search?.trim();
    const searchWhere: Prisma.SupplementOrderWhereInput = search
      ? {
          OR: [
            { orderNumber: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const base: Prisma.SupplementOrderWhereInput = { AND: [paymentWhere, searchWhere] };
    const where: Prisma.SupplementOrderWhereInput =
      q.fulfillment && q.fulfillment !== 'ALL' ? { AND: [base, { fulfillmentStatus: q.fulfillment }] } : base;

    const [orders, total, grouped] = await Promise.all([
      this.prisma.supplementOrder.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.supplementOrder.count({ where }),
      // Tab counts respect the payment + search filters, not the status tab itself.
      this.prisma.supplementOrder.groupBy({ by: ['fulfillmentStatus'], where: base, _count: { _all: true } }),
    ]);

    const counts = { PENDING: 0, SHIPPED: 0, DELIVERED: 0 } as Record<FulfillmentStatus, number>;
    for (const g of grouped) counts[g.fulfillmentStatus as FulfillmentStatus] = g._count._all;

    return {
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        paymentStatus: o.status,
        fulfillmentStatus: o.fulfillmentStatus,
        customer: {
          name: `${o.firstName} ${o.lastName}`.trim(),
          email: o.email,
          phone: o.phone,
          userId: o.userId,
        },
        shippingAddress: {
          line1: o.shippingLine1,
          line2: o.shippingLine2,
          city: o.shippingCity,
          state: o.shippingState,
          postalCode: o.shippingPostalCode,
          country: o.shippingCountry,
        },
        isMember: o.isMember,
        discountAmount: Number(o.discountAmount),
        total: Number(o.total),
        items: o.items.map((i) => ({
          name: i.productName,
          quantity: i.quantity,
          unitPrice: Number(i.unitPrice),
          lineTotal: Number(i.lineTotal),
        })),
        carrier: o.carrier,
        trackingNumber: o.trackingNumber,
        shippedAt: o.shippedAt,
        deliveredAt: o.deliveredAt,
        shippedEmailSentAt: o.shippedEmailSentAt,
        stripePaymentIntentId: o.stripePaymentIntentId,
      })),
      counts,
      total,
      page,
      pageSize,
    };
  }

  /**
   * Moves an order along pending → shipped → delivered (or back, to correct a
   * mistake). The first time it's marked shipped the customer is emailed; later
   * saves (e.g. correcting tracking) don't re-send it.
   */
  async updateFulfillment(orderId: string, dto: UpdateFulfillmentDto, adminId: string) {
    const order = await this.prisma.supplementOrder.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PAID') {
      throw new BadRequestException('Only paid orders can be shipped or delivered.');
    }

    const now = new Date();
    const data: Prisma.SupplementOrderUpdateInput = {
      fulfillmentStatus: dto.status,
      fulfillmentUpdatedById: adminId,
    };
    if (dto.carrier !== undefined) data.carrier = dto.carrier.trim() || null;
    if (dto.trackingNumber !== undefined) data.trackingNumber = dto.trackingNumber.trim() || null;

    if (dto.status === 'PENDING') {
      data.shippedAt = null;
      data.deliveredAt = null;
    } else if (dto.status === 'SHIPPED') {
      data.shippedAt = order.shippedAt ?? now;
      data.deliveredAt = null;
    } else {
      data.shippedAt = order.shippedAt ?? now;
      data.deliveredAt = order.deliveredAt ?? now;
    }

    const updated = await this.prisma.supplementOrder.update({ where: { id: orderId }, data, include: { items: true } });

    let emailSent = false;
    if (dto.status === 'SHIPPED') {
      // The email goes out once per order: the claim below only succeeds if it
      // hasn't been sent yet, which also stops two admins double-emailing and lets
      // a failed send be retried by marking it shipped again.
      const claim = await this.prisma.supplementOrder.updateMany({
        where: { id: orderId, shippedEmailSentAt: null },
        data: { shippedEmailSentAt: now },
      });
      if (claim.count === 1) {
        try {
          await this.mailer.sendSupplementOrderShipped({
            orderNumber: updated.orderNumber,
            firstName: updated.firstName,
            lastName: updated.lastName,
            email: updated.email,
            phone: updated.phone,
            address: [
              updated.shippingLine1,
              updated.shippingLine2,
              `${updated.shippingCity}, ${updated.shippingState} ${updated.shippingPostalCode}`,
            ].filter(Boolean) as string[],
            items: updated.items.map((i) => ({ name: i.productName, quantity: i.quantity, lineTotal: Number(i.lineTotal) })),
            total: Number(updated.total),
            discount: Number(updated.discountAmount),
            carrier: updated.carrier,
            trackingNumber: updated.trackingNumber,
          });
          emailSent = true;
        } catch (err: any) {
          // Release the claim so the next "Shipped" attempt can retry the email.
          await this.prisma.supplementOrder.update({ where: { id: orderId }, data: { shippedEmailSentAt: null } });
          this.logger.error(`Shipped email failed for ${updated.orderNumber}: ${err?.message}`);
        }
      }
    }

    return {
      id: updated.id,
      fulfillmentStatus: updated.fulfillmentStatus,
      carrier: updated.carrier,
      trackingNumber: updated.trackingNumber,
      shippedAt: updated.shippedAt,
      deliveredAt: updated.deliveredAt,
      shippedEmailSentAt: emailSent ? now : updated.shippedEmailSentAt,
      emailSent,
    };
  }
}
