import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
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
  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService,
  ) {}

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

    // Every commission converts straight to spendable platform credit — no manual
    // payout request step. It's created CREDITED (not OWED) so it can never also be
    // picked up by the manual payout batch/request flow (which only ever looks at
    // OWED rows) — that would double-pay the same dollar as both cash and credit.
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
          status: CommissionStatus.CREDITED,
        },
      }),
    ]);

    if (amountCents > 0) {
      await this.prisma.referralPartner.update({
        where: { id: referral.partnerId },
        data: { creditBalanceCents: { increment: amountCents } },
      });
    }

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

  /**
   * Void a commission (refund/fraud/duplicate) — used from the payment refund path.
   * Covers CREDITED rows too, with a clawback: since that amount already landed in
   * creditBalanceCents (not sitting in a payable OWED bucket), voiding it must also
   * pull it back out of the balance — clamped at 0 in case some/all of it was already
   * spent on a signup/subscription discount by the time the void happens.
   */
  async voidCommissionForUser(userId: string, reason: string) {
    const referral = await this.prisma.partnerReferral.findUnique({ where: { userId } });
    if (!referral) return;

    const toVoid = await this.prisma.commission.findMany({
      where: { partnerReferralId: referral.id, status: { in: [CommissionStatus.OWED, CommissionStatus.CREDITED] } },
      select: { id: true, partnerId: true, amountCents: true, status: true },
    });
    if (toVoid.length === 0) return;

    await this.prisma.commission.updateMany({
      where: { id: { in: toVoid.map((c) => c.id) } },
      data: { status: CommissionStatus.VOIDED, voidReason: reason },
    });

    const creditedTotal = toVoid
      .filter((c) => c.status === CommissionStatus.CREDITED)
      .reduce((sum, c) => sum + c.amountCents, 0);
    if (creditedTotal > 0) {
      const partner = await this.prisma.referralPartner.findUnique({
        where: { id: toVoid[0].partnerId },
        select: { creditBalanceCents: true },
      });
      const clawback = Math.min(creditedTotal, partner?.creditBalanceCents ?? 0);
      if (clawback > 0) {
        await this.prisma.referralPartner.update({
          where: { id: toVoid[0].partnerId },
          data: { creditBalanceCents: { decrement: clawback } },
        });
      }
    }
  }

  // ─── Partner-facing (partners.formamd.com) ──────────────────────────────

  async getMe(partnerId: string) {
    const partner = await this.prisma.referralPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new NotFoundException('Partner not found');
    const { password, ...safe } = partner;
    return safe;
  }

  async getStats(partnerId: string) {
    const [clicks, signedUp, qualified, owedAgg, paidAgg, creditedAgg, partner] = await Promise.all([
      this.prisma.partnerReferral.count({ where: { partnerId } }),
      this.prisma.partnerReferral.count({ where: { partnerId, status: { in: [PartnerReferralStatus.SIGNED_UP, PartnerReferralStatus.QUALIFIED] } } }),
      this.prisma.partnerReferral.count({ where: { partnerId, status: PartnerReferralStatus.QUALIFIED } }),
      this.prisma.commission.aggregate({ where: { partnerId, status: CommissionStatus.OWED }, _sum: { amountCents: true } }),
      this.prisma.commission.aggregate({ where: { partnerId, status: CommissionStatus.PAID }, _sum: { amountCents: true } }),
      this.prisma.commission.aggregate({ where: { partnerId, status: CommissionStatus.CREDITED }, _sum: { amountCents: true } }),
      this.prisma.referralPartner.findUnique({ where: { id: partnerId }, select: { creditBalanceCents: true, creditActiveEmail: true, email: true } }),
    ]);

    return {
      totalClicks: clicks,
      totalSignups: signedUp,
      totalQualified: qualified,
      totalOwedCents: owedAgg._sum.amountCents ?? 0, // legacy, pre-credit-conversion only
      totalPaidCents: paidAgg._sum.amountCents ?? 0,
      totalCreditedCents: creditedAgg._sum.amountCents ?? 0, // lifetime earned as credit (spent or not)
      creditBalanceCents: partner?.creditBalanceCents ?? 0, // spendable right now
      creditActiveEmail: partner?.creditActiveEmail || partner?.email || null,
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

  /**
   * Partner sets/updates their US bank details (ACH) — what admin needs to actually wire
   * a manual payout. Light validation only (routing number is always 9 digits in the US);
   * this is a manual-transfer workflow, not a real ACH integration, so we don't verify the
   * account with a bank.
   */
  async updateBankDetails(
    partnerId: string,
    data: {
      bankAccountHolderName: string;
      bankName: string;
      bankAccountType: 'checking' | 'savings';
      bankRoutingNumber: string;
      bankAccountNumber: string;
    },
  ) {
    const routing = data.bankRoutingNumber.replace(/\s/g, '');
    if (!/^\d{9}$/.test(routing)) {
      throw new BadRequestException('Routing number must be exactly 9 digits (US ABA routing number).');
    }
    const accountNumber = data.bankAccountNumber.replace(/\s/g, '');
    if (!/^\d{4,17}$/.test(accountNumber)) {
      throw new BadRequestException('Account number looks invalid.');
    }
    if (!['checking', 'savings'].includes(data.bankAccountType)) {
      throw new BadRequestException('Account type must be "checking" or "savings".');
    }

    const updated = await this.prisma.referralPartner.update({
      where: { id: partnerId },
      data: {
        bankAccountHolderName: data.bankAccountHolderName,
        bankName: data.bankName,
        bankAccountType: data.bankAccountType,
        bankRoutingNumber: routing,
        bankAccountNumber: accountNumber,
        bankDetailsUpdatedAt: new Date(),
      },
    });
    const { password, ...safe } = updated;
    return safe;
  }

  /** Request a payout of whatever is currently OWED. One pending request at a time. */
  async requestPayout(partnerId: string, note?: string) {
    const partner = await this.prisma.referralPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new NotFoundException('Partner not found');
    if (!partner.bankAccountNumber || !partner.bankRoutingNumber) {
      throw new BadRequestException('Add your bank details before requesting a payout.');
    }

    const existingPending = await this.prisma.payoutRequest.findFirst({
      where: { partnerId, status: 'PENDING' },
    });
    if (existingPending) {
      throw new BadRequestException('You already have a pending payout request.');
    }

    const owedAgg = await this.prisma.commission.aggregate({
      where: { partnerId, status: CommissionStatus.OWED },
      _sum: { amountCents: true },
    });
    const amountCents = owedAgg._sum.amountCents ?? 0;
    if (amountCents <= 0) {
      throw new BadRequestException('Nothing owed right now.');
    }

    return this.prisma.payoutRequest.create({
      data: { partnerId, amountCents, note },
    });
  }

  async getPayoutRequests(partnerId: string) {
    return this.prisma.payoutRequest.findMany({
      where: { partnerId },
      orderBy: { requestedAt: 'desc' },
      include: { payoutBatch: true },
    });
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

  // ─── Platform credit (redeeming commission earnings as a signup/subscription discount) ──

  /**
   * Look up spendable partner credit for a given email — the ONE thing the signup
   * and subscription flows need. Pure email match, no partner login required at
   * redemption time. Matches creditActiveEmail if set, else the partner's own
   * account email (that's the default until they verify a different one).
   */
  async findAvailableCreditByEmail(email: string): Promise<{ partnerId: string; availableCents: number } | null> {
    const normalized = email.toLowerCase().trim();
    if (!normalized) return null;

    const partner = await this.prisma.referralPartner.findFirst({
      where: {
        isActive: true,
        creditBalanceCents: { gt: 0 },
        OR: [
          { creditActiveEmail: normalized },
          { AND: [{ creditActiveEmail: null }, { email: normalized }] },
        ],
      },
      select: { id: true, creditBalanceCents: true },
    });
    if (!partner) return null;
    return { partnerId: partner.id, availableCents: partner.creditBalanceCents };
  }

  /** Spend up to `cents` of a partner's credit. Returns how much was actually deducted. */
  async spendCredit(partnerId: string, cents: number): Promise<number> {
    if (cents <= 0) return 0;
    const partner = await this.prisma.referralPartner.findUnique({
      where: { id: partnerId },
      select: { creditBalanceCents: true },
    });
    const spend = Math.min(cents, partner?.creditBalanceCents ?? 0);
    if (spend <= 0) return 0;
    await this.prisma.referralPartner.update({
      where: { id: partnerId },
      data: { creditBalanceCents: { decrement: spend } },
    });
    return spend;
  }

  /**
   * Request switching creditActiveEmail to a new address. Does NOT change anything
   * yet — only sends a 6-digit code to the new email. The old email keeps working
   * until verifyEmailChange succeeds, so credit is never left unredeemable mid-switch.
   */
  async requestCreditEmailChange(partnerId: string, newEmail: string) {
    const normalized = newEmail.toLowerCase().trim();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new BadRequestException('Enter a valid email address');
    }
    const partner = await this.prisma.referralPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new NotFoundException('Partner not found');

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await this.prisma.partnerCreditEmailVerification.create({
      data: {
        partnerId,
        newEmail: normalized,
        code,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      },
    });

    await this.mailerService.sendEmail(
      normalized,
      'Verify your email for FormaMD platform credit',
      `Your verification code is ${code}. It expires in 15 minutes.\n\nEnter this code in the Partners Portal to start using your platform credit with this email address.`,
      `<p>Your verification code is <strong style="font-size:20px;letter-spacing:2px;">${code}</strong>.</p><p>It expires in 15 minutes.</p><p>Enter this code in the Partners Portal to start using your platform credit with this email address.</p>`,
    );

    return { success: true, message: `Verification code sent to ${normalized}` };
  }

  /** Verify the code and, on success, switch creditActiveEmail to the new address. */
  async verifyCreditEmailChange(partnerId: string, code: string) {
    const pending = await this.prisma.partnerCreditEmailVerification.findFirst({
      where: { partnerId, code, verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) throw new BadRequestException('Invalid or expired code');

    await this.prisma.$transaction([
      this.prisma.partnerCreditEmailVerification.update({
        where: { id: pending.id },
        data: { verifiedAt: new Date() },
      }),
      this.prisma.referralPartner.update({
        where: { id: partnerId },
        data: { creditActiveEmail: pending.newEmail },
      }),
    ]);

    return { success: true, creditActiveEmail: pending.newEmail };
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

  /** List payout requests, with the partner's bank details attached (admin needs these to wire the transfer). */
  async adminListPayoutRequests(status?: 'PENDING' | 'COMPLETED' | 'REJECTED') {
    return this.prisma.payoutRequest.findMany({
      where: status ? { status } : {},
      orderBy: { requestedAt: 'desc' },
      include: {
        partner: {
          select: {
            name: true,
            email: true,
            bankAccountHolderName: true,
            bankName: true,
            bankAccountType: true,
            bankRoutingNumber: true,
            bankAccountNumber: true,
          },
        },
        payoutBatch: true,
      },
    });
  }

  /**
   * Admin fulfills a payout request: pays out every commission currently OWED for that
   * partner (not just what was owed at request time — if more accrued since, a manual
   * transfer would naturally cover it in one go), creates the PayoutBatch, and links it
   * back to the request so the partner sees "Completed" the next time they check.
   */
  async adminFulfillPayoutRequest(requestId: string, data: { method?: string; reference?: string; note?: string }) {
    const request = await this.prisma.payoutRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Payout request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`This request is already ${request.status.toLowerCase()}.`);
    }

    const owedCommissions = await this.prisma.commission.findMany({
      where: { partnerId: request.partnerId, status: CommissionStatus.OWED },
    });
    if (owedCommissions.length === 0) {
      throw new BadRequestException('No OWED commissions found for this partner — nothing to pay out.');
    }
    const totalCents = owedCommissions.reduce((sum, c) => sum + c.amountCents, 0);

    const batch = await this.prisma.payoutBatch.create({
      data: {
        partnerId: request.partnerId,
        totalCents,
        method: data.method,
        reference: data.reference,
        note: data.note,
      },
    });

    await this.prisma.commission.updateMany({
      where: { id: { in: owedCommissions.map((c) => c.id) } },
      data: { status: CommissionStatus.PAID, paidAt: new Date(), payoutBatchId: batch.id },
    });

    return this.prisma.payoutRequest.update({
      where: { id: requestId },
      data: { status: 'COMPLETED', completedAt: new Date(), payoutBatchId: batch.id },
      include: { payoutBatch: true },
    });
  }

  async adminRejectPayoutRequest(requestId: string, note?: string) {
    const request = await this.prisma.payoutRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Payout request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException(`This request is already ${request.status.toLowerCase()}.`);
    }
    return this.prisma.payoutRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', completedAt: new Date(), note: note ?? request.note },
    });
  }
}
