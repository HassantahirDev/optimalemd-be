import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '../mailer/mailer.service';
import { CreditEvent, CreditStatus, Prisma } from '@prisma/client';
import Stripe from 'stripe';

const CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function creditExpiresAt(): Date {
  return new Date(Date.now() + CREDIT_TTL_MS);
}

/** WHERE clause for PENDING events that have not yet expired. */
function activePendingFilter(patientId: string): Prisma.CreditEventWhereInput {
  const now = new Date();
  return {
    patientId,
    status: CreditStatus.PENDING,
    OR: [
      { expiresAt: null },
      { expiresAt: { gt: now } },
    ],
  };
}

@Injectable()
export class ReferralService {
  private stripeClient: Stripe;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private mailerService: MailerService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY') || '';
    this.stripeClient = new Stripe(stripeKey, { apiVersion: '2025-10-29.clover' as any });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async generateReferralCode(): Promise<string> {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code: string;
    let exists = true;
    while (exists) {
      code =
        'OPT-' +
        Array.from({ length: 6 }, () =>
          chars[Math.floor(Math.random() * chars.length)],
        ).join('');
      const found = await this.prisma.user.findUnique({ where: { referralCode: code } });
      exists = !!found;
    }
    return code!;
  }

  /**
   * Mark any PENDING credit events that have passed their expiresAt as EXPIRED.
   * Also zeroes creditRolloverPct if no active pending events remain.
   */
  private async expireOldCredits(patientId: string): Promise<void> {
    const now = new Date();

    const { count } = await this.prisma.creditEvent.updateMany({
      where: {
        patientId,
        status: CreditStatus.PENDING,
        expiresAt: { lt: now },
      },
      data: { status: CreditStatus.EXPIRED },
    });

    if (count > 0) {
      const remaining = await this.prisma.creditEvent.count({
        where: activePendingFilter(patientId),
      });
      if (remaining === 0) {
        await this.prisma.user.update({
          where: { id: patientId },
          data: { creditRolloverPct: 0 },
        });
      }
    }
  }

  /** Fetch non-expired PENDING credit events for a patient. */
  private getActivePendingEvents(patientId: string): Promise<CreditEvent[]> {
    return this.prisma.creditEvent.findMany({
      where: activePendingFilter(patientId),
    });
  }

  /**
   * Compute the total dollar credit from a set of pending events.
   * Events with dollarAmount use flat dollars; legacy events fall back to percentAmount
   * against the subscription price.
   */
  private computeTotalCents(
    pendingEvents: CreditEvent[],
    rolloverPct: number,
    unitAmount: number,
  ): number {
    let cents = 0;
    for (const e of pendingEvents) {
      if ((e.type as string) === 'FREE_MONTH') {
        // 100% of the subscription invoice
        cents += unitAmount;
      } else if (e.dollarAmount != null && e.dollarAmount > 0) {
        cents += Math.round(e.dollarAmount * 100);
      } else {
        cents += Math.floor((unitAmount * e.percentAmount) / 100);
      }
    }
    if (rolloverPct > 0) {
      cents += Math.floor((unitAmount * rolloverPct) / 100);
    }
    return cents;
  }

  /**
   * For subscribers: immediately convert all active pending credits into a Stripe
   * customer balance credit so the discount is auto-applied to their next invoice.
   * Stripe carries unused balance forward indefinitely — unlimited rollover.
   */
  private async applyAllSubscriberCredits(patientId: string): Promise<void> {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient?.isSubscribed || !patient.stripeCustomerId || !patient.stripeSubscriptionId) return;

    await this.expireOldCredits(patientId);

