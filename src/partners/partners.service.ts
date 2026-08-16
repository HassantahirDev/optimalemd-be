import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { CommissionType, PartnerReferralStatus, CommissionStatus } from '@prisma/client';

/**
 * Referral Partner (business affiliate) program. Fully self-contained —
 * separate from the patient-to-patient Referral/CreditEvent system.
 *
 * Attribution model: LAST-TOUCH. Every partner link click writes/updates a
 * PENDING PartnerReferral row for that visitorId+partnerId. At signup we bind
 * whichever PENDING row for that visitorId was clicked most recently
 * (across ALL partners) — so the last link the visitor actually signed up
 * under is the one that gets credit.
 */
@Injectable()
export class PartnersService {
  constructor(private prisma: PrismaService) {}

  // ─── Codes / passwords ──────────────────────────────────────────────────

  private async generatePartnerCode(): Promise<string> {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code: string;
    let exists = true;
    while (exists) {
      code =
        'PARTNER-' +
        Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      exists = !!(await this.prisma.referralPartner.findUnique({ where: { referralCode: code } }));
    }
    return code!;
  }

  private generateTempPassword(): string {
    return Math.random().toString(36).slice(-8) + 'A1!';
  }

  // ─── Public: tracking snippet ───────────────────────────────────────────

  /**
   * Called by the tracking snippet on every page load that carries a partner
   * code (?ref=CODE). Silent no-op on unknown/inactive codes so a bad link
   * never breaks the page for a visitor.
   */
  async trackVisit(params: {
    code: string;
    visitorId: string;
    landingUrl?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
  }) {
    const { code, visitorId } = params;
    if (!code || !visitorId) return { tracked: false };

    const partner = await this.prisma.referralPartner.findUnique({ where: { referralCode: code } });
    if (!partner || !partner.isActive) return { tracked: false };

    // If this exact visitor already has a PENDING row for this partner, just
    // refresh it (avoids piling up duplicate rows on repeat page views).
    const existing = await this.prisma.partnerReferral.findFirst({
      where: { partnerId: partner.id, visitorId, status: PartnerReferralStatus.PENDING },
      orderBy: { firstClickAt: 'desc' },
    });

    if (existing) {
      await this.prisma.partnerReferral.update({
        where: { id: existing.id },
        data: {
          firstClickAt: new Date(), // "most recent click" drives last-touch — bump it
          landingUrl: params.landingUrl ?? existing.landingUrl,
          utmSource: params.utmSource ?? existing.utmSource,
          utmMedium: params.utmMedium ?? existing.utmMedium,
          utmCampaign: params.utmCampaign ?? existing.utmCampaign,
        },
      });
      return { tracked: true };
    }

    await this.prisma.partnerReferral.create({
      data: {
        partnerId: partner.id,
        visitorId,
        landingUrl: params.landingUrl,
        utmSource: params.utmSource,
        utmMedium: params.utmMedium,
        utmCampaign: params.utmCampaign,
      },
    });
    return { tracked: true };
  }

  /**
   * Bind the visitor's LAST-TOUCH partner click to the new account at signup.
   * Non-fatal by design (caller wraps in try/catch) — a referral hiccup must
   * never block account creation.
   */
  async bindOnSignup(visitorId: string | undefined | null, userId: string, email?: string) {
    if (!visitorId) return null;

    // Already bound (idempotency guard for retried signup calls).
    const alreadyBound = await this.prisma.partnerReferral.findUnique({ where: { userId } });
    if (alreadyBound) return alreadyBound;

    // Last-touch: the most recently clicked PENDING row for this visitor, across ALL partners.
    const latest = await this.prisma.partnerReferral.findFirst({
      where: { visitorId, status: PartnerReferralStatus.PENDING, userId: null },
      orderBy: { firstClickAt: 'desc' },
    });
    if (!latest) return null;

    return this.prisma.partnerReferral.update({
      where: { id: latest.id },
      data: { userId, status: PartnerReferralStatus.SIGNED_UP, signedUpAt: new Date() },
    });
  }

