import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { UspsService, UspsPackage, UspsTrackingResult } from './usps.service';
import { CreateShipmentDto, ListShipmentsQueryDto, QuoteShipmentDto } from './dto/shipments.dto';

// Statuses that mean "USPS has it and it's moving" — the moment the patient is emailed.
const ON_ITS_WAY = ['IN_TRANSIT', 'OUT_FOR_DELIVERY'];
// Stop polling USPS after this long; a package still not delivered by then needs a human.
const TRACK_FOR_DAYS = 45;

const listSelect = {
  id: true,
  userId: true,
  carrier: true,
  trackingNumber: true,
  mailClass: true,
  status: true,
  statusDetail: true,
  lastEventAt: true,
  lastCheckedAt: true,
  deliveredAt: true,
  recipientName: true,
  recipientEmail: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  zipcode: true,
  labelSource: true,
  postage: true,
  weightOz: true,
  note: true,
  shippedEmailSentAt: true,
  createdAt: true,
  notifications: {
    select: { id: true, type: true, toEmail: true, success: true, error: true, trigger: true, sentAt: true },
    orderBy: { sentAt: 'desc' as const },
  },
} satisfies Prisma.ShipmentSelect;

@Injectable()
export class ShipmentsService {
  private readonly logger = new Logger(ShipmentsService.name);
  private refreshing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly usps: UspsService,
    private readonly config: ConfigService,
  ) {}

  status() {
    return {
      trackingEnabled: this.usps.isConfigured(),
      labelsEnabled: this.usps.labelsConfigured(),
      environment: (this.config.get<string>('USPS_API_BASE') || '').includes('-tem') ? 'test' : 'live',
    };
  }

  async list(q: ListShipmentsQueryDto) {
    const page = q.page || 1;
    const pageSize = q.pageSize || 25;
    const search = q.search?.trim();
    const where: Prisma.ShipmentWhereInput = {
      ...(q.status && q.status !== 'ALL' ? { status: q.status as any } : {}),
      ...(search
        ? {
            OR: [
              { trackingNumber: { contains: search.replace(/\s/g, ''), mode: 'insensitive' } },
              { recipientName: { contains: search, mode: 'insensitive' } },
              { recipientEmail: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total, grouped] = await Promise.all([
      this.prisma.shipment.findMany({ where, select: listSelect, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    return { items, total, page, pageSize, counts, ...this.status() };
  }

  /** Patients to ship to, with the address on their profile. */
  async searchPatients(search: string) {
    const s = (search || '').trim();
    if (s.length < 2) return [];
    return this.prisma.user.findMany({
      where: {
        OR: [
          { firstName: { contains: s, mode: 'insensitive' } },
          { lastName: { contains: s, mode: 'insensitive' } },
          { primaryEmail: { contains: s, mode: 'insensitive' } },
        ],
      },
      select: { id: true, firstName: true, lastName: true, primaryEmail: true, completeAddress: true, city: true, state: true, zipcode: true },
      take: 10,
      orderBy: { createdAt: 'desc' },
    });
  }

  async quote(dto: QuoteShipmentDto) {
    const fromZip = this.config.get<string>('USPS_FROM_ZIP');
    if (!fromZip) throw new BadRequestException('Set USPS_FROM_ZIP (the clinic ZIP the packages ship from) to get prices.');
    return this.usps.quote(fromZip, dto.zipcode, this.pkg(dto));
  }

  private pkg(dto: { mailClass?: string; weightOz: number; lengthIn?: number; widthIn?: number; heightIn?: number }): UspsPackage {
    return {
      mailClass: dto.mailClass || 'USPS_GROUND_ADVANTAGE',
      weightOz: dto.weightOz,
      lengthIn: dto.lengthIn || 9,
      widthIn: dto.widthIn || 6,
      heightIn: dto.heightIn || 2,
    };
  }

  /**
   * Records a shipment for a patient. With `trackingNumber` it registers a label
   * bought elsewhere (USPS.com); with `createLabel` it buys the label from USPS.
   * Tracking is checked straight away, which also sends the email if it's moving.
   */
  async create(dto: CreateShipmentDto, adminId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true, firstName: true, lastName: true, primaryEmail: true, email: true, completeAddress: true, city: true, state: true, zipcode: true },
    });
    if (!user) throw new NotFoundException('Patient not found');

    const recipientEmail = (dto.recipientEmail || user.primaryEmail || user.email || '').trim();
    const address = {
      addressLine1: (dto.addressLine1 ?? user.completeAddress ?? '').trim(),
      addressLine2: dto.addressLine2?.trim() || null,
      city: (dto.city ?? user.city ?? '').trim(),
      state: (dto.state ?? user.state ?? '').trim(),
      zipcode: (dto.zipcode ?? user.zipcode ?? '').trim(),
    };
    if (!recipientEmail) throw new BadRequestException('Patient has no email address to notify.');
    if (!address.addressLine1 || !address.city || !address.state || !address.zipcode) {
      throw new BadRequestException('Shipping address is incomplete (street, city, state and ZIP are required).');
    }
    const recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || recipientEmail;

    let trackingNumber: string;
    let label: { pdf: Buffer; postage: number | null } | null = null;
    if (dto.createLabel) {
      if (!dto.weightOz) throw new BadRequestException('Package weight is required to buy a label.');
      const bought = await this.usps.createLabel(
        {
          firstName: user.firstName || recipientName,
          lastName: user.lastName || '',
          streetAddress: address.addressLine1,
          secondaryAddress: address.addressLine2,
          city: address.city,
          state: address.state,
          ZIPCode: address.zipcode.slice(0, 5),
        },
        this.pkg({ ...dto, weightOz: dto.weightOz }),
      );
      trackingNumber = bought.trackingNumber;
      label = { pdf: bought.pdf, postage: bought.postage };
    } else {
      trackingNumber = (dto.trackingNumber || '').replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z0-9]{10,40}$/.test(trackingNumber)) throw new BadRequestException('Enter a valid USPS tracking number.');
    }

    const existing = await this.prisma.shipment.findUnique({ where: { trackingNumber }, select: { id: true } });
    if (existing) throw new BadRequestException('This tracking number is already recorded.');

    const shipment = await this.prisma.shipment.create({
      data: {
        userId: user.id,
        trackingNumber,
        mailClass: dto.createLabel ? dto.mailClass || 'USPS_GROUND_ADVANTAGE' : dto.mailClass || null,
        recipientName,
        recipientEmail,
        ...address,
        labelSource: label ? 'USPS_API' : 'EXTERNAL',
        labelPdf: label ? label.pdf : undefined,
        postage: label?.postage ?? undefined,
        weightOz: dto.weightOz ?? undefined,
        note: dto.note?.trim() || null,
        createdById: adminId,
      },
      select: { id: true },
    });

    if (this.usps.isConfigured()) {
      await this.refreshMany([shipment.id]).catch((e) => this.logger.warn(`[shipments] first tracking check failed: ${e?.message}`));
    }
    return this.get(shipment.id);
  }

  async get(id: string) {
    const s = await this.prisma.shipment.findUnique({ where: { id }, select: listSelect });
    if (!s) throw new NotFoundException('Shipment not found');
    return s;
  }

  async labelPdf(id: string) {
    const s = await this.prisma.shipment.findUnique({ where: { id }, select: { labelPdf: true, trackingNumber: true } });
    if (!s?.labelPdf) throw new NotFoundException('No label stored for this shipment (it was bought outside FormaMD).');
    return { pdf: Buffer.from(s.labelPdf), filename: `usps-label-${s.trackingNumber}.pdf` };
  }

  async remove(id: string) {
    const s = await this.prisma.shipment.findUnique({ where: { id }, select: { labelSource: true } });
    if (!s) throw new NotFoundException('Shipment not found');
    if (s.labelSource === 'USPS_API') {
      throw new BadRequestException('This label was bought through FormaMD. Cancel it with USPS for a refund before removing it.');
    }
    await this.prisma.shipment.delete({ where: { id } });
    return { deleted: true };
  }

  // ---------------------------------------------------------------- tracking --

  /** Every 2 hours: refresh packages that aren't delivered yet. Set USPS_TRACKING_CRON=off to stop it. */
  @Cron('0 15 */2 * * *')
  async scheduledRefresh() {
    if (this.config.get<string>('USPS_TRACKING_CRON') === 'off' || !this.usps.isConfigured()) return;
    await this.refreshActive().catch((e) => this.logger.warn(`[shipments] scheduled refresh failed: ${e?.message}`));
  }

  async refreshActive() {
    const since = new Date(Date.now() - TRACK_FOR_DAYS * 86400000);
    const active = await this.prisma.shipment.findMany({
      where: { status: { not: 'DELIVERED' }, createdAt: { gte: since } },
      select: { id: true },
    });
    return this.refreshMany(active.map((a) => a.id));
  }

  /** Pulls the latest USPS status for these shipments and emails anyone newly on the way. */
  async refreshMany(ids: string[]) {
    if (!ids.length) return { checked: 0, emailed: 0 };
    // Only bulk refreshes (cron / "Refresh all") are serialised; a single row can always refresh.
    const bulk = ids.length > 1;
    if (bulk && this.refreshing) return { checked: 0, emailed: 0, skipped: true };
    if (bulk) this.refreshing = true;
    try {
      const rows = await this.prisma.shipment.findMany({ where: { id: { in: ids } }, select: { id: true, trackingNumber: true } });
      const results = await this.usps.track(rows.map((r) => r.trackingNumber));
      let emailed = 0;
      for (const row of rows) {
        const r = results.find((x) => x.trackingNumber === row.trackingNumber);
        if (r && (await this.applyTracking(row.id, r))) emailed++;
      }
      return { checked: rows.length, emailed };
    } finally {
      if (bulk) this.refreshing = false;
    }
  }

  private async applyTracking(id: string, r: UspsTrackingResult): Promise<boolean> {
    const current = await this.prisma.shipment.findUnique({ where: { id }, select: { status: true } });
    // USPS returning "no info" for a package we already saw moving is a glitch — keep the known status.
    const status = r.status === 'UNKNOWN' && current && current.status !== 'LABEL_CREATED' && current.status !== 'UNKNOWN' ? current.status : r.status;
    await this.prisma.shipment.update({
      where: { id },
      data: {
        status: status as any,
        statusDetail: r.detail,
        lastEventAt: r.eventAt ?? undefined,
        lastCheckedAt: new Date(),
        ...(status === 'DELIVERED' ? { deliveredAt: r.eventAt ?? new Date() } : {}),
      },
    });
    if (!ON_ITS_WAY.includes(status)) return false;
    return this.sendOnItsWay(id, 'AUTO');
  }

  /**
   * Sends the "on its way" email. AUTO sends at most once (claimed atomically);
   * MANUAL is staff pressing "Send email" and always sends. Both are logged.
   */
  async sendOnItsWay(id: string, trigger: 'AUTO' | 'MANUAL'): Promise<boolean> {
    const now = new Date();
    if (trigger === 'AUTO') {
      const claim = await this.prisma.shipment.updateMany({ where: { id, shippedEmailSentAt: null }, data: { shippedEmailSentAt: now } });
      if (claim.count === 0) return false;
    }
    const s = await this.prisma.shipment.findUnique({
      where: { id },
      select: { recipientEmail: true, recipientName: true, trackingNumber: true, addressLine1: true, addressLine2: true, city: true, state: true, zipcode: true, user: { select: { firstName: true } } },
    });
    if (!s) return false;
    try {
      await this.mailer.sendShipmentOnItsWay({
        to: s.recipientEmail,
        firstName: s.user?.firstName || s.recipientName.split(' ')[0] || 'there',
        trackingNumber: s.trackingNumber,
        address: [s.recipientName, s.addressLine1, s.addressLine2, `${s.city}, ${s.state} ${s.zipcode}`].filter(Boolean) as string[],
      });
      await this.prisma.shipmentNotification.create({ data: { shipmentId: id, type: 'IN_TRANSIT', toEmail: s.recipientEmail, success: true, trigger } });
      if (trigger === 'MANUAL') await this.prisma.shipment.updateMany({ where: { id, shippedEmailSentAt: null }, data: { shippedEmailSentAt: now } });
      return true;
    } catch (e: any) {
      this.logger.error(`[shipments] email failed for ${s.trackingNumber}: ${e?.message}`);
      await this.prisma.shipmentNotification.create({
        data: { shipmentId: id, type: 'IN_TRANSIT', toEmail: s.recipientEmail, success: false, error: String(e?.message || e).slice(0, 500), trigger },
      });
      // Release the claim so the next tracking check retries the email.
      if (trigger === 'AUTO') await this.prisma.shipment.update({ where: { id }, data: { shippedEmailSentAt: null } });
      return false;
    }
  }
}