    const freshPatient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!freshPatient) return;

    const pendingEvents = await this.getActivePendingEvents(patientId);
    if (pendingEvents.length === 0 && freshPatient.creditRolloverPct <= 0) return;

    const subscription = await this.stripeClient.subscriptions.retrieve(
      patient.stripeSubscriptionId,
      { expand: ['items.data.price'] },
    );
    const unitAmount = (subscription.items.data[0]?.price as any)?.unit_amount ?? 0;

    const discountCents = this.computeTotalCents(pendingEvents, freshPatient.creditRolloverPct, unitAmount);
    if (discountCents <= 0) return;

    await this.stripeClient.customers.createBalanceTransaction(patient.stripeCustomerId, {
      amount: -discountCents,
      currency: 'usd',
      description: `$${(discountCents / 100).toFixed(2)} referral/review credit – applied to next subscription invoice`,
    });

    const updates = pendingEvents.map((e) =>
      this.prisma.creditEvent.update({
        where: { id: e.id },
        data: {
          status: CreditStatus.APPLIED,
          appliedAt: new Date(),
          appliedToInvoice: 'stripe-balance',
        },
      }),
    );

    await this.prisma.$transaction([
      ...updates,
      this.prisma.user.update({
        where: { id: patientId },
        data: { creditRolloverPct: 0 },
      }),
    ]);
  }

  // ─── Patient-facing ─────────────────────────────────────────────────────────

  async getOrCreateReferralCode(patientId: string) {
    let patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException('Patient not found');

    if (!patient.referralCode) {
      const code = await this.generateReferralCode();
      patient = await this.prisma.user.update({
        where: { id: patientId },
        data: { referralCode: code },
      });
    }

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'https://optimalmd-mu.vercel.app';
    return {
      referralCode: patient.referralCode,
      referralUrl: `${frontendUrl}/register?ref=${patient.referralCode}`,
    };
  }

  async getReferralStats(patientId: string) {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException('Patient not found');

    await this.expireOldCredits(patientId);

    const [referrals, creditEvents, freshPatient] = await Promise.all([
      this.prisma.referral.findMany({ where: { referrerId: patientId } }),
      this.getActivePendingEvents(patientId),
      this.prisma.user.findUnique({ where: { id: patientId } }),
    ]);

    const pendingReferrals = referrals.filter(r => r.status === 'PENDING').length;
    const qualifiedReferrals = referrals.filter(r => r.status === 'QUALIFIED').length;

    // Dollar-based credits (new program)
    const pendingCreditDollar = creditEvents.reduce((sum, e) => {
      if (e.dollarAmount != null && e.dollarAmount > 0) return sum + e.dollarAmount;
      return sum + e.percentAmount; // legacy percent events kept as-is for display
    }, 0) + (freshPatient?.creditRolloverPct ?? 0);

    // Legacy percent fields kept for backwards compatibility
    const pendingCreditPct = creditEvents.reduce((sum, e) => sum + e.percentAmount, 0) +
      (freshPatient?.creditRolloverPct ?? 0);
    const appliedPct = Math.min(pendingCreditPct, 100);
    const rolloverPct = Math.max(0, pendingCreditPct - 100);

    const nearestExpiry =
      creditEvents
        .map(e => e.expiresAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    const { referralCode, referralUrl } = await this.getOrCreateReferralCode(patientId);

    // Cycle position (1-6 within current cycle)
    const cycleBase = freshPatient?.referralCycleBase ?? 0;
    const cyclePosition = qualifiedReferrals - cycleBase; // how many qualified in this cycle
    const nextReward = this.getNextRewardDescription(cyclePosition + 1); // what the NEXT referral earns

    return {
      referralCode,
      referralUrl,
      pendingReferrals,
      qualifiedReferrals,
      totalReferrals: referrals.length,
      pendingCreditDollar,
      // $ referral credit a non-member's next booking deducts (0 for members).
      appointmentCreditDollars: (await this.getAppointmentDollarCreditCents(patientId)) / 100,
      pendingCreditPct,
      appliedPct,
      rolloverPct,
      nearestExpiry,
      reviewToggled: freshPatient?.reviewToggled ?? false,
      reviewCreditApplied: freshPatient?.reviewCreditApplied ?? false,
      isSubscribed: freshPatient?.isSubscribed ?? false,
      // Cycle info
      cyclePosition,          // 0-5, position within current 6-referral cycle
      nextReward,             // human-readable description of next reward
      platformCreditBalance: freshPatient?.platformCreditBalance ?? 0,
      awaitingCycleReset: freshPatient?.awaitingCycleReset ?? false,
    };
  }

  async toggleReviewStatus(patientId: string) {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (patient.reviewToggled) {
      throw new BadRequestException('You have already submitted your review for verification.');
    }
    await this.prisma.user.update({
      where: { id: patientId },
      data: { reviewToggled: true, reviewToggledAt: new Date() },
    });
    return {
      success: true,
      message: 'Review submitted for verification. Our team will apply your credit shortly.',
    };
  }

  private getNextRewardDescription(nextCyclePosition: number): string {
    const pos = ((nextCyclePosition - 1) % 6) + 1; // normalise to 1-6
    if (pos === 3) return '1 month of membership FREE (monthly subscription)';
    if (pos === 6) return '$300 platform credit (use anywhere on the platform)';
    return '$50 off your monthly subscription';
  }

  // ─── Admin-facing ────────────────────────────────────────────────────────────

  async getPendingReviews() {
    return this.prisma.user.findMany({
      where: { reviewToggled: true, reviewCreditApplied: false },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        primaryEmail: true,
        reviewToggledAt: true,
        reviewCreditApplied: true,
      },
      orderBy: { reviewToggledAt: 'asc' },
    });
  }

  async applyReviewCredit(patientId: string) {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (patient.reviewCreditApplied) {
      throw new BadRequestException('Review credit has already been applied for this patient.');
    }
    if (!patient.reviewToggled) {
      throw new BadRequestException('Patient has not toggled review status yet.');
    }

    await this.prisma.$transaction([
      this.prisma.creditEvent.create({
        data: {
          patientId,
          type: 'REVIEW',
          percentAmount: 5,
          status: CreditStatus.PENDING,
          expiresAt: creditExpiresAt(),
        },
      }),
      this.prisma.user.update({
        where: { id: patientId },
        data: { reviewCreditApplied: true },
      }),
    ]);

    try {
      await this.applyAllSubscriberCredits(patientId);
    } catch (err) {
      console.error('Subscriber Stripe balance update failed after review credit (non-fatal):', err);
    }

    try {
      const email = patient.primaryEmail ?? patient.email ?? null;
      if (email) {
        const name = `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'there';
        await this.mailerService.sendReviewCreditEmail(email, name, 5, patient.isSubscribed ?? false);
      }
    } catch (err) {
      console.error('Review credit email failed (non-fatal):', err);
    }

    return { success: true, message: '5% review credit applied successfully.' };
  }

  async getAllReferrals(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [referrals, total] = await Promise.all([
      this.prisma.referral.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          referrer: {
            select: { id: true, firstName: true, lastName: true, email: true, primaryEmail: true },
          },
          referred: {
            select: { id: true, firstName: true, lastName: true, email: true, primaryEmail: true },
          },
        },
      }),
      this.prisma.referral.count(),
    ]);
    return { referrals, total, page, limit };
  }

  async getPatientCredits(patientId: string) {
    return this.prisma.creditEvent.findMany({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markCreditApplied(creditEventId: string, appliedToInvoice?: string) {
    const event = await this.prisma.creditEvent.findUnique({ where: { id: creditEventId } });
    if (!event) throw new NotFoundException('Credit event not found');
    if (event.status === CreditStatus.APPLIED) {
      throw new BadRequestException('Credit already marked as applied.');
    }
    return this.prisma.creditEvent.update({
      where: { id: creditEventId },
      data: {
        status: CreditStatus.APPLIED,
        appliedAt: new Date(),
        appliedToInvoice: appliedToInvoice || null,
      },
    });
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  async createReferralOnSignup(referralCode: string, referredEmail: string, referredId: string) {
    const referrer = await this.prisma.user.findUnique({ where: { referralCode } });
    if (!referrer) return;
    if (referrer.id === referredId) return;

    const existing = await this.prisma.referral.findUnique({ where: { referredId } });
    if (existing) return;

    await this.prisma.referral.create({
      data: { referrerId: referrer.id, referredId, referredEmail, status: 'PENDING' },
    });
  }

  /**
   * Cycle reward structure (repeating every 6 qualified referrals):
   *   Position 1 → $50 off next subscription
   *   Position 2 → $50 off next subscription
   *   Position 3 → 1 month FREE (100% off next subscription)
   *   Position 4 → $50 off next subscription
   *   Position 5 → $50 off next subscription
   *   Position 6 → $300 platform credit (in-platform only, no cash)
   *                → cycle resets ONLY when the $300 balance is fully consumed
   */
  async qualifyReferral(patientId: string) {
    const referral = await this.prisma.referral.findUnique({
      where: { referredId: patientId },
    });
    if (!referral || referral.status !== 'PENDING') return;

    const referrer = await this.prisma.user.findUnique({ where: { id: referral.referrerId } });
    if (!referrer) return;

    // Count referrals already QUALIFIED (before this one)
    const qualifiedBefore = await this.prisma.referral.count({
      where: { referrerId: referral.referrerId, status: 'QUALIFIED' },
    });
    const newTotal = qualifiedBefore + 1;
    const cyclePosition = newTotal - (referrer.referralCycleBase ?? 0); // 1-6 within current cycle

    const transactions: any[] = [
      this.prisma.referral.update({
        where: { id: referral.id },
        data: { status: 'QUALIFIED', qualifiedAt: new Date() },
      }),
    ];

    let rewardDescription = '';
    let emailAmount: number | null = null;
    let isFreeMonth = false;
    let isPlatformCredit = false;

    if (cyclePosition === 3) {
      // Free month: 100% off next subscription invoice via Stripe balance
      transactions.push(
        this.prisma.creditEvent.create({
          data: {
            patientId: referral.referrerId,
            type: 'FREE_MONTH' as any,
            percentAmount: 100,
            dollarAmount: null,
            status: CreditStatus.PENDING,
            referralId: referral.id,
            expiresAt: null,
          },
        }),
      );
      rewardDescription = 'one free month of membership';
      isFreeMonth = true;
    } else if (cyclePosition === 6) {
      // $300 platform credit — tracked on User, NOT as a Stripe balance credit
      transactions.push(
        this.prisma.user.update({
          where: { id: referral.referrerId },
          data: {
            platformCreditBalance: { increment: 300 },
            awaitingCycleReset: true,
          },
        }),
      );
      rewardDescription = '$300 platform credit added to your account';
      isPlatformCredit = true;
    } else {
      // Positions 1, 2, 4, 5 → $50
      transactions.push(
        this.prisma.creditEvent.create({
          data: {
            patientId: referral.referrerId,
            type: 'REFERRAL',
            percentAmount: 0,
            dollarAmount: 50,
            status: CreditStatus.PENDING,
            referralId: referral.id,
            expiresAt: null,
          },
        }),
      );
      rewardDescription = '$50 off your next subscription payment';
      emailAmount = 50;
    }

    await this.prisma.$transaction(transactions);

    // For $50 and free month: push to Stripe subscriber balance immediately
    if (!isPlatformCredit) {
      try {
        await this.applyAllSubscriberCredits(referral.referrerId);
      } catch (err) {
        console.error('Subscriber Stripe balance update failed after referral qualify (non-fatal):', err);
      }
    }

    try {
      const freshReferrer = await this.prisma.user.findUnique({ where: { id: referral.referrerId } });
      if (freshReferrer) {
        const email = freshReferrer.primaryEmail ?? freshReferrer.email ?? null;
        if (email) {
          const name = `${freshReferrer.firstName || ''} ${freshReferrer.lastName || ''}`.trim() || 'there';
          if (emailAmount) {
            await this.mailerService.sendReferralCreditEmail(email, name, emailAmount, freshReferrer.isSubscribed ?? false);
          }
          // TODO: send custom emails for free month and $300 credit when email templates are ready
        }
      }
    } catch (err) {
      console.error('Referral credit email failed (non-fatal):', err);
    }
  }

  /**
   * Deduct from the referrer's $300 platform credit balance.
   * Called when a payment uses platform credit.
   * When balance hits 0 and awaitingCycleReset is true, resets the referral cycle.
   */
  async consumePlatformCredit(patientId: string, amountToConsume: number): Promise<number> {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient || patient.platformCreditBalance <= 0) return 0;

    const consumed = Math.min(amountToConsume, patient.platformCreditBalance);
    const newBalance = patient.platformCreditBalance - consumed;

    const updateData: any = { platformCreditBalance: newBalance };

    // If balance hit 0 and we were waiting for cycle reset, reset it now
    if (newBalance <= 0 && patient.awaitingCycleReset) {
      const qualifiedCount = await this.prisma.referral.count({
        where: { referrerId: patientId, status: 'QUALIFIED' },
      });
      updateData.platformCreditBalance = 0;
      updateData.awaitingCycleReset = false;
      updateData.referralCycleBase = qualifiedCount; // next cycle starts here
    }

    await this.prisma.user.update({ where: { id: patientId }, data: updateData });
    return consumed; // dollars consumed from platform credit
  }

  /**
   * Flat-dollar referral credit ($50 each) a non-member can take off a booking, in
   * cents. Members get theirs on the membership invoice instead, so this is 0 for them.
   * The booking page shows this and createPaymentIntent deducts it — same number.
   */
  async getAppointmentDollarCreditCents(patientId: string): Promise<number> {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId }, select: { isSubscribed: true } });
    if (!patient || patient.isSubscribed) return 0;
    await this.expireOldCredits(patientId);
    const events = await this.getActivePendingEvents(patientId);
    return events
      .filter((e) => (e.type as string) !== 'FREE_MONTH' && e.dollarAmount != null && e.dollarAmount > 0)
      .reduce((sum, e) => sum + Math.round(e.dollarAmount! * 100), 0);
  }

  /**
   * After a booking is paid: spend the credits it used.
   * - Dollar credits: exactly `dollarCentsUsed` (what was taken off the charge), oldest
   *   first. A credit only partly used keeps its remainder for the next booking.
   * - Percent credits (legacy review credits): the booking page already discounted
   *   by them, so they're all marked used, as before.
   * Safe to call twice for one appointment: credits already tied to it aren't re-spent.
   */
  async applyCreditsToAppointment(patientId: string, appointmentId: string, dollarCentsUsed = 0): Promise<void> {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient) return;

    // Subscribers get credits applied to their subscription billing, not appointments
    if (patient.isSubscribed) return;

    const alreadyApplied = await this.prisma.creditEvent.count({
      where: { patientId, appliedToInvoice: appointmentId },
    });
    if (alreadyApplied > 0) return;

    await this.expireOldCredits(patientId);

    const pendingEvents = await this.getActivePendingEvents(patientId);
    const isDollar = (e: CreditEvent) =>
      (e.type as string) !== 'FREE_MONTH' && e.dollarAmount != null && e.dollarAmount > 0;
    // Everything that isn't a dollar credit (review %, free month, legacy %) is what
    // the booking page's percent discount used — spent exactly as before.
    const percentEvents = pendingEvents.filter((e) => !isDollar(e));
    const dollarEvents = pendingEvents
      .filter(isDollar)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const now = new Date();
    const updates: any[] = percentEvents.map((e) =>
      this.prisma.creditEvent.update({
        where: { id: e.id },
        data: { status: CreditStatus.APPLIED, appliedAt: now, appliedToInvoice: appointmentId },
      }),
    );

    let remaining = Math.max(0, Math.round(dollarCentsUsed));
    for (const e of dollarEvents) {
      if (remaining <= 0) break;
      const eventCents = Math.round(e.dollarAmount! * 100);
      if (eventCents <= remaining) {
        updates.push(
          this.prisma.creditEvent.update({
            where: { id: e.id },
            data: { status: CreditStatus.APPLIED, appliedAt: now, appliedToInvoice: appointmentId },
          }),
        );
        remaining -= eventCents;
      } else {
        // Partly used: record the used part as applied, keep the rest pending.
        updates.push(
          this.prisma.creditEvent.update({
            where: { id: e.id },
            data: { dollarAmount: (eventCents - remaining) / 100 },
          }),
          this.prisma.creditEvent.create({
            data: {
              patientId,
              type: e.type,
              percentAmount: 0,
              dollarAmount: remaining / 100,
              status: CreditStatus.APPLIED,
              referralId: e.referralId,
              appliedAt: now,
              appliedToInvoice: appointmentId,
            },
          }),
        );
        remaining = 0;
      }
    }

    // The percent rollover was part of the booking page's percent discount too.
    const clearRollover = percentEvents.length > 0 || (patient.creditRolloverPct ?? 0) > 0;
    if (updates.length === 0 && !clearRollover) return;

    await this.prisma.$transaction([
      ...updates,
      ...(clearRollover
        ? [this.prisma.user.update({ where: { id: patientId }, data: { creditRolloverPct: 0 } })]
        : []),
    ]);
  }
}