  /**
   * Fire the qualifying event: signup completed OR welcome order purchased,
   * whichever happens first. Idempotent — a referral only ever earns once.
   */
  async qualify(userId: string, opts?: { revenueCents?: number; sourcePaymentRecordId?: string }) {
    const referral = await this.prisma.partnerReferral.findUnique({ where: { userId } });
    if (!referral || referral.status === PartnerReferralStatus.QUALIFIED || referral.status === PartnerReferralStatus.VOIDED) {
      return null; // no attribution, or already settled
    }

    const rule = await this.pickRule(referral.partnerId);
    const amountCents = rule ? this.computeAmount(rule, opts?.revenueCents ?? 0) : 0;

    const [, commission] = await this.prisma.$transaction([
      this.prisma.partnerReferral.update({
        where: { id: referral.id },
        data: { status: PartnerReferralStatus.QUALIFIED, qualifiedAt: new Date() },
      }),
      this.prisma.commission.create({
        data: {
          partnerId: referral.partnerId,
          partnerReferralId: referral.id,
          ruleId: rule?.id,
          sourcePaymentRecordId: opts?.sourcePaymentRecordId,
          amountCents,
          status: CommissionStatus.OWED,
        },
      }),
    ]);

    return commission;
  }

  /** Best-matching active rule: partner-specific first, else the global default. */
  private async pickRule(partnerId: string) {
    const partnerRule = await this.prisma.commissionRule.findFirst({
      where: { partnerId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    if (partnerRule) return partnerRule;

    return this.prisma.commissionRule.findFirst({
      where: { partnerId: null, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  private computeAmount(rule: { type: CommissionType; flatAmountCents: number | null; percentBasisPoints: number | null }, revenueCents: number): number {
    if (rule.type === CommissionType.FLAT) return rule.flatAmountCents ?? 0;
    const bps = rule.percentBasisPoints ?? 0;
    return Math.round((revenueCents * bps) / 10000);
  }

  /** Void a commission (refund/fraud/duplicate) — used from the payment refund path. */
  async voidCommissionForUser(userId: string, reason: string) {
    const referral = await this.prisma.partnerReferral.findUnique({ where: { userId } });
    if (!referral) return;
    await this.prisma.commission.updateMany({
      where: { partnerReferralId: referral.id, status: CommissionStatus.OWED },
      data: { status: CommissionStatus.VOIDED, voidReason: reason },
    });
  }

  // ─── Partner-facing (partners.formamd.com) ──────────────────────────────

  async getMe(partnerId: string) {
    const partner = await this.prisma.referralPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new NotFoundException('Partner not found');
    const { password, ...safe } = partner;
    return safe;
  }

  async getStats(partnerId: string) {
    const [clicks, signedUp, qualified, owedAgg, paidAgg] = await Promise.all([
      this.prisma.partnerReferral.count({ where: { partnerId } }),
      this.prisma.partnerReferral.count({ where: { partnerId, status: { in: [PartnerReferralStatus.SIGNED_UP, PartnerReferralStatus.QUALIFIED] } } }),
      this.prisma.partnerReferral.count({ where: { partnerId, status: PartnerReferralStatus.QUALIFIED } }),
      this.prisma.commission.aggregate({ where: { partnerId, status: CommissionStatus.OWED }, _sum: { amountCents: true } }),
      this.prisma.commission.aggregate({ where: { partnerId, status: CommissionStatus.PAID }, _sum: { amountCents: true } }),
    ]);

    return {
      totalClicks: clicks,
      totalSignups: signedUp,
      totalQualified: qualified,
      totalOwedCents: owedAgg._sum.amountCents ?? 0,
      totalPaidCents: paidAgg._sum.amountCents ?? 0,
    };
  }

  async getReferrals(partnerId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.partnerReferral.findMany({
        where: { partnerId },
        orderBy: { firstClickAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.partnerReferral.count({ where: { partnerId } }),
    ]);
    return { items, total, page, limit };
  }

  async getCommissions(partnerId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.commission.findMany({
        where: { partnerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { partnerReferral: true },
      }),
      this.prisma.commission.count({ where: { partnerId } }),
    ]);
    return { items, total, page, limit };
  }

  async changeOwnPassword(partnerId: string, currentPassword: string, newPassword: string) {
    const partner = await this.prisma.referralPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new NotFoundException('Partner not found');
    const valid = await bcrypt.compare(currentPassword, partner.password);
    if (!valid) throw new BadRequestException('Current password is incorrect');
    if (newPassword.length < 8) throw new BadRequestException('New password must be at least 8 characters');
    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.referralPartner.update({
      where: { id: partnerId },
      data: { password: hashed, mustChangePassword: false },
    });
    return { success: true };
  }

  // ─── Admin-facing ────────────────────────────────────────────────────────

  async adminListPartners() {
    const partners = await this.prisma.referralPartner.findMany({ orderBy: { createdAt: 'desc' } });
    return partners.map(({ password, ...safe }) => safe);
  }

  async adminCreatePartner(data: { name: string; email: string; companyName?: string; phone?: string }) {
    const email = data.email.toLowerCase().trim();
    const existing = await this.prisma.referralPartner.findUnique({ where: { email } });
    if (existing) throw new ConflictException('A partner with this email already exists');

    const referralCode = await this.generatePartnerCode();
    const tempPassword = this.generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 12);

    const partner = await this.prisma.referralPartner.create({
      data: {
        name: data.name,
        email,
        password: hashed,
        companyName: data.companyName,
        phone: data.phone,
        referralCode,
        mustChangePassword: true,
      },
    });

    const { password, ...safe } = partner;
    // Temp password is returned once so the admin can hand it to the partner directly
    // (no email-sending dependency for launch — matches "use your own for now").
    return { ...safe, tempPassword };
  }

  async adminUpdatePartner(id: string, data: { name?: string; isActive?: boolean; companyName?: string; phone?: string; payoutMethod?: string; payoutNotes?: string }) {
    const partner = await this.prisma.referralPartner.findUnique({ where: { id } });
    if (!partner) throw new NotFoundException('Partner not found');
    const updated = await this.prisma.referralPartner.update({ where: { id }, data });
    const { password, ...safe } = updated;
    return safe;
  }

  async adminResetPartnerPassword(id: string) {
    const partner = await this.prisma.referralPartner.findUnique({ where: { id } });
    if (!partner) throw new NotFoundException('Partner not found');
    const tempPassword = this.generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 12);
    await this.prisma.referralPartner.update({
      where: { id },
      data: { password: hashed, mustChangePassword: true },
    });
    return { tempPassword };
  }

  async adminListCommissionRules() {
    return this.prisma.commissionRule.findMany({ orderBy: { createdAt: 'desc' }, include: { partner: { select: { name: true } } } });
  }

  async adminCreateCommissionRule(data: {
    partnerId?: string;
    name: string;
    type: CommissionType;
    flatAmountCents?: number;
    percentBasisPoints?: number;
    serviceKeyword?: string;
  }) {
    if (data.type === CommissionType.FLAT && !data.flatAmountCents) {
      throw new BadRequestException('flatAmountCents is required for FLAT rules');
    }
    if (data.type === CommissionType.PERCENTAGE && !data.percentBasisPoints) {
      throw new BadRequestException('percentBasisPoints is required for PERCENTAGE rules');
    }
    return this.prisma.commissionRule.create({ data });
  }

  async adminUpdateCommissionRule(id: string, data: Partial<{ name: string; isActive: boolean; flatAmountCents: number; percentBasisPoints: number; serviceKeyword: string }>) {
    const rule = await this.prisma.commissionRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Commission rule not found');
    return this.prisma.commissionRule.update({ where: { id }, data });
  }

  async adminListCommissions(status?: CommissionStatus, partnerId?: string) {
    return this.prisma.commission.findMany({
      where: { ...(status ? { status } : {}), ...(partnerId ? { partnerId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { partner: { select: { name: true, email: true } }, partnerReferral: true },
    });
  }

  /** Manual payout — admin marks a set of OWED commissions as paid in one batch. */
  async adminRecordPayout(partnerId: string, commissionIds: string[], data: { method?: string; reference?: string; note?: string }) {
    const commissions = await this.prisma.commission.findMany({
      where: { id: { in: commissionIds }, partnerId, status: CommissionStatus.OWED },
    });
    if (commissions.length === 0) {
      throw new BadRequestException('No matching OWED commissions found for this partner');
    }

    const totalCents = commissions.reduce((sum, c) => sum + c.amountCents, 0);

    const batch = await this.prisma.payoutBatch.create({
      data: {
        partnerId,
        totalCents,
        method: data.method,
        reference: data.reference,
        note: data.note,
      },
    });

    await this.prisma.commission.updateMany({
      where: { id: { in: commissions.map((c) => c.id) } },
      data: { status: CommissionStatus.PAID, paidAt: new Date(), payoutBatchId: batch.id },
    });

    return batch;
  }

  async adminListPayoutBatches(partnerId?: string) {
    return this.prisma.payoutBatch.findMany({
      where: partnerId ? { partnerId } : {},
      orderBy: { paidAt: 'desc' },
      include: { partner: { select: { name: true, email: true } }, commissions: true },
    });
  }
}
