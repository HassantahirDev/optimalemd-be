import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SupplementsService } from '../supplements/supplements.service';
import { SUPPLEMENT_PI_KIND, SUPPLEMENTS_SERVICE } from '../supplements/supplements.catalog';
import { AppointmentsService } from '../appointments/appointments.service';
import { MailerService } from '../mailer/mailer.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { ReferralService } from '../referral/referral.service';
import { PaymentLedgerService } from '../payments/payment-ledger.service';
import { PartnersService } from '../partners/partners.service';
import { CreatePaymentIntentDto, ConfirmPaymentDto } from './dto';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private appointmentsService: AppointmentsService,
    private mailerService: MailerService,
    private googleCalendarService: GoogleCalendarService,
    private referralService: ReferralService,
    private paymentLedger: PaymentLedgerService,
    private partnersService: PartnersService,
    private moduleRef: ModuleRef,
  ) {
    const stripeKey = this.configService.get('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      console.error('STRIPE_SECRET_KEY is not configured in environment variables');
      throw new Error('STRIPE_SECRET_KEY is not configured. Please set it in your .env file.');
    }
    
    // Validate Stripe key format
    if (!stripeKey.startsWith('sk_test_') && !stripeKey.startsWith('sk_live_')) {
      console.error('Invalid Stripe secret key format. Key should start with sk_test_ or sk_live_');
      throw new Error('Invalid Stripe secret key format');
    }
    
    try {
    this.stripe = new Stripe(stripeKey, {
        apiVersion: '2025-10-29.clover' as any, // Latest stable Stripe API version
    });
      console.log('Stripe initialized successfully with key:', stripeKey.substring(0, 12) + '...');
    } catch (error: any) {
      console.error('Failed to initialize Stripe:', error);
      throw new Error(`Failed to initialize Stripe: ${error.message}`);
    }
  }

  /**
   * Create a payment intent for an appointment or welcome order
   */
  async createPaymentIntent(createPaymentIntentDto: CreatePaymentIntentDto) {
    const { appointmentId, welcomeOrderId, currency = 'usd' } = createPaymentIntentDto;
    let amount = createPaymentIntentDto.amount;

    let metadata: any = {};
    let description = '';

    let stripeCustomerId: string | undefined;
    let appointmentCreditApplied: { partnerId: string; appliedCents: number } | null = null;
    // $50 referral credits taken off this booking (non-members); spent once it's paid.
    let referralCreditCents = 0;

    if (appointmentId) {
      const appointment = await this.prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          patient: { select: { id: true, firstName: true, lastName: true, primaryEmail: true, stripeCustomerId: true } },
          doctor: { select: { id: true, firstName: true, lastName: true } },
          service: { select: { name: true } },
        },
      });

      if (!appointment) throw new NotFoundException('Appointment not found');
      if (appointment.isPaid) throw new BadRequestException('Appointment is already paid');

      // Referral $ credit (e.g. $50 per referral) — deducted here, authoritatively, from
      // the booking price the page sends. Members get 0 (theirs go on the membership
      // invoice). Leaves Stripe's 50-cent minimum, like the partner credit below.
      if (amount && amount > 0) {
        const available = await this.referralService.getAppointmentDollarCreditCents(appointment.patient.id);
        const amountCents = Math.round(amount * 100);
        referralCreditCents = Math.min(available, Math.max(0, amountCents - 50));
        if (referralCreditCents > 0) amount = (amountCents - referralCreditCents) / 100;
      }

      // Partner platform credit — same mechanism as the welcome-order signup fee.
      // Applied authoritatively here (never trust a client-sent discount), reserved
      // on the Payment row, and only actually spent from the partner's balance once
      // this payment truly succeeds (see confirmPayment).
      const appointmentCredit = await this.partnersService.findAvailableCreditByEmail(
        appointment.patient.primaryEmail || '',
      );
      if (appointmentCredit && appointmentCredit.availableCents > 0 && amount) {
        const amountCents = Math.round(amount * 100);
        // Stripe requires a minimum charge (50 cents) — cap the applied credit so the
        // appointment never lands in an unchargeable $0.01–$0.49 gap. A fully-covered
        // ($0) appointment isn't built yet (unlike the welcome order's confirm-free
        // path) — this leaves a minimum charge instead of erroring out.
        const maxApplyCents = Math.max(0, amountCents - 50);
        const applyCents = Math.min(appointmentCredit.availableCents, maxApplyCents);
        if (applyCents > 0) {
          amount = (amountCents - applyCents) / 100;
          appointmentCreditApplied = { partnerId: appointmentCredit.partnerId, appliedCents: applyCents };
        }
      }

      const patientName = `${appointment.patient.firstName} ${appointment.patient.lastName}`;
      const doctorName = appointment.doctor ? `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}` : 'Doctor TBD';
      const serviceName = appointment.service?.name || 'Consultation';

      // Ensure Stripe customer exists for this patient
      stripeCustomerId = appointment.patient.stripeCustomerId || undefined;
      if (!stripeCustomerId) {
        const customer = await this.stripe.customers.create({
          email: appointment.patient.primaryEmail || undefined,
          name: patientName,
          metadata: { userId: appointment.patient.id, type: 'patient' },
        });
        stripeCustomerId = customer.id;
        await this.prisma.user.update({ where: { id: appointment.patient.id }, data: { stripeCustomerId } });
      }

      metadata = {
        appointmentId,
        patientId: appointment.patient.id,
        patientName,
        patientEmail: appointment.patient.primaryEmail,
        doctorName,
        service: serviceName,
        type: 'appointment',
        ...(referralCreditCents > 0 && { referralCreditCents: String(referralCreditCents) }),
      };
      description = `Appointment – ${serviceName} | Patient: ${patientName} | ${doctorName}`;

    } else if (welcomeOrderId) {
      const welcomeOrder = await this.prisma.welcomeOrder.findUnique({
        where: { id: welcomeOrderId },
        include: { user: { select: { id: true, firstName: true, lastName: true, primaryEmail: true, stripeCustomerId: true } } },
      });

      if (!welcomeOrder) throw new NotFoundException('Welcome order not found');
      if (welcomeOrder.paymentStatus === 'SUCCEEDED') throw new BadRequestException('Welcome order is already paid');

      // Authoritative — never trust a client-sent amount here. finalAmount already
      // reflects any partner platform credit applied at order-creation time.
      amount = Number(welcomeOrder.finalAmount);

      const patientName = welcomeOrder.user
        ? `${welcomeOrder.user.firstName} ${welcomeOrder.user.lastName}`
        : welcomeOrder.email;

      stripeCustomerId = welcomeOrder.user?.stripeCustomerId || undefined;
      if (!stripeCustomerId && welcomeOrder.user) {
        const customer = await this.stripe.customers.create({
          email: welcomeOrder.email,
          name: patientName,
          metadata: { userId: welcomeOrder.user.id, type: 'patient' },
        });
        stripeCustomerId = customer.id;
        await this.prisma.user.update({ where: { id: welcomeOrder.user.id }, data: { stripeCustomerId } });
      }

      metadata = {
        welcomeOrderId,
        orderNumber: welcomeOrder.orderNumber,
        patientName,
        patientEmail: welcomeOrder.email,
        type: 'welcome_signup',
      };
      description = `Sign-Up Payment | Patient: ${patientName} | Order: ${welcomeOrder.orderNumber}`;

    } else {
      throw new BadRequestException('Either appointmentId or welcomeOrderId must be provided');
    }

    if (!amount || amount <= 0) throw new BadRequestException('Amount must be greater than 0');

    // Idempotency key scoped to the one appointment/welcome-order + amount being paid.
    // A retried or double-submitted request (double-click before the button disables, a
    // dropped-response retry, the checkout page reloaded mid-flow) reuses THIS SAME
    // PaymentIntent instead of Stripe creating a second, separate one — the same class of
    // fix already applied to the medication-subscription flow below (idemBase/-sub keys)
    // to prevent double charges; this is the appointment/welcome-order counterpart, which
    // never had the same protection.
    const idempotencyKey = appointmentId
      ? `pi-appt-${appointmentId}-${Math.round(amount * 100)}`
      : `pi-welcome-${welcomeOrderId}-${Math.round(amount * 100)}`;

    // Create payment intent
    let paymentIntent;
    try {
      paymentIntent = await this.stripe.paymentIntents.create(
        {
          amount: Math.round(amount * 100),
          currency,
          metadata,
          description,
          ...(stripeCustomerId && { customer: stripeCustomerId }),
          receipt_email: metadata.patientEmail,
        },
        { idempotencyKey },
      );
    } catch (stripeError: any) {
      console.error('Stripe API Error:', stripeError);
      throw new BadRequestException(
        stripeError.message || 'Failed to create payment intent with Stripe'
      );
    }

    if (!paymentIntent || !paymentIntent.client_secret) {
      console.error('Payment intent created but missing client_secret:', paymentIntent);
      throw new BadRequestException('Failed to generate payment client secret');
    }

    // Create (or replace) the payment record for this appointment. appointmentId is
    // @unique on Payment, so a retried/re-opened payment (e.g. clicking "Complete Payment"
    // again on an unpaid-reservation banner) hits an existing row from the first attempt —
    // upsert so it's updated with the fresh payment intent instead of crashing on the
    // unique constraint.
    if (appointmentId) {
      await this.prisma.payment.upsert({
        where: { appointmentId },
        create: {
          appointmentId,
          stripePaymentId: paymentIntent.id,
          amount,
          currency,
          status: 'PENDING',
          paymentIntent: paymentIntent.id,
          ...(appointmentCreditApplied && {
            partnerCreditPartnerId: appointmentCreditApplied.partnerId,
            partnerCreditAppliedCents: appointmentCreditApplied.appliedCents,
          }),
        },
        update: {
          stripePaymentId: paymentIntent.id,
          amount,
          currency,
          status: 'PENDING',
          paymentIntent: paymentIntent.id,
          paidAt: null,
          ...(appointmentCreditApplied && {
            partnerCreditPartnerId: appointmentCreditApplied.partnerId,
            partnerCreditAppliedCents: appointmentCreditApplied.appliedCents,
            partnerCreditDeducted: false,
          }),
        },
      });
    }
    // For welcome orders, we don't create a separate payment record
    // The payment info is stored in the welcome order itself

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount,
      currency,
    };
  }

  /**
   * Confirm payment and update appointment status
   */
  async confirmPayment(confirmPaymentDto: ConfirmPaymentDto) {
    const { paymentIntentId, appointmentId, isFreeAppointment, patientTimezone } = confirmPaymentDto;
    // Referral $ credit this payment deducted (set at createPaymentIntent) — spent below.
    let referralCreditCentsUsed = 0;

    // Handle free appointments
    if (isFreeAppointment) {
      console.log('Processing free appointment - skipping payment verification');
      
      // For free appointments, we don't need to verify payment intent
      // Just proceed with appointment confirmation
    } else {
      // Handle paid appointments
      if (!paymentIntentId) {
        throw new BadRequestException('Payment intent ID is required for paid appointments');
      }

    // Verify payment intent
    const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      throw new BadRequestException('Payment not completed');
    }
    referralCreditCentsUsed = parseInt(paymentIntent.metadata?.referralCreditCents || '0', 10) || 0;

    // Update payment status
    const updatedPayment = await this.prisma.payment.update({
      where: { paymentIntent: paymentIntentId },
      data: {
        status: 'SUCCEEDED',
        paidAt: new Date(),
      },
      select: {
        amount: true,
        appointmentId: true,
        partnerCreditPartnerId: true,
        partnerCreditAppliedCents: true,
        partnerCreditDeducted: true,
      },
    });

    // Actually spend the reserved partner credit now that payment truly succeeded —
    // never at payment-intent-creation time (see createPaymentIntent). Guarded by
    // partnerCreditDeducted so a retried confirm-payment call never double-spends.
    if (
      updatedPayment.partnerCreditPartnerId &&
      (updatedPayment.partnerCreditAppliedCents ?? 0) > 0 &&
      !updatedPayment.partnerCreditDeducted
    ) {
      await this.partnersService.spendCredit(updatedPayment.partnerCreditPartnerId, updatedPayment.partnerCreditAppliedCents!);
      await this.prisma.payment.update({
        where: { paymentIntent: paymentIntentId },
        data: { partnerCreditDeducted: true },
      });
    }

    // --- Dual-write consult payment into the unified ledger (additive; Part A) ---
    // Existing Payment logic above is untouched.
    const paidAppt = await this.prisma.appointment.findUnique({
      where: { id: updatedPayment.appointmentId },
      select: { patientId: true },
    });
    // No line items for a flat consult fee — the receipt link is what "expand" shows
    // for this row instead. Best-effort; never blocks the write if Stripe can't be
    // reached for it right now.
    const receiptUrl = await this.getReceiptUrl(paymentIntentId);
    await this.paymentLedger.upsertFromStripe({
      stripePaymentIntentId: paymentIntentId,
      userId: paidAppt?.patientId ?? null,
      appointmentId: updatedPayment.appointmentId,
      channel: 'PLATFORM',
      category: 'APPOINTMENT',
      billing: 'ONE_TIME',
      amount: Number(updatedPayment.amount),
      currency: 'usd',
      status: 'SUCCEEDED',
      paidAt: new Date(),
      receiptUrl,
      note: 'Consultation / appointment payment',
    });
    }

    // Generate Google Meet link for the appointment
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
            primaryEmail: true,
          },
        },
        doctor: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        service: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    const patientName = `${appointment.patient.firstName} ${appointment.patient.lastName}`;
    const doctorName = appointment.doctor ? `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}` : 'To be assigned';
    
    // Generate Google Meet link with patient's timezone
    const additionalServices = (appointment as any).additionalServices as Array<{ id: string; name: string; duration: number }> | null;
    const meetResult = await this.googleCalendarService.generateMeetLink(
      appointment.appointmentDate,
      appointment.appointmentTime,
      appointment.duration,
      doctorName,
      patientName,
      appointment.service.name,
      appointment.patient.primaryEmail || undefined, // Pass patient email
      appointment.doctor?.email, // Pass doctor email if available
      patientTimezone, // Pass patient's timezone for correct event time
      additionalServices || undefined,
      appointment.doctorId || undefined
    );

    // Update appointment status to confirmed, mark as paid, and store Google Meet link and event ID
    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: 'CONFIRMED',
        isPaid: true,
        confirmedAt: new Date(),
        googleMeetLink: meetResult.meetLink,
        googleEventId: meetResult.eventId || null,
      },
      include: {
        patient: {
          select: {
            firstName: true,
            lastName: true,
            primaryEmail: true,
          },
        },
        doctor: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        service: {
          select: {
            name: true,
          },
        },
      },
    });

    // NOTE: Patient email is already included when creating the event via generateMeetLink
    // No need to update the event again, which would cause duplicate email notifications

    // Update slot availability (if slotId exists)
    if (updatedAppointment.slotId) {
      await this.prisma.slot.update({
        where: { id: updatedAppointment.slotId },
        data: {
          isAvailable: false,
        },
      });
    }

    // Qualify referral if this is the patient's first paid appointment
    try {
      const confirmedCount = await this.prisma.appointment.count({
        where: {
          patientId: appointment.patientId,
          isPaid: true,
          status: 'CONFIRMED',
        },
      });
      if (confirmedCount === 1) {
        await this.referralService.qualifyReferral(appointment.patientId);
      }
    } catch (refErr) {
      console.error('Referral qualification failed (non-fatal):', refErr);
    }

    // Apply any pending credits to this appointment
    try {
      await this.referralService.applyCreditsToAppointment(appointment.patientId, appointmentId, referralCreditCentsUsed);
    } catch (creditErr) {
      console.error('Credit application failed (non-fatal):', creditErr);
    }

    // Send email notifications to both patient and doctor (if assigned)
    try {
      const patientName = `${updatedAppointment.patient.firstName} ${updatedAppointment.patient.lastName}`;
      const appointmentDate = updatedAppointment.appointmentDate.toISOString().split('T')[0];
      const amount = updatedAppointment.amount.toString();
      const doctorName = updatedAppointment.doctor ? `Dr. ${updatedAppointment.doctor.firstName} ${updatedAppointment.doctor.lastName}` : 'To be assigned';

      // Send confirmation email to patient with their timezone
      const additionalServices = (updatedAppointment as any).additionalServices as Array<{ id: string; name: string; duration: number }> | null;
      await this.mailerService.sendAppointmentConfirmationEmail(
        updatedAppointment.patient.primaryEmail || '',
        patientName,
        doctorName,
        updatedAppointment.service.name,
        appointmentDate,
        updatedAppointment.appointmentTime,
        amount,
        updatedAppointment.googleMeetLink || undefined,
        patientTimezone, // Use patient's timezone from frontend
        additionalServices || undefined
      );

      // Send email to doctor if assigned
      if (updatedAppointment.doctor && updatedAppointment.doctor.email) {
        await this.mailerService.sendDoctorAppointmentNotification(
          updatedAppointment.doctor.email,
          doctorName,
          patientName,
          updatedAppointment.service.name,
          appointmentDate,
          updatedAppointment.appointmentTime,
          amount,
          updatedAppointment.googleMeetLink || undefined,
          'America/Chicago',
          additionalServices || undefined
        );
      }
    } catch (error) {
      console.error('Failed to send confirmation email:', error);
      // Don't throw error to avoid breaking the payment confirmation process
    }

    return {
      success: true,
      message: 'Payment confirmed and appointment booked successfully',
    };
  }

  /**
   * Get payment status
   */
  async getPaymentStatus(paymentIntentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: {
        appointment: {
          include: {
            patient: { select: { firstName: true, lastName: true, primaryEmail: true } },
            doctor: { select: { firstName: true, lastName: true } },
            service: { select: { name: true } },
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    return payment;
  }

  /**
   * Refund payment
   */
  async refundPayment(paymentIntentId: string, reason?: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status !== 'SUCCEEDED') {
      throw new BadRequestException('Payment cannot be refunded');
    }

    // Process refund through Stripe
    const refund = await this.stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: reason ? 'requested_by_customer' : 'duplicate',
      metadata: {
        reason: reason || 'No reason provided',
      },
    });

    // Update payment status
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'REFUNDED',
      },
    });

    // Update appointment status
    await this.prisma.appointment.update({
      where: { id: payment.appointmentId },
      data: {
        status: 'CANCELLED',
        cancellationReason: 'Payment refunded',
        cancelledAt: new Date(),
      },
    });

    return {
      success: true,
      refundId: refund.id,
      message: 'Payment refunded successfully',
    };
  }

  /**
   * Create a subscription for a patient
   */
  /**
   * Find the authoritative PREMIUM subscription for a Stripe customer by querying Stripe live.
   * Returns an active/trialing/past_due/unpaid one if present, else the most recently created
   * premium subscription, else null.
   *
   * This is the source of truth used to keep the platform in sync even when webhooks were
   * missed (local dev, or changes made directly in the Stripe dashboard). We filter by
   * metadata.type === 'premium_subscription' so medication subscriptions are never mistaken
   * for the membership.
   */
  private async findPremiumSubscriptionFromStripe(
    customerId: string,
  ): Promise<Stripe.Subscription | null> {
    if (!customerId) return null;
    try {
      const subs = await this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });
      const premium = subs.data.filter(
        (s) => s.metadata?.type === 'premium_subscription',
      );
      if (premium.length === 0) return null;

      const liveStatuses = ['active', 'trialing', 'past_due', 'unpaid'];
      const active = premium.find((s) => liveStatuses.includes(s.status));
      if (active) return active;

      // None active — return the most recently created premium subscription.
      return premium.sort((a, b) => b.created - a.created)[0];
    } catch (e: any) {
      console.error('findPremiumSubscriptionFromStripe error:', e.message);
      return null;
    }
  }

  /**
   * Preview the premium subscription price BEFORE the patient commits — lets the
   * Subscribe modal show "Partner credit applied: -$X" and the true price up front,
   * instead of only finding out what was charged after confirming. Read-only; applies
   * nothing, spends nothing.
   */
  async previewSubscriptionPrice(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { primaryEmail: true, email: true },
    });
    const priceId = this.configService.get('STRIPE_SUBSCRIPTION_PRICE_ID');
    if (!priceId) throw new Error('STRIPE_SUBSCRIPTION_PRICE_ID is not configured');

    const price = await this.stripe.prices.retrieve(priceId);
    const priceCents = price.unit_amount ?? 0;

    const email = user?.primaryEmail || user?.email || '';
    const credit = email ? await this.partnersService.findAvailableCreditByEmail(email) : null;
    const creditAppliedCents = credit ? Math.min(credit.availableCents, priceCents) : 0;

    return {
      priceCents,
      creditAppliedCents,
      finalCents: priceCents - creditAppliedCents,
    };
  }

  async createSubscription(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        primaryEmail: true,
        email: true,
        stripeCustomerId: true,
        isSubscribed: true
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Guard against duplicate subscriptions. Trust Stripe (live), not just the local flag —
    // the flag drifts whenever a cancel/create webhook is missed (always on localhost) or a
    // change is made directly in the Stripe dashboard. This stale flag is what previously
    // allowed a patient to subscribe multiple times, orphaning prior subs that kept billing.
    if (user.stripeCustomerId) {
      const existingPremium = await this.findPremiumSubscriptionFromStripe(
        user.stripeCustomerId,
      );
      const liveStatuses = ['active', 'trialing', 'past_due', 'unpaid'];
      if (existingPremium && liveStatuses.includes(existingPremium.status)) {
        // Self-heal the local DB so the UI reflects reality, then refuse the duplicate.
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            isSubscribed: true,
            stripeSubscriptionId: existingPremium.id,
            subscriptionStatus: existingPremium.status,
          },
        });
        throw new BadRequestException(
          'You already have an active Performance subscription.',
        );
      }
    } else if (user.isSubscribed) {
      throw new BadRequestException('User already has an active subscription');
    }

    const email = user.primaryEmail || user.email;
    if (!email) {
      throw new BadRequestException('User email is required for subscription');
    }

    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        metadata: {
          userId: user.id,
        },
      });
      customerId = customer.id;

      // Update user with Stripe customer ID
      await this.prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    }

    // Get or create subscription price
    const priceId = this.configService.get('STRIPE_SUBSCRIPTION_PRICE_ID');
    if (!priceId) {
      throw new Error('STRIPE_SUBSCRIPTION_PRICE_ID is not configured');
    }

    // Any partner platform credit left over after the welcome order (or a partner
    // subscribing directly without ever having one) applies here as a one-time
    // discount on this subscription's very first invoice — capped at one month's
    // price so it never goes negative or rolls into a second free month by itself.
    // A pending Stripe invoice item attaches automatically to the next invoice
    // generated for this customer, which is exactly the one subscriptions.create is
    // about to generate below.
    let partnerCreditForSub: { partnerId: string; appliedCents: number } | null = null;
    const credit = await this.partnersService.findAvailableCreditByEmail(email);
    if (credit && credit.availableCents > 0) {
      try {
        const price = await this.stripe.prices.retrieve(priceId);
        const priceCents = price.unit_amount ?? 0;
        const applyCents = Math.min(credit.availableCents, priceCents);
        if (applyCents > 0) {
          await this.stripe.invoiceItems.create(
            {
              customer: customerId,
              amount: -applyCents,
              currency: 'usd',
              description: 'Partner platform credit',
            },
            // Same 5-minute bucket as the subscription's own idempotency key below —
            // a retried request reuses this exact invoice item instead of stacking a
            // second discount onto whatever invoice comes next for this customer.
            { idempotencyKey: `credit-item-${userId}-${Math.floor(Date.now() / 300_000)}` },
          );
          partnerCreditForSub = { partnerId: credit.partnerId, appliedCents: applyCents };
        }
      } catch (err: any) {
        console.error(`Failed to apply partner credit to subscription: ${err.message}`);
        // Non-fatal — subscription still proceeds at full price.
      }
    }

    // Create subscription with payment intent. The "already subscribed" checks above
    // only close the door on a SECOND request made after the first one already landed
    // in Stripe — two near-simultaneous requests (double-click, retry) can both pass
    // that check before either commits. The idempotency key closes that race at the
    // Stripe API level: a retried/duplicate request within the SAME 5-minute window
    // reuses this SAME subscription instead of creating a second one, so the customer
    // can't be signed up (and charged) for two premium subscriptions from one click.
    // Bucketed by time (not just userId) so a genuine resubscribe later — after a
    // cancellation, say — isn't blocked by Stripe replaying a stale idempotency key
    // from the earlier, now-canceled subscription (idempotency keys live 24h on Stripe's
    // side; a bare per-user key would incorrectly collide with that).
    const idempotencyKey = `sub-premium-${userId}-${Math.floor(Date.now() / 300_000)}`;
    let subscription: Stripe.Subscription;
    try {
      subscription = await this.stripe.subscriptions.create(
        {
          customer: customerId,
          items: [{ price: priceId }],
          payment_behavior: 'default_incomplete',
          payment_settings: {
            save_default_payment_method: 'on_subscription',
            payment_method_types: ['card'],
          },
          expand: ['latest_invoice.confirmation_secret'],
          description: `Performance Subscription – ${`${user.firstName || ''} ${user.lastName || ''}`.trim()}`,
          metadata: {
            userId: user.id,
            patientName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
            patientEmail: user.primaryEmail || user.email || '',
            type: 'premium_subscription',
          },
        },
        { idempotencyKey },
      );
    } catch (stripeError: any) {
      console.error('Stripe subscription creation error:', stripeError);
      throw new BadRequestException(
        stripeError.message || 'Failed to create subscription with Stripe'
      );
    }

    if (partnerCreditForSub) {
      await this.partnersService.spendCredit(partnerCreditForSub.partnerId, partnerCreditForSub.appliedCents);
    }

    // The invoice's OWN payment. The clover API exposes it as
    // invoice.confirmation_secret (invoice.payment_intent was removed). We rely on
    // this SINGLE payment intent and NEVER create another one, so the customer can
    // never be charged twice for one subscription.
    const invoiceRaw = subscription.latest_invoice;
    const invoiceId =
      typeof invoiceRaw === 'string' ? invoiceRaw : (invoiceRaw as Stripe.Invoice)?.id;
    console.log(`📋 Processing subscription ${subscription.id} - Invoice: ${invoiceId}`);

    let clientSecret: string | null =
      invoiceRaw && typeof invoiceRaw === 'object'
        ? ((invoiceRaw as any).confirmation_secret?.client_secret ?? null)
        : null;

    // Fallback: re-fetch the invoice with its confirmation secret expanded.
    if (!clientSecret && invoiceId) {
      try {
        const fullInvoice = (await this.stripe.invoices.retrieve(invoiceId, {
          expand: ['confirmation_secret'],
        })) as any;
        clientSecret = fullInvoice.confirmation_secret?.client_secret ?? null;
      } catch (error: any) {
        console.error(`❌ Failed to retrieve invoice confirmation secret: ${error.message}`);
      }
    }

    if (!clientSecret) {
      // Fail loudly rather than fall back to creating a second payment intent —
      // that fallback is exactly what double-charged customers.
      console.error(`❌ No confirmation secret for subscription ${subscription.id}`);
      throw new BadRequestException(
        'Failed to obtain the subscription payment secret from Stripe',
      );
    }

    // The confirmation secret is a PaymentIntent client secret (pi_..._secret_...).
    const paymentIntentId = clientSecret.startsWith('pi_')
      ? clientSecret.split('_secret_')[0]
      : null;

    // Tag the invoice's payment intent with our metadata so confirm-payment can
    // verify ownership and resolve the subscription (a native invoice PI does not
    // carry our metadata otherwise).
    if (paymentIntentId) {
      try {
        await this.stripe.paymentIntents.update(paymentIntentId, {
          metadata: {
            invoiceId: invoiceId || '',
            subscriptionId: subscription.id,
            userId: user.id,
            patientName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
            patientEmail: user.primaryEmail || user.email || '',
            type: 'premium_subscription',
          },
        });
      } catch (metaErr: any) {
        console.error(`Failed to tag subscription PI metadata: ${metaErr.message}`);
      }
    }

    // Update user subscription status
    const subscriptionData: any = {
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      isSubscribed: subscription.status === 'active',
      subscriptionCanceledAt: null, // Clear canceled date when creating new subscription
    };

    // Only set dates if they exist (subscription might be incomplete initially)
    const sub = subscription as any;
    if (periodStartOf(sub)) {
      subscriptionData.subscriptionStartDate = new Date(periodStartOf(sub) * 1000);
    }
    if (periodEndOf(sub)) {
      subscriptionData.subscriptionEndDate = new Date(periodEndOf(sub) * 1000);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: subscriptionData,
    });

    return {
      subscriptionId: subscription.id,
      clientSecret: clientSecret,
      paymentIntentId: paymentIntentId ?? undefined,
      status: subscription.status,
    };
  }

  /**
   * Confirm subscription payment and activate subscription
   */
  async confirmSubscriptionPayment(paymentIntentId: string, userId: string) {
    // Verify payment intent
    const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

    // P0 (IDOR): the paymentIntentId comes from the client. Without this check a user could pass
    // ANOTHER user's payment intent id and activate their own subscription off someone else's
    // payment. Require the payment intent to belong to the calling user.
    if (
      paymentIntent.metadata?.userId &&
      paymentIntent.metadata.userId !== userId
    ) {
      throw new ForbiddenException('This payment does not belong to the current user');
    }

    if (paymentIntent.status !== 'succeeded') {
      throw new BadRequestException('Payment not completed');
    }

    // Get subscription ID from metadata
    const subscriptionId = paymentIntent.metadata?.subscriptionId;
    if (!subscriptionId) {
      throw new BadRequestException('Subscription ID not found in payment intent metadata');
    }

    // Retrieve subscription
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);

    // P0 (IDOR) second layer: the subscription itself must belong to this user.
    if (
      subscription.metadata?.userId &&
      subscription.metadata.userId !== userId
    ) {
      throw new ForbiddenException('This subscription does not belong to the current user');
    }
    
    // Pay the invoice if it exists and is open
    const invoiceId = paymentIntent.metadata?.invoiceId;
    if (invoiceId) {
      try {
        const invoice = await this.stripe.invoices.retrieve(invoiceId);
        if (invoice.status === 'open' && invoice.amount_due > 0) {
          // Pay the invoice using the payment intent
          // If payment intent has a payment method, use it; otherwise Stripe will use the payment intent
          const payParams: any = {};
          if (paymentIntent.payment_method && typeof paymentIntent.payment_method === 'string') {
            payParams.payment_method = paymentIntent.payment_method;
          } else if (paymentIntent.payment_method && typeof paymentIntent.payment_method === 'object') {
            payParams.payment_method = (paymentIntent.payment_method as any).id;
          }
          
          await this.stripe.invoices.pay(invoiceId, payParams);
          console.log('Invoice paid successfully:', invoiceId);
        } else {
          console.log('Invoice already paid or has no amount due:', {
            status: invoice.status,
            amount_due: invoice.amount_due,
          });
        }
      } catch (error: any) {
        console.error('Failed to pay invoice:', error.message);
        // Don't fail if invoice payment fails - Stripe might have already handled it
        // or the payment intent might have already paid it
      }
    }

    // Retrieve subscription again to get updated status after invoice payment
    let updatedSubscription: Stripe.Subscription;
    let invoicePeriodStart: number | null = null;
    let invoicePeriodEnd: number | null = null;
    let hostedInvoiceUrl: string | null = null;
    
    try {
      updatedSubscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      console.log(`📊 Subscription ${subscriptionId} status: ${updatedSubscription.status}`);
      
      // Try to get period dates from invoice if subscription doesn't have them
      if (invoiceId) {
        try {
          const invoice = await this.stripe.invoices.retrieve(invoiceId);
          const inv = invoice as any;
          hostedInvoiceUrl = inv.hosted_invoice_url || null;
          if (inv.period_start) {
            invoicePeriodStart = inv.period_start;
            console.log(`📅 Found period_start in invoice: ${invoicePeriodStart}`);
          }
          if (inv.period_end) {
            invoicePeriodEnd = inv.period_end;
            console.log(`📅 Found period_end in invoice: ${invoicePeriodEnd}`);
          }
        } catch (invError: any) {
          console.log(`⚠️  Could not retrieve invoice for period dates: ${invError.message}`);
        }
      }
      
      // Log subscription period info for debugging
      const sub = updatedSubscription as any;
      console.log(`📅 Subscription period - start: ${periodStartOf(sub)}, end: ${periodEndOf(sub)}`);
    } catch (error: any) {
      console.error(`❌ Failed to retrieve updated subscription: ${error.message}`);
      // Use the original subscription if retrieval fails
      updatedSubscription = subscription;
    }

    // Update user subscription status based on updated subscription
    const subscriptionData: any = {
      subscriptionStatus: updatedSubscription.status,
      isSubscribed: updatedSubscription.status === 'active' || updatedSubscription.status === 'trialing',
      subscriptionCanceledAt: null, // Clear canceled date when confirming payment
    };

    // Access period dates - try subscription first, then invoice
    const sub = updatedSubscription as any;
    const periodStart = periodStartOf(sub) ?? invoicePeriodStart;
    const periodEnd = periodEndOf(sub) ?? invoicePeriodEnd;
    
    console.log(`🔍 Raw period values - start: ${periodStart} (type: ${typeof periodStart}), end: ${periodEnd} (type: ${typeof periodEnd})`);
    
    if (periodStart !== undefined && periodStart !== null && typeof periodStart === 'number') {
      subscriptionData.subscriptionStartDate = new Date(periodStart * 1000);
      console.log(`✅ Setting start date: ${subscriptionData.subscriptionStartDate.toISOString()}`);
    } else {
      console.log(`⚠️  No valid period_start found (value: ${periodStart}, type: ${typeof periodStart})`);
    }
    
    if (periodEnd !== undefined && periodEnd !== null && typeof periodEnd === 'number') {
      subscriptionData.subscriptionEndDate = new Date(periodEnd * 1000);
      console.log(`✅ Setting end date: ${subscriptionData.subscriptionEndDate.toISOString()}`);
    } else {
      console.log(`⚠️  No valid period_end found (value: ${periodEnd}, type: ${typeof periodEnd})`);
    }

    const startDate = subscriptionData.subscriptionStartDate 
      ? new Date(subscriptionData.subscriptionStartDate).toLocaleDateString() 
      : 'N/A';
    const endDate = subscriptionData.subscriptionEndDate 
      ? new Date(subscriptionData.subscriptionEndDate).toLocaleDateString() 
      : 'N/A';
    
    console.log(`💾 Updating user ${userId} subscription: ${subscriptionData.subscriptionStatus} (Subscribed: ${subscriptionData.isSubscribed})`);
    console.log(`   Period: ${startDate} to ${endDate}`);

    await this.prisma.user.update({
      where: { id: userId },
      data: subscriptionData,
    });

    console.log(`✅ User subscription updated successfully in database`);

    // Write the premium payment into the unified ledger IMMEDIATELY, so it shows
    // in the payments platform right away — not only after a webhook/sync. This is
    // idempotent on the payment-intent id, so the webhook (which also writes the
    // old SubscriptionTransaction table) and the sync later update the SAME row —
    // no duplicate, and the sync won't relabel it IMPORTED because the type is set.
    try {
      let cardBrand: string | null = null;
      let cardLast4: string | null = null;
      const chargeId =
        typeof paymentIntent.latest_charge === 'string'
          ? paymentIntent.latest_charge
          : (paymentIntent.latest_charge as any)?.id;
      if (chargeId) {
        try {
          const charge = await this.stripe.charges.retrieve(chargeId);
          cardBrand = charge.payment_method_details?.card?.brand ?? null;
          cardLast4 = charge.payment_method_details?.card?.last4 ?? null;
        } catch {
          /* card details are non-critical; the sync fills them later */
        }
      }
      await this.paymentLedger.upsertFromStripe({
        stripePaymentIntentId: paymentIntentId,
        stripeInvoiceId: invoiceId || null,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId:
          typeof paymentIntent.customer === 'string'
            ? paymentIntent.customer
            : (paymentIntent.customer as any)?.id ?? null,
        userId,
        channel: 'PLATFORM',
        category: 'MEMBERSHIP',
        billing: 'SUBSCRIPTION',
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency || 'usd',
        status: 'SUCCEEDED',
        cardBrand,
        cardLast4,
        note: 'Performance membership subscription',
        // Without this the row has nothing to link to in Billing History.
        receiptUrl: hostedInvoiceUrl,
        paidAt: new Date(),
        createdByType: 'patient',
      });
      console.log(`🧾 [LEDGER] Premium subscription payment written for user ${userId}`);
    } catch (ledgerErr: any) {
      console.error('[ledger] premium confirm dual-write failed:', ledgerErr.message);
    }

    // Send subscription confirmation email
    try {
      // Fetch updated user with subscription dates from database to ensure we have correct dates
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          primaryEmail: true,
          subscriptionStartDate: true,
          subscriptionEndDate: true,
        },
      });

      if (user && user.primaryEmail && user.subscriptionStartDate && user.subscriptionEndDate) {
        const userName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Valued Customer';
        const monthlyAmount = 110; // $110 per month

        await this.mailerService.sendSubscriptionConfirmationEmail(
          user.primaryEmail,
          userName,
          user.subscriptionStartDate,
          user.subscriptionEndDate,
          monthlyAmount
        );
        console.log(`✅ Subscription confirmation email sent to ${user.primaryEmail}`);
      } else if (user && user.primaryEmail) {
        console.warn('⚠️  Subscription dates not available in database, skipping confirmation email');
      }
    } catch (emailError: any) {
      console.error('Failed to send subscription confirmation email:', emailError);
      // Don't throw - subscription is already confirmed, email failure shouldn't block the response
    }

    return {
      success: true,
      subscriptionId: subscription.id,
      status: subscription.status,
      message: 'Subscription activated successfully',
    };
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        stripeSubscriptionId: true,
        isSubscribed: true,
        firstName: true,
        lastName: true,
        primaryEmail: true,
        subscriptionEndDate: true,
      },
    });

    if (!user || !user.stripeSubscriptionId) {
      throw new NotFoundException('No active subscription found');
    }

    // Cancel subscription at period end
    const subscription = await this.stripe.subscriptions.update(
      user.stripeSubscriptionId,
      {
        cancel_at_period_end: true,
      }
    );

    // Get subscription end date
    const subscriptionEndDate = periodEndOf(subscription)
      ? new Date(periodEndOf(subscription) * 1000)
      : user.subscriptionEndDate || new Date();

    // Update user
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionCanceledAt: new Date(),
        subscriptionStatus: 'canceling',
        subscriptionEndDate: subscriptionEndDate,
      },
    });

    // Send subscription cancellation email
    try {
      // Fetch updated user with subscription end date from database to ensure we have correct date
      const updatedUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          primaryEmail: true,
          subscriptionEndDate: true,
        },
      });

      if (updatedUser && updatedUser.primaryEmail && updatedUser.subscriptionEndDate) {
        const userName = `${updatedUser.firstName || ''} ${updatedUser.lastName || ''}`.trim() || 'Valued Customer';
        const monthlyAmount = 110; // $110 per month

        await this.mailerService.sendSubscriptionCancellationEmail(
          updatedUser.primaryEmail,
          userName,
          updatedUser.subscriptionEndDate,
          monthlyAmount
        );
        console.log(`✅ Subscription cancellation email sent to ${updatedUser.primaryEmail}`);
      } else if (updatedUser && updatedUser.primaryEmail) {
        console.warn('⚠️  Subscription end date not available in database, skipping cancellation email');
      }
    } catch (emailError: any) {
      console.error('Failed to send subscription cancellation email:', emailError);
      // Don't throw - cancellation is already processed, email failure shouldn't block the response
    }

    return {
      success: true,
      message: 'Subscription will be canceled at the end of the billing period',
      endsAt: subscriptionEndDate,
    };
  }

  /**
   * Create a Stripe Billing Portal session so a patient can self-manage their
   * billing — update/replace card, view invoices, update billing address.
   * Anchored to the patient's stripeCustomerId (created if missing, keyed by email).
   */
  async createBillingPortalSession(userId: string, returnUrl?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        primaryEmail: true,
        email: true,
        stripeCustomerId: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Ensure the patient has a Stripe customer — create one (keyed by email) if not.
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const email = user.primaryEmail || user.email;
      if (!email) {
        throw new BadRequestException(
          'An email address is required to manage billing.',
        );
      }

      // Reuse an existing Stripe customer with this email before creating a new one (dedup).
      const existing = await this.stripe.customers.list({ email, limit: 1 });
      if (existing.data.length > 0) {
        customerId = existing.data[0].id;
      } else {
        const customer = await this.stripe.customers.create({
          email,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
          metadata: { userId: user.id },
        });
        customerId = customer.id;
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || `${frontendUrl}/profile`,
    });

    return { url: session.url };
  }

  /**
   * Renew or reactivate a subscription
   * Handles:
   * 1. Reactivating a canceled subscription (removes cancel_at_period_end)
   * 2. Early renewal (creates invoice immediately)
   * 3. Creating new subscription if expired
   */
  async renewSubscription(userId: string) {
    console.log(`🔄 [RENEW] ========================================`);
    console.log(`🔄 [RENEW] Starting renewSubscription for user ${userId}`);
    
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        subscriptionStatus: true,
        subscriptionEndDate: true,
        isSubscribed: true,
      },
    });

    if (!user) {
      console.error(`❌ [RENEW] User not found: ${userId}`);
      throw new NotFoundException('User not found');
    }

    console.log(`🔄 [RENEW] User data retrieved:`, {
      hasSubscriptionId: !!user.stripeSubscriptionId,
      subscriptionStatus: user.subscriptionStatus,
      isSubscribed: user.isSubscribed,
      hasCustomerId: !!user.stripeCustomerId,
    });

    // Case 1: User has an active subscription that's canceling - reactivate it
    if (user.stripeSubscriptionId && (user.subscriptionStatus === 'canceling' || user.subscriptionStatus === 'active')) {
      console.log(`🔄 [RENEW] User has active subscription, checking subscription details...`);
      try {
        const subscription = await this.stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        
        console.log(`🔄 [RENEW] Subscription retrieved:`, {
          id: subscription.id,
          status: subscription.status,
          cancel_at_period_end: subscription.cancel_at_period_end,
        });

        // If subscription is canceling, reactivate it. A cancellation may be scheduled via
        // cancel_at_period_end OR a cancel_at timestamp (Stripe Billing Portal uses cancel_at).
        // Stripe rejects passing both params together, so clear only the one that was used.
        if (subscription.cancel_at_period_end || (subscription as any).cancel_at) {
          console.log(`🔄 [RENEW] Subscription is canceling - reactivating...`);
          const reactivateParams: Stripe.SubscriptionUpdateParams = (subscription as any).cancel_at
            ? { cancel_at: '' }
            : { cancel_at_period_end: false };
          const updatedSubscription = await this.stripe.subscriptions.update(
            user.stripeSubscriptionId,
            reactivateParams,
          );

          const sub = updatedSubscription as any;
          
          // Extract dates with robust fallback logic (same as getSubscriptionStatus)
          let periodStart: number | null = periodStartOf(sub) || null;
          let periodEnd: number | null = periodEndOf(sub) || null;

          // If subscription doesn't have dates, try to get from latest invoice
          if ((!periodStart || !periodEnd) && sub.latest_invoice) {
            try {
              const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
              if (invoiceId) {
                const invoice = await this.stripe.invoices.retrieve(invoiceId);
                const inv = invoice as any;
                if (inv.period_start) periodStart = inv.period_start;
                if (inv.period_end) periodEnd = inv.period_end;
                console.log(`📅 [REACTIVATION] Using invoice dates - start: ${periodStart}, end: ${periodEnd}`);
              }
            } catch (invError: any) {
              console.log(`⚠️ [REACTIVATION] Could not retrieve invoice for period dates: ${invError.message}`);
            }
          }

          // Convert to Date objects
          let subscriptionStartDate: Date | null = periodStart ? new Date(periodStart * 1000) : null;
          let subscriptionEndDate: Date | null = periodEnd ? new Date(periodEnd * 1000) : null;

          // If start and end dates are the same, calculate end as start + 1 month
          if (subscriptionStartDate && subscriptionEndDate && 
              subscriptionStartDate.getTime() === subscriptionEndDate.getTime()) {
            console.log(`⚠️ [REACTIVATION] Start and end dates are identical. Calculating end date as start + 1 month.`);
            subscriptionEndDate = new Date(subscriptionStartDate);
            subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);
            console.log(`📅 [REACTIVATION] Calculated end date: ${subscriptionEndDate.toISOString()}`);
          }

          console.log(`📅 [REACTIVATION] Final dates to save:`, {
            start: subscriptionStartDate?.toISOString(),
            end: subscriptionEndDate?.toISOString(),
          });

          await this.prisma.user.update({
            where: { id: userId },
            data: {
              subscriptionStatus: 'active',
              isSubscribed: true,
              subscriptionCanceledAt: null,
              subscriptionStartDate: subscriptionStartDate,
              subscriptionEndDate: subscriptionEndDate,
            },
          });

          // Send subscription reactivation email
          console.log(`📧 [REACTIVATION] Starting email send process for user ${userId}`);
          try {
            // Fetch user email and name
            const userForEmail = await this.prisma.user.findUnique({
              where: { id: userId },
              select: {
                firstName: true,
                lastName: true,
                primaryEmail: true,
              },
            });

            console.log(`📧 [REACTIVATION] User data fetched:`, {
              found: !!userForEmail,
              hasEmail: !!userForEmail?.primaryEmail,
              email: userForEmail?.primaryEmail,
              // Use the dates we just calculated and saved
              startDate: subscriptionStartDate?.toISOString(),
              endDate: subscriptionEndDate?.toISOString(),
            });

            if (userForEmail && userForEmail.primaryEmail && subscriptionStartDate && subscriptionEndDate) {
              const userName = `${userForEmail.firstName || ''} ${userForEmail.lastName || ''}`.trim() || 'Valued Customer';
              const monthlyAmount = 110; // $110 per month

              console.log(`📧 [REACTIVATION] Calling sendSubscriptionConfirmationEmail with:`, {
                email: userForEmail.primaryEmail,
                name: userName,
                startDate: subscriptionStartDate.toISOString(),
                endDate: subscriptionEndDate.toISOString(),
                amount: monthlyAmount,
              });

              // No email: a membership payment confirmation is a "paid" email (only the first-time welcome is sent).
              console.log(`✅ [REACTIVATION] Subscription reactivation email sent successfully to ${userForEmail.primaryEmail}`);
            } else {
              console.warn(`⚠️ [REACTIVATION] Email not sent - missing required data:`, {
                hasUser: !!userForEmail,
                hasEmail: !!userForEmail?.primaryEmail,
                hasStartDate: !!subscriptionStartDate,
                hasEndDate: !!subscriptionEndDate,
              });
            }
          } catch (emailError: any) {
            console.error(`❌ [REACTIVATION] Failed to send subscription reactivation email:`, {
              error: emailError.message,
              stack: emailError.stack,
              name: emailError.name,
            });
            // Don't throw - reactivation is already processed, email failure shouldn't block the response
          }

          return {
            success: true,
            message: 'Subscription reactivated successfully',
            subscriptionId: updatedSubscription.id,
            status: updatedSubscription.status,
            startDate: periodStart,
            endDate: periodEnd,
          };
        }

        // If subscription is active and user wants early renewal
        // Create invoice for immediate payment
        if (subscription.status === 'active' && !subscription.cancel_at_period_end) {
          console.log(`🔄 [RENEW] Subscription is active - processing early renewal...`);
          // Create an invoice for the next billing period
          const invoice = await this.stripe.invoices.create({
            customer: subscription.customer as string,
            subscription: subscription.id,
            auto_advance: true, // Automatically finalize the invoice
          });

          // If invoice needs payment, create payment intent
          if (invoice.amount_due > 0) {
            // Get default payment method
            const customer = await this.stripe.customers.retrieve(subscription.customer as string);
            const defaultPaymentMethod = (customer as any).invoice_settings?.default_payment_method;

            if (defaultPaymentMethod && typeof defaultPaymentMethod === 'string' && invoice.id) {
              // Pay invoice with default payment method
              await this.stripe.invoices.pay(invoice.id, {
                payment_method: defaultPaymentMethod,
              });
            } else {
              // Return invoice ID for payment
              return {
                success: true,
                requiresPayment: true,
                invoiceId: invoice.id || '',
                amount: invoice.amount_due / 100,
                message: 'Payment required for early renewal',
              };
            }
          }

          // Retrieve updated subscription to get new period dates
          const updatedSubscription = await this.stripe.subscriptions.retrieve(subscription.id);
          const sub = updatedSubscription as any;
          
          // Extract dates with robust fallback logic (same as getSubscriptionStatus)
          let periodStart: number | null = periodStartOf(sub) || null;
          let periodEnd: number | null = periodEndOf(sub) || null;

          // If subscription doesn't have dates, try to get from latest invoice
          if ((!periodStart || !periodEnd) && sub.latest_invoice) {
            try {
              const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
              if (invoiceId) {
                const invoice = await this.stripe.invoices.retrieve(invoiceId);
                const inv = invoice as any;
                if (inv.period_start) periodStart = inv.period_start;
                if (inv.period_end) periodEnd = inv.period_end;
                console.log(`📅 [EARLY RENEWAL] Using invoice dates - start: ${periodStart}, end: ${periodEnd}`);
              }
            } catch (invError: any) {
              console.log(`⚠️ [EARLY RENEWAL] Could not retrieve invoice for period dates: ${invError.message}`);
            }
          }

          // Convert to Date objects
          let subscriptionStartDate: Date | null = periodStart ? new Date(periodStart * 1000) : null;
          let subscriptionEndDate: Date | null = periodEnd ? new Date(periodEnd * 1000) : null;

          // If start and end dates are the same, calculate end as start + 1 month
          if (subscriptionStartDate && subscriptionEndDate && 
              subscriptionStartDate.getTime() === subscriptionEndDate.getTime()) {
            console.log(`⚠️ [EARLY RENEWAL] Start and end dates are identical. Calculating end date as start + 1 month.`);
            subscriptionEndDate = new Date(subscriptionStartDate);
            subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);
            console.log(`📅 [EARLY RENEWAL] Calculated end date: ${subscriptionEndDate.toISOString()}`);
          }

          console.log(`📅 [EARLY RENEWAL] Final dates to save:`, {
            start: subscriptionStartDate?.toISOString(),
            end: subscriptionEndDate?.toISOString(),
          });

          await this.prisma.user.update({
            where: { id: userId },
            data: {
              subscriptionStatus: 'active',
              isSubscribed: true,
              subscriptionCanceledAt: null, // Clear canceled date on renewal
              subscriptionStartDate: subscriptionStartDate,
              subscriptionEndDate: subscriptionEndDate,
            },
          });

          // Send subscription renewal email
          console.log(`📧 [EARLY RENEWAL] Starting email send process for user ${userId}`);
          try {
            // Fetch user email and name
            const userForEmail = await this.prisma.user.findUnique({
              where: { id: userId },
              select: {
                firstName: true,
                lastName: true,
                primaryEmail: true,
              },
            });

            console.log(`📧 [EARLY RENEWAL] User data fetched:`, {
              found: !!userForEmail,
              hasEmail: !!userForEmail?.primaryEmail,
              email: userForEmail?.primaryEmail,
              // Use the dates we just calculated and saved
              startDate: subscriptionStartDate?.toISOString(),
              endDate: subscriptionEndDate?.toISOString(),
            });

            if (userForEmail && userForEmail.primaryEmail && subscriptionStartDate && subscriptionEndDate) {
              const userName = `${userForEmail.firstName || ''} ${userForEmail.lastName || ''}`.trim() || 'Valued Customer';
              const monthlyAmount = 110; // $110 per month

              console.log(`📧 [EARLY RENEWAL] Calling sendSubscriptionConfirmationEmail with:`, {
                email: userForEmail.primaryEmail,
                name: userName,
                startDate: subscriptionStartDate.toISOString(),
                endDate: subscriptionEndDate.toISOString(),
                amount: monthlyAmount,
              });

              // No email: a membership payment confirmation is a "paid" email (only the first-time welcome is sent).
              console.log(`✅ [EARLY RENEWAL] Subscription renewal email sent successfully to ${userForEmail.primaryEmail}`);
            } else {
              console.warn(`⚠️ [EARLY RENEWAL] Email not sent - missing required data:`, {
                hasUser: !!userForEmail,
                hasEmail: !!userForEmail?.primaryEmail,
                hasStartDate: !!subscriptionStartDate,
                hasEndDate: !!subscriptionEndDate,
              });
            }
          } catch (emailError: any) {
            console.error(`❌ [EARLY RENEWAL] Failed to send subscription renewal email:`, {
              error: emailError.message,
              stack: emailError.stack,
              name: emailError.name,
            });
            // Don't throw - renewal is already processed, email failure shouldn't block the response
          }

          return {
            success: true,
            message: 'Subscription renewed early successfully',
            subscriptionId: updatedSubscription.id,
            status: updatedSubscription.status,
            startDate: periodStart,
            endDate: periodEnd,
          };
        }
      } catch (error: any) {
        console.error('Error renewing existing subscription:', error);
        // If subscription doesn't exist in Stripe, continue to create new one
        if (error.code !== 'resource_missing') {
          throw new BadRequestException(`Failed to renew subscription: ${error.message}`);
        }
      }
    }

    // Case 2: No subscription or expired - create new subscription
    console.log(`🔄 [RENEW] Checking if new subscription needs to be created...`);
    if (!user.stripeCustomerId) {
      console.error(`❌ [RENEW] No Stripe customer found for user ${userId}`);
      throw new BadRequestException('No Stripe customer found. Please create a subscription first.');
    }

    console.log(`🔄 [RENEW] Creating new subscription for user ${userId}...`);
    // Create new subscription
    const subscription = await this.createSubscription(userId);
    console.log(`✅ [RENEW] New subscription created successfully`);
    
    return {
      success: true,
      message: 'New subscription created successfully',
      subscriptionId: subscription.subscriptionId,
      status: subscription.status,
      clientSecret: subscription.clientSecret,
      paymentIntentId: subscription.paymentIntentId,
    };
  }

  /**
   * Stripe API 2025-03-31.basil+ (we use 2025-10-29.clover) removed
   * `invoice.subscription` and `invoice.payment_intent`. Fill them back in from
   * their new homes so the webhook code below keeps working. Never throws.
   */
  private async normalizeInvoice(invoice: any): Promise<void> {
    try {
      if (!invoice.subscription) {
        const l0 = invoice.lines?.data?.[0];
        invoice.subscription =
          invoice.parent?.subscription_details?.subscription ||
          l0?.subscription ||
          l0?.parent?.subscription_item_details?.subscription ||
          null;
      }
      if (!invoice.payment_intent) {
        let payments = invoice.payments?.data;
        if (!payments) {
          const full: any = await this.stripe.invoices.retrieve(invoice.id, { expand: ['payments'] });
          payments = full?.payments?.data;
        }
        const paid = (payments || []).find((p: any) => p?.payment?.payment_intent) || null;
        const pi = paid?.payment?.payment_intent;
        invoice.payment_intent = typeof pi === 'string' ? pi : pi?.id || null;
      }
    } catch (e: any) {
      console.log(`ℹ️  Could not normalize invoice ${invoice?.id}: ${e?.message}`);
    }
  }

  /**
   * A paid monthly renewal (membership or medications) → one row in the unified
   * payment ledger (billing history + totals). Idempotent on the invoice /
   * payment intent. Doesn't touch medication order sets — a renewal never changes
   * which medications are active. Never throws.
   */
  private async recordSubscriptionRenewalInLedger(invoice: any, sub: any, userId: string): Promise<void> {
    try {
      const type = sub?.metadata?.type || '';
      const category =
        type === 'premium_subscription' ? 'MEMBERSHIP' : type.startsWith('medication') ? 'MEDICATION' : 'OTHER';
      const paymentIntentId: string | null = invoice.payment_intent || null;

      let cardBrand: string | null = null;
      let cardLast4: string | null = null;
      let receiptUrl: string | null = null;
      let chargeId: string | null = null;
      if (paymentIntentId) {
        try {
          const pi: any = await this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
          const charge: any = pi?.latest_charge;
          if (charge) {
            chargeId = charge.id || null;
            receiptUrl = charge.receipt_url || null;
            cardBrand = charge.payment_method_details?.card?.brand || null;
            cardLast4 = charge.payment_method_details?.card?.last4 || null;
          }
        } catch {
          /* card details are best-effort */
        }
      }

      await this.paymentLedger.upsertFromStripe({
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: paymentIntentId,
        stripeChargeId: chargeId,
        stripeSubscriptionId: typeof invoice.subscription === 'string' ? invoice.subscription : sub?.id || null,
        stripeCustomerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null,
        userId,
        channel: 'PLATFORM',
        category: category as any,
        billing: 'SUBSCRIPTION',
        amount: (invoice.amount_paid ?? 0) / 100,
        status: 'SUCCEEDED',
        receiptUrl: receiptUrl || invoice.hosted_invoice_url || null,
        hostedInvoiceUrl: invoice.hosted_invoice_url || null,
        cardBrand,
        cardLast4,
        billingEmail: invoice.customer_email || null,
        createdByType: 'system',
        note: `${category === 'MEMBERSHIP' ? 'Membership' : category === 'MEDICATION' ? 'Medication' : 'Subscription'} renewal`,
        paidAt: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : new Date(),
        lineItems: (invoice.lines?.data || []).map((l: any) => ({
          description: l.description || 'Subscription',
          quantity: l.quantity || 1,
          unitAmount: (l.amount ?? 0) / 100 / (l.quantity || 1),
          isSubscription: true,
          category: category as any,
        })),
        skipMedicationLifecycle: true,
      });
    } catch (e: any) {
      console.error(`❌ [LEDGER] Renewal not recorded for invoice ${invoice?.id}: ${e?.message}`);
    }
  }

  /**
   * FormaMD and Optimale share one Stripe account but have separate databases,
   * so every webhook endpoint also receives events for the OTHER app's patients.
   * Those must be acknowledged and skipped — updating a user that isn't in this
   * database throws, the webhook returns an error, and Stripe keeps retrying and
   * eventually flags/disables the endpoint.
   */
  private async webhookUserExists(userId: string, event: Stripe.Event): Promise<boolean> {
    const found = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!found) {
      console.log(`ℹ️  ${event.type} ${event.id}: user ${userId} isn't in this database (other app) — skipping`);
    }
    return !!found;
  }

  /** Supplements store, resolved lazily (it depends on this service, not the reverse). */
  private supplements(): SupplementsService {
    return this.moduleRef.get<SupplementsService>(SUPPLEMENTS_SERVICE, { strict: false });
  }

  /**
   * Get subscription status
   */
  async getSubscriptionStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isSubscribed: true,
        subscriptionStatus: true,
        subscriptionStartDate: true,
        subscriptionEndDate: true,
        subscriptionCanceledAt: true,
        stripeSubscriptionId: true,
        stripeCustomerId: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Reconcile with Stripe live before reading status. The platform only stores ONE
    // stripeSubscriptionId, but a customer can have drifted/duplicate premium subs in Stripe.
    // We find the authoritative premium subscription and adopt it, so a cancellation made
    // directly in Stripe (or a missed webhook) is always reflected here.
    if (user.stripeCustomerId) {
      // Captured BEFORE the lookup below can overwrite user.stripeSubscriptionId — this is
      // what tells us whether the DB was ever pointing at a real Stripe subscription.
      const hadStripeSubscriptionId = !!user.stripeSubscriptionId;

      const livePremium = await this.findPremiumSubscriptionFromStripe(
        user.stripeCustomerId,
      );
      if (livePremium) {
        if (livePremium.id !== user.stripeSubscriptionId) {
          user.stripeSubscriptionId = livePremium.id;
          await this.prisma.user.update({
            where: { id: userId },
            data: { stripeSubscriptionId: livePremium.id },
          });
        }
      } else if (hadStripeSubscriptionId) {
        // A real Stripe subscription this user WAS linked to has since disappeared/canceled —
        // genuine cleanup case. Ensure DB reflects unsubscribed.
        if (user.isSubscribed || user.stripeSubscriptionId) {
          await this.prisma.user.update({
            where: { id: userId },
            data: {
              isSubscribed: false,
              subscriptionStatus: 'canceled',
              stripeSubscriptionId: null,
            },
          });
        }
        user.isSubscribed = false;
        user.subscriptionStatus = 'canceled';
        user.stripeSubscriptionId = null;
      }
      // else: no Stripe subscription was ever linked (stripeSubscriptionId was already
      // null) and Stripe has none either — nothing to reconcile. In particular this
      // leaves an admin-granted premium (isSubscribed=true, no stripeSubscriptionId)
      // untouched instead of silently reverting it to unsubscribed.
    }

    let stripeSubscription: any = null;
    let invoicePeriodStart: number | null = null;
    let invoicePeriodEnd: number | null = null;
    
    if (user.stripeSubscriptionId) {
      try {
        stripeSubscription = await this.stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        
        // Always get dates from Stripe subscription first
        const sub = stripeSubscription as any;
        console.log(`🔍 Subscription ${user.stripeSubscriptionId} - current_period_start: ${periodStartOf(sub)}, current_period_end: ${periodEndOf(sub)}`);
        console.log(`🔍 Subscription status: ${sub.status}, id: ${sub.id}`);
        
        // Try to get period dates from latest invoice ONLY if subscription doesn't have them
        if ((!periodStartOf(sub) || !periodEndOf(sub)) && sub.latest_invoice) {
          try {
            const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
            if (invoiceId) {
              const invoice = await this.stripe.invoices.retrieve(invoiceId);
              const inv = invoice as any;
              console.log(`🔍 Invoice ${invoiceId} - period_start: ${inv.period_start}, period_end: ${inv.period_end}`);
              
              // Only use invoice dates if subscription doesn't have them
              if (!periodStartOf(sub) && inv.period_start) {
                invoicePeriodStart = inv.period_start;
                console.log(`📅 Using period_start from invoice: ${invoicePeriodStart}`);
              }
              if (!periodEndOf(sub) && inv.period_end) {
                invoicePeriodEnd = inv.period_end;
                console.log(`📅 Using period_end from invoice: ${invoicePeriodEnd}`);
              }
            }
          } catch (invError: any) {
            console.log(`⚠️  Could not retrieve latest invoice for period dates: ${invError.message}`);
          }
        }
        
        // Access period dates - prefer subscription, fallback to invoice
        // IMPORTANT: Only use invoicePeriodStart if subscription period_start is missing
        // Only use invoicePeriodEnd if subscription period_end is missing
        const periodStart = periodStartOf(sub) ?? invoicePeriodStart;
        const periodEnd = periodEndOf(sub) ?? invoicePeriodEnd;
        
        console.log(`🔍 Final period values - start: ${periodStart} (type: ${typeof periodStart}), end: ${periodEnd} (type: ${typeof periodEnd})`);
        
        // Warn if dates are the same
        if (periodStart && periodEnd && periodStart === periodEnd) {
          console.warn(`⚠️  WARNING: Start and end dates are the same! This shouldn't happen for a subscription.`);
        }
        
        let stripeStartDate = (periodStart !== undefined && periodStart !== null && typeof periodStart === 'number')
          ? new Date(periodStart * 1000) 
          : null;
        let stripeEndDate = (periodEnd !== undefined && periodEnd !== null && typeof periodEnd === 'number')
          ? new Date(periodEnd * 1000) 
          : null;
        
        console.log(`📅 Parsed dates - start: ${stripeStartDate?.toISOString() || 'null'}, end: ${stripeEndDate?.toISOString() || 'null'}`);
        
        // If dates are the same, calculate end date from start date + 1 month
        if (stripeStartDate && stripeEndDate && stripeStartDate.getTime() === stripeEndDate.getTime()) {
          console.warn(`⚠️  Start and end dates are identical. Calculating end date as start + 1 month.`);
          const calculatedEndDate = new Date(stripeStartDate);
          calculatedEndDate.setMonth(calculatedEndDate.getMonth() + 1);
          stripeEndDate = calculatedEndDate;
          console.log(`📅 Calculated end date: ${stripeEndDate.toISOString()}`);
        }
        
        // If we have start date but no end date, calculate it
        if (stripeStartDate && !stripeEndDate) {
          console.warn(`⚠️  Missing end date. Calculating end date as start + 1 month.`);
          const calculatedEndDate = new Date(stripeStartDate);
          calculatedEndDate.setMonth(calculatedEndDate.getMonth() + 1);
          stripeEndDate = calculatedEndDate;
          console.log(`📅 Calculated end date: ${stripeEndDate.toISOString()}`);
        }
        
        // Sync subscription status if Stripe shows different status than database
        const stripeStatus = stripeSubscription.status;
        const dbStatus = user.subscriptionStatus;
        const isActiveInStripe = stripeStatus === 'active' || stripeStatus === 'trialing';
        
        // Check if we need to update database (status mismatch or missing dates)
        // Dates are re-synced whenever Stripe's differ, not only when missing —
        // otherwise every renewal left the stored period stuck on the first month.
        const sameTime = (a: Date | null | undefined, b: Date | null) =>
          !!a && !!b && new Date(a).getTime() === b.getTime();
        const needsUpdate =
          stripeStatus !== dbStatus ||
          (isActiveInStripe && !user.isSubscribed) ||
          (!!stripeStartDate && !sameTime(user.subscriptionStartDate, stripeStartDate)) ||
          (!!stripeEndDate && !sameTime(user.subscriptionEndDate, stripeEndDate));
        
        if (needsUpdate) {
          console.log('Syncing subscription status from Stripe:', {
            userId,
            dbStatus,
            stripeStatus,
            dbIsSubscribed: user.isSubscribed,
            shouldBeSubscribed: isActiveInStripe,
            updatingDates: !user.subscriptionStartDate || !user.subscriptionEndDate,
          });
          
          // Update database to match Stripe
          const subscriptionData: any = {
            subscriptionStatus: stripeStatus,
            isSubscribed: isActiveInStripe,
          };
          
          if (stripeStartDate) {
            subscriptionData.subscriptionStartDate = stripeStartDate;
          }
          if (stripeEndDate) {
            subscriptionData.subscriptionEndDate = stripeEndDate;
          }
          
          await this.prisma.user.update({
            where: { id: userId },
            data: subscriptionData,
          });
          
          console.log('Subscription status synced successfully');
        }
        
        // Always return dates from Stripe if available, otherwise use database values
        // Convert Date objects to ISO strings for consistent API response
        const startDateValue = stripeStartDate || user.subscriptionStartDate;
        const endDateValue = stripeEndDate || user.subscriptionEndDate;
        
        return {
          isSubscribed: isActiveInStripe,
          status: stripeStatus,
          startDate: startDateValue ? (startDateValue instanceof Date ? startDateValue.toISOString() : startDateValue) : null,
          endDate: endDateValue ? (endDateValue instanceof Date ? endDateValue.toISOString() : endDateValue) : null,
          canceledAt: user.subscriptionCanceledAt ? (user.subscriptionCanceledAt instanceof Date ? user.subscriptionCanceledAt.toISOString() : user.subscriptionCanceledAt) : null,
          stripeStatus: stripeStatus,
          // A cancellation can be scheduled two ways: the cancel_at_period_end boolean,
          // OR a cancel_at timestamp (which is what the Stripe Billing Portal uses).
          // Treat either as "canceling" so the UI doesn't keep offering "Stop Recurring Payment".
          cancelAtPeriodEnd: !!(stripeSubscription.cancel_at_period_end || stripeSubscription.cancel_at),
        };
      } catch (error: any) {
        console.error('Error retrieving subscription from Stripe:', error);
        // If subscription doesn't exist in Stripe, clean up stale data
        if (error.code === 'resource_missing') {
          console.log(`⚠️  Subscription ${user.stripeSubscriptionId} not found in Stripe. Cleaning up stale subscription data.`);
          await this.prisma.user.update({
            where: { id: userId },
            data: {
              stripeSubscriptionId: null,
              subscriptionStatus: 'canceled',
              isSubscribed: false,
              subscriptionCanceledAt: new Date(),
            },
          });
        }
      }
    }

    // Convert Date objects to ISO strings for consistent API response
    const startDateValue = user.subscriptionStartDate;
    const endDateValue = user.subscriptionEndDate;
    const canceledAtValue = user.subscriptionCanceledAt;
    
    return {
      isSubscribed: user.isSubscribed,
      status: user.subscriptionStatus,
      startDate: startDateValue ? (startDateValue instanceof Date ? startDateValue.toISOString() : startDateValue) : null,
      endDate: endDateValue ? (endDateValue instanceof Date ? endDateValue.toISOString() : endDateValue) : null,
      canceledAt: canceledAtValue ? (canceledAtValue instanceof Date ? canceledAtValue.toISOString() : canceledAtValue) : null,
      stripeStatus: stripeSubscription?.status,
      cancelAtPeriodEnd: !!(stripeSubscription?.cancel_at_period_end || stripeSubscription?.cancel_at),
    };
  }

  /**
   * Record a MONTHLY PREMIUM SUBSCRIPTION payment into the subscription_transactions ledger.
   * Idempotent (upsert by stripeInvoiceId) and strictly gated to premium subscriptions, so
   * medication / appointment / welcome invoices are never written here. Never throws — a
   * ledger failure must not break the webhook's subscription-status handling.
   */
  private async recordPremiumSubscriptionTransaction(
    invoice: any,
    sub: any,
    status: 'SUCCEEDED' | 'FAILED',
  ): Promise<void> {
    try {
      // Strict scope: only premium-subscription invoices belong in this ledger.
      if (sub?.metadata?.type !== 'premium_subscription') return;

      const userId = sub?.metadata?.userId;
      if (!userId || !invoice?.id) return;

      // FK safety — skip if the user no longer exists.
      const userExists = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!userExists) {
        console.log(`ℹ️  [LEDGER] Skipping — user ${userId} not found for invoice ${invoice.id}`);
        return;
      }

      // Amount: amount_paid on success, amount_due on failure.
      const amountCents =
        status === 'SUCCEEDED'
          ? invoice.amount_paid ?? invoice.amount_due ?? 0
          : invoice.amount_due ?? 0;

      const paymentIntentId =
        typeof invoice.payment_intent === 'string'
          ? invoice.payment_intent
          : invoice.payment_intent?.id || null;

      // Best-effort card details + receipt from the payment intent's latest charge. Never blocks.
      let cardBrand: string | null = null;
      let cardLast4: string | null = null;
      let receiptUrl: string | null = null;
      if (paymentIntentId) {
        try {
          const pi: any = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
            expand: ['latest_charge'],
          });
          const charge: any = pi?.latest_charge;
          if (charge) {
            receiptUrl = charge.receipt_url || null;
            const card = charge.payment_method_details?.card;
            if (card) {
              cardBrand = card.brand || null;
              cardLast4 = card.last4 || null;
            }
          }
        } catch (e: any) {
          console.log(`ℹ️  [LEDGER] Could not fetch card details for ${invoice.id}: ${e.message}`);
        }
      }

      const data = {
        userId,
        stripeSubscriptionId:
          typeof invoice.subscription === 'string' ? invoice.subscription : sub?.id || null,
        stripeCustomerId:
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id || null,
        stripePaymentIntentId: paymentIntentId,
        amount: amountCents / 100,
        currency: invoice.currency || 'usd',
        status: status as any,
        cardBrand,
        cardLast4,
        invoiceUrl: invoice.hosted_invoice_url || null,
        receiptUrl,
        periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
        periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
        paidAt:
          status === 'SUCCEEDED'
            ? invoice.status_transitions?.paid_at
              ? new Date(invoice.status_transitions.paid_at * 1000)
              : new Date()
            : null,
      };

      const subTxn = await this.prisma.subscriptionTransaction.upsert({
        where: { stripeInvoiceId: invoice.id },
        create: { stripeInvoiceId: invoice.id, ...data },
        update: data,
        select: { id: true },
      });

      console.log(
        `🧾 [LEDGER] Recorded premium subscription transaction for invoice ${invoice.id} (${status})`,
      );

      // --- Dual-write into the unified payment ledger (additive; Part A) ---
      // Existing subscriptionTransaction logic above is untouched.
      await this.paymentLedger.upsertFromStripe({
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: data.stripePaymentIntentId,
        stripeSubscriptionId: data.stripeSubscriptionId,
        stripeCustomerId: data.stripeCustomerId,
        userId,
        subscriptionTransactionId: subTxn.id,
        channel: 'PLATFORM',
        category: 'MEMBERSHIP',
        billing: 'SUBSCRIPTION',
        amount: data.amount,
        currency: data.currency,
        status,
        cardBrand: data.cardBrand,
        cardLast4: data.cardLast4,
        receiptUrl: data.receiptUrl,
        hostedInvoiceUrl: data.invoiceUrl,
        paidAt: data.paidAt,
        note: 'Performance membership subscription',
      });
    } catch (e: any) {
      // Ledger must never break the webhook flow.
      console.error(`❌ [LEDGER] Failed to record subscription transaction: ${e.message}`);
    }
  }

  /**
   * Handle Stripe webhook for subscription events
   * This automatically updates subscription status when:
   * - Monthly renewal succeeds (invoice.payment_succeeded)
   * - Payment fails (invoice.payment_failed)
   * - Subscription is canceled or expires
   */
  async handleSubscriptionWebhook(event: Stripe.Event) {
    console.log(`🎯 Processing webhook event: ${event.type}`);

    // Idempotency: atomically claim this event id. Stripe delivers at-least-once, so a row
    // that already exists means this is a replay — skip it to avoid re-applying side effects.
    try {
      await this.prisma.processedStripeEvent.create({
        data: { eventId: event.id, eventType: event.type },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        console.log(`↩️  Duplicate webhook event ${event.id} (${event.type}) — skipping`);
        return { received: true, duplicate: true };
      }
      throw e;
    }

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const eventSub = event.data.object as Stripe.Subscription;
          const userId = eventSub.metadata.userId;

          if (!userId) {
            console.error('❌ No userId in subscription metadata');
            return { received: false, error: 'Missing userId' };
          }
          if (!(await this.webhookUserExists(userId, event))) break;

          // P0: only the premium membership subscription may touch the user's premium fields.
          // Medication/other subscriptions are tracked by their own models — skip here.
          if (eventSub.metadata?.type !== 'premium_subscription') {
            console.log(`ℹ️  Skipping non-premium subscription event (type=${eventSub.metadata?.type})`);
            break;
          }

          // P0 ordering guard: events can arrive out of order. Re-fetch the LIVE subscription so
          // we always apply current truth instead of a possibly-stale event payload.
          let subscription: Stripe.Subscription;
          try {
            subscription = await this.stripe.subscriptions.retrieve(eventSub.id);
          } catch {
            subscription = eventSub;
          }

          const sub = subscription as any;
          const isActive = subscription.status === 'active' || subscription.status === 'trialing';
          
          console.log(`📊 Subscription ${event.type.split('.').pop()}: ${subscription.id}`);
          console.log(`   User: ${userId}, Status: ${subscription.status}, Active: ${isActive}`);
          
          // Extract dates with robust fallback logic (same as renewSubscription)
          let periodStart: number | null = periodStartOf(sub) || null;
          let periodEnd: number | null = periodEndOf(sub) || null;

          // If subscription doesn't have dates, try to get from latest invoice
          if ((!periodStart || !periodEnd) && sub.latest_invoice) {
            try {
              const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
              if (invoiceId) {
                const invoice = await this.stripe.invoices.retrieve(invoiceId);
                const inv = invoice as any;
                if (inv.period_start) periodStart = inv.period_start;
                if (inv.period_end) periodEnd = inv.period_end;
                console.log(`📅 [WEBHOOK] Using invoice dates - start: ${periodStart}, end: ${periodEnd}`);
              }
            } catch (invError: any) {
              console.log(`⚠️ [WEBHOOK] Could not retrieve invoice for period dates: ${invError.message}`);
            }
          }

          // Convert to Date objects
          let subscriptionStartDate: Date | null = periodStart ? new Date(periodStart * 1000) : null;
          let subscriptionEndDate: Date | null = periodEnd ? new Date(periodEnd * 1000) : null;

          // If start and end dates are the same, calculate end as start + 1 month
          if (subscriptionStartDate && subscriptionEndDate && 
              subscriptionStartDate.getTime() === subscriptionEndDate.getTime()) {
            console.log(`⚠️ [WEBHOOK] Start and end dates are identical. Calculating end date as start + 1 month.`);
            subscriptionEndDate = new Date(subscriptionStartDate);
            subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);
            console.log(`📅 [WEBHOOK] Calculated end date: ${subscriptionEndDate.toISOString()}`);
          }

          console.log(`📅 [WEBHOOK] Final dates:`, {
            start: subscriptionStartDate?.toISOString(),
            end: subscriptionEndDate?.toISOString(),
          });
          
          const updateData: any = {
            subscriptionStatus: subscription.status,
            isSubscribed: isActive,
            // Clear canceled date if subscription is active again
            subscriptionCanceledAt: isActive ? null : undefined,
          };
          
          // Set dates if they are valid
          if (subscriptionStartDate) {
            updateData.subscriptionStartDate = subscriptionStartDate;
          }
          
          if (subscriptionEndDate) {
            updateData.subscriptionEndDate = subscriptionEndDate;
          }

          await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
          });

          console.log(`✅ User ${userId} subscription updated in database`);
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          const userId = subscription.metadata.userId;

          if (!userId) {
            console.error('❌ No userId in subscription metadata');
            return { received: false, error: 'Missing userId' };
          }
          if (!(await this.webhookUserExists(userId, event))) break;

          // P0: only premium-membership subscriptions affect premium status.
          if (subscription.metadata?.type !== 'premium_subscription') {
            console.log(`ℹ️  Skipping non-premium subscription deletion (type=${subscription.metadata?.type})`);
            break;
          }

          // P0 ordering guard: only downgrade if the deleted subscription is the user's CURRENT
          // tracked subscription. A stale deletion of an OLD sub must not revoke a newer active one.
          const current = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeSubscriptionId: true },
          });
          if (
            current?.stripeSubscriptionId &&
            current.stripeSubscriptionId !== subscription.id
          ) {
            console.log(
              `ℹ️  Ignoring deletion of ${subscription.id}; user's current sub is ${current.stripeSubscriptionId}`,
            );
            break;
          }

          console.log(`🗑️  Subscription deleted: ${subscription.id} for user ${userId}`);

          await this.prisma.user.update({
            where: { id: userId },
            data: {
              subscriptionStatus: 'canceled',
              isSubscribed: false,
              subscriptionCanceledAt: new Date(),
            },
          });

          console.log(`✅ User ${userId} marked as unsubscribed`);
          break;
        }

        case 'invoice.payment_succeeded': {
          // This fires on successful monthly renewal payments
          const invoice = event.data.object as any;

          // --- Part D: platform-emitted invoices (channel=INVOICE) ---
          // These carry our metadata and are NOT subscriptions. Flip the PENDING
          // ledger record to SUCCEEDED and run the med lifecycle if applicable.
          // Premium-subscription handling below is left byte-for-byte unchanged.
          if (invoice.metadata?.formamd_category) {
            await this.paymentLedger.markInvoiceStatus(invoice.id, 'SUCCEEDED', {
              paidAt: invoice.status_transitions?.paid_at
                ? new Date(invoice.status_transitions.paid_at * 1000)
                : new Date(),
              receiptUrl: invoice.hosted_invoice_url || null,
            });
            break;
          }

          // Clover API moved the subscription / payment intent off the invoice —
          // without this every renewal was skipped as "not a subscription".
          await this.normalizeInvoice(invoice);

          if (!invoice.subscription) {
            console.log('ℹ️  Invoice not related to subscription, skipping');
            return { received: true };
          }

          console.log(`💰 Payment succeeded for invoice ${invoice.id}`);
          console.log(`   Subscription: ${invoice.subscription}`);
          console.log(`   Amount: $${(invoice.amount_paid / 100).toFixed(2)}`);

          // Retrieve full subscription to get metadata and updated dates
          const sub: any = await this.stripe.subscriptions.retrieve(invoice.subscription as string);
          const userId = sub.metadata.userId;

          if (!userId) {
            console.error('❌ No userId in subscription metadata');
            return { received: false, error: 'Missing userId' };
          }
          if (!(await this.webhookUserExists(userId, event))) break;

          // Every monthly renewal (membership or medications) goes into the payment
          // ledger, so it shows in the patient's billing history and totals. First
          // payments are recorded by their own checkout flows, so only cycles here.
          if (invoice.billing_reason === 'subscription_cycle') {
            await this.recordSubscriptionRenewalInLedger(invoice, sub, userId);
            if (sub.metadata?.type === 'medication_subscription') {
              await this.voidPendingMedicationCharges(sub.id, invoice, true);
            }
          }

          // P0: only premium-membership invoices update the user's premium fields. A medication
          // (or other) subscription invoice must not flip premium membership status/dates.
          if (sub.metadata?.type !== 'premium_subscription') {
            console.log(`ℹ️  Skipping non-premium invoice.payment_succeeded (type=${sub.metadata?.type})`);
            break;
          }

          console.log(`✅ Activating subscription for user ${userId}`);
          
          // Extract dates with robust fallback logic (same as renewSubscription)
          let periodStart: number | null = periodStartOf(sub) || null;
          let periodEnd: number | null = periodEndOf(sub) || null;

          // If subscription doesn't have dates, try to get from invoice
          if ((!periodStart || !periodEnd) && invoice.period_start) {
            if (invoice.period_start) periodStart = invoice.period_start;
            if (invoice.period_end) periodEnd = invoice.period_end;
            console.log(`📅 [WEBHOOK] Using invoice dates - start: ${periodStart}, end: ${periodEnd}`);
          }

          // Convert to Date objects
          let subscriptionStartDate: Date | null = periodStart ? new Date(periodStart * 1000) : null;
          let subscriptionEndDate: Date | null = periodEnd ? new Date(periodEnd * 1000) : null;

          // If start and end dates are the same, calculate end as start + 1 month
          if (subscriptionStartDate && subscriptionEndDate && 
              subscriptionStartDate.getTime() === subscriptionEndDate.getTime()) {
            console.log(`⚠️ [WEBHOOK] Start and end dates are identical. Calculating end date as start + 1 month.`);
            subscriptionEndDate = new Date(subscriptionStartDate);
            subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);
            console.log(`📅 [WEBHOOK] Calculated end date: ${subscriptionEndDate.toISOString()}`);
          }

          console.log(`📅 [WEBHOOK] Final dates:`, {
            start: subscriptionStartDate?.toISOString(),
            end: subscriptionEndDate?.toISOString(),
          });
          
          const updateData: any = {
            subscriptionStatus: 'active',
            isSubscribed: true,
            subscriptionCanceledAt: null, // Clear any previous cancellation
          };
          
          // Set dates if they are valid
          if (subscriptionStartDate) {
            updateData.subscriptionStartDate = subscriptionStartDate;
          }
          
          if (subscriptionEndDate) {
            updateData.subscriptionEndDate = subscriptionEndDate;
          }

          await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
          });

          console.log(`✅ User ${userId} subscription renewed successfully`);

          // Ledger: record this premium-subscription charge (no-op for non-premium invoices).
          await this.recordPremiumSubscriptionTransaction(invoice, sub, 'SUCCEEDED');
          break;
        }

        case 'invoice.payment_failed': {
          // This fires when monthly renewal payment fails
          const invoice = event.data.object as any;

          // --- Part D: platform-emitted invoices (channel=INVOICE) ---
          if (invoice.metadata?.formamd_category) {
            await this.paymentLedger.markInvoiceStatus(invoice.id, 'FAILED');
            break;
          }

          await this.normalizeInvoice(invoice);

          if (!invoice.subscription) {
            console.log('ℹ️  Invoice not related to subscription, skipping');
            return { received: true };
          }

          console.log(`❌ Payment failed for invoice ${invoice.id}`);
          console.log(`   Subscription: ${invoice.subscription}`);
          console.log(`   Amount due: $${(invoice.amount_due / 100).toFixed(2)}`);
          console.log(`   Attempt: ${invoice.attempt_count}`);

          // Retrieve subscription to get userId
          const sub: any = await this.stripe.subscriptions.retrieve(invoice.subscription as string);
          const userId = sub.metadata.userId;

          if (!userId) {
            console.error('❌ No userId in subscription metadata');
            return { received: false, error: 'Missing userId' };
          }
          if (!(await this.webhookUserExists(userId, event))) break;

          if (sub.metadata?.type === 'medication_subscription' && invoice.billing_reason === 'subscription_cycle') {
            await this.voidPendingMedicationCharges(sub.id, invoice, false);
          }

          // P0: only premium-membership invoices update the user's premium fields.
          if (sub.metadata?.type !== 'premium_subscription') {
            console.log(`ℹ️  Skipping non-premium invoice.payment_failed (type=${sub.metadata?.type})`);
            break;
          }

          console.log(`⚠️  Marking user ${userId} subscription as past_due`);

          await this.prisma.user.update({
            where: { id: userId },
            data: {
              subscriptionStatus: 'past_due',
              isSubscribed: false, // User loses access when payment fails
            },
          });

          console.log(`✅ User ${userId} marked as past_due (access revoked)`);

          // Ledger: record this failed premium-subscription charge (no-op for non-premium invoices).
          await this.recordPremiumSubscriptionTransaction(invoice, sub, 'FAILED');
          break;
        }

        case 'payment_intent.succeeded': {
          // Supplements store fallback: records the order as paid if the shopper
          // closed the tab before the storefront's confirm call. Other payment
          // flows confirm on their own endpoints, so only supplement PIs are handled.
          const pi = event.data.object as Stripe.PaymentIntent;
          if (pi.metadata?.kind === SUPPLEMENT_PI_KIND) {
            await this.supplements().handlePaymentSucceeded(pi);
          }
          break;
        }

        case 'charge.refunded': {
          // --- Part D: reflect refunds in the ledger (previously untracked) ---
          const charge = event.data.object as any;
          await this.paymentLedger.markRefunded(
            {
              stripeChargeId: charge.id,
              stripePaymentIntentId:
                typeof charge.payment_intent === 'string'
                  ? charge.payment_intent
                  : charge.payment_intent?.id || null,
            },
            charge.amount_refunded != null ? charge.amount_refunded / 100 : null,
          );
          // No-op unless the PaymentIntent belongs to a supplements order.
          const refundedPi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
          if (refundedPi) await this.supplements().handleRefund(refundedPi, !!charge.refunded);
          break;
        }

        default:
          console.log(`ℹ️  Unhandled webhook event type: ${event.type}`);
      }

      return { received: true };
    } catch (error: any) {
      console.error(`❌ Error processing webhook ${event.type}:`, error.message);
      // Release the idempotency claim so Stripe's automatic retry can reprocess this event.
      await this.prisma.processedStripeEvent
        .delete({ where: { eventId: event.id } })
        .catch(() => {});
      throw error;
    }
  }

  /**
   * Calculate medication invoice for an appointment
   */
  async calculateMedicationInvoice(appointmentId: string, userId: string) {
    // Get appointment
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Verify user owns this appointment
    if (appointment.patientId !== userId) {
      throw new BadRequestException('Unauthorized to view this appointment');
    }

    // Check if payment has already been made
    const existingPayment = await this.prisma.medicationPayment.findUnique({
      where: { appointmentId },
    });

    // Check if user is subscribed
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isSubscribed: true },
    });

    const isSubscribed = user?.isSubscribed || false;
    
    // If payment is already made, determine what prices were paid
    // We'll calculate both standard and member totals to see which matches the paid amount
    let usePaidPrices = false;
    let paidAsSubscribed = false;
    
    if (existingPayment && existingPayment.status === 'SUCCEEDED' && existingPayment.amount) {
      usePaidPrices = true;
      // We'll determine if they paid as subscribed by comparing amounts
    }

    // Get medications from appointment
    const medicationsData = (appointment as any).medications as Record<string, any[]> | null;
    
    const prescribedCategories = medicationsData
      ? Object.entries(medicationsData).filter(([, meds]) => Array.isArray(meds) && meds.length > 0)
      : [];

    if (!medicationsData || prescribedCategories.length === 0) {
      return {
        items: [],
        subtotal: 0,
        total: 0,
        isSubscribed,
        discount: 0,
        currency: 'usd',
      };
    }

    // Fetch medication details from database
    const medicationIds: string[] = [];
    // The medications JSON can carry a "__noMedications" marker alongside real
    // therapy categories — it is a boolean, not an array, so every consumer here
    // has to skip non-array values or it throws on .forEach.
    Object.values(medicationsData).forEach((meds: any) => {
      if (!Array.isArray(meds)) return;
      meds.forEach((med: any) => {
        if (typeof med === 'object' && med.id) {
          medicationIds.push(med.id);
        }
      });
    });

    if (medicationIds.length === 0) {
      return {
        items: [],
        subtotal: 0,
        total: 0,
        isSubscribed,
        discount: 0,
        currency: 'usd',
      };
    }

    const medications = await this.prisma.medication.findMany({
      where: { id: { in: medicationIds }, isActive: true },
    });

    // First pass: calculate both standard and member totals to determine what was paid
    let standardTotal = 0;
    let memberTotal = 0;
    const tempItems: Array<{
      medicationId: string;
      name: string;
      strength?: string | null;
      dose?: string | null;
      frequency?: string | null;
      route?: string | null;
      standardPrice: number;
      membershipPrice: number | null;
      priceOverride: number | null;
      billingStart: 'now' | 'next_invoice';
      startsOn: string | null;
      planLink: MedicationPlanLink | null;
    }> = [];

    Object.entries(medicationsData).forEach(([category, meds]: [string, any]) => {
      if (!Array.isArray(meds)) return;
      meds.forEach((med: any) => {
        if (typeof med === 'object' && med.id) {
          const medication = medications.find(m => m.id === med.id);
          if (medication) {
            const standardPrice = Number(medication.standardPrice);
            const membershipPrice = medication.membershipPrice ? Number(medication.membershipPrice) : null;
            // The doctor can adjust the amount for this prescription (a different
            // dose than the catalogue default, say). It is stored on the
            // appointment's medications JSON, never written back to the catalogue,
            // and it is what the patient is actually charged.
            const rawOverride = Number(med.priceOverride);
            const priceOverride =
              med.priceOverride !== null &&
              med.priceOverride !== undefined &&
              med.priceOverride !== '' &&
              Number.isFinite(rawOverride) &&
              rawOverride >= 0
                ? Math.round(rawOverride * 100) / 100
                : null;
            const effective = priceOverride ?? (membershipPrice ?? standardPrice);

            standardTotal += standardPrice;
            memberTotal += effective;

            tempItems.push({
              medicationId: medication.id,
              name: medication.name,
              strength: medication.strength,
              dose: medication.dose,
              frequency: medication.frequency,
              route: medication.route,
              standardPrice,
              membershipPrice,
              priceOverride,
              // Doctor's choice for a medication added to a live subscription:
              // charge the full month now, or start it on the next invoice.
              billingStart: med.billingStart === 'next_invoice' ? 'next_invoice' : 'now',
              startsOn: typeof med.startsOn === 'string' ? med.startsOn : null,
              planLink: parsePlanLink(med.planLink),
            });
          }
        }
      });
    });

    // Determine if payment was made as subscribed or not
    if (usePaidPrices && existingPayment && existingPayment.amount) {
      const paidAmount = Number(existingPayment.amount);
      // Check which total matches (with small tolerance for rounding)
      if (Math.abs(paidAmount - memberTotal) < 0.01) {
        paidAsSubscribed = true;
      } else {
        paidAsSubscribed = false;
      }
    }

    // Build final items with correct prices
    const items: Array<{
      medicationId: string;
      name: string;
      strength?: string | null;
      dose?: string | null;
      frequency?: string | null;
      route?: string | null;
      standardPrice: number;
      membershipPrice: number | null;
      price: number;
      discount: number;
      priceOverride: number | null;
      billingStart: 'now' | 'next_invoice';
      startsOn: string | null;
      planLink: MedicationPlanLink | null;
    }> = [];

    let subtotal = 0;
    let totalDiscount = 0;

    tempItems.forEach((tempItem) => {
      // Member pricing is now the ONLY pricing — medications require a premium
      // membership, so there is no non-member rate to fall back to. Where a
      // medication has no membershipPrice recorded yet, its standardPrice still
      // applies (left as-is pending the catalogue pricing rework).
      // A doctor-set amount for this prescription overrides the catalogue price.
      const price = tempItem.priceOverride !== null
        ? tempItem.priceOverride
        : tempItem.membershipPrice !== null
          ? tempItem.membershipPrice
          : tempItem.standardPrice;

      // Kept so the UI can still show what the old non-member rate would have
      // been; it is never added to or subtracted from the amount charged. An
      // overridden line has no meaningful comparison, so it shows none.
      const discount = tempItem.priceOverride !== null
        ? 0
        : tempItem.membershipPrice !== null
          ? tempItem.standardPrice - tempItem.membershipPrice
          : 0;

      items.push({
        medicationId: tempItem.medicationId,
        name: tempItem.name,
        strength: tempItem.strength,
        dose: tempItem.dose,
        frequency: tempItem.frequency,
        route: tempItem.route,
        standardPrice: tempItem.standardPrice,
        membershipPrice: tempItem.membershipPrice,
        priceOverride: tempItem.priceOverride,
        billingStart: tempItem.billingStart,
        startsOn: tempItem.startsOn,
        planLink: tempItem.planLink,
              price,
              discount,
            });

            subtotal += price;
            totalDiscount += discount;
    });

    // Medications are member-only. A patient who isn't premium yet has to start
    // that membership as part of paying this invoice, so the invoice shows both
    // monthly charges up front rather than surprising them at checkout.
    const requiresPremium = !isSubscribed && !usePaidPrices;
    let premiumMonthly = 0;
    if (requiresPremium) {
      try {
        premiumMonthly = await this.getPremiumMonthlyPrice();
      } catch (err) {
        console.error('Failed to read premium membership price for invoice:', err);
      }
    }

    return {
      items,
      subtotal,
      total: subtotal,
      isSubscribed, // Current subscription status (for UI hints)
      discount: totalDiscount,
      currency: 'usd',
      isPaid: usePaidPrices, // Indicates if showing paid prices
      // Premium membership, billed as its own monthly subscription alongside
      // the medication one. Zero/false once the patient is already a member.
      requiresPremium,
      premiumMonthly,
      grandTotal: subtotal + premiumMonthly,
    };
  }

  /**
   * The patient's invoice page: the invoice plus, while unpaid, what paying it
   * does to their existing plan (see planMedicationChange). The plan is left
   * out rather than failing the page if Stripe can't be read.
   */
  async getMedicationInvoiceForPatient(appointmentId: string, userId: string) {
    const invoice: any = await this.calculateMedicationInvoice(appointmentId, userId);
    if (!invoice.isPaid && invoice.items?.length) {
      try {
        invoice.change = await this.planMedicationChange(appointmentId, userId, invoice);
      } catch (e: any) {
        console.error(`Could not plan medication change for ${appointmentId}: ${e.message}`);
        invoice.change = null;
      }
    }
    return invoice;
  }

  /** Monthly premium membership price, in dollars, straight from Stripe. */
  private async getPremiumMonthlyPrice(): Promise<number> {
    const priceId = this.configService.get('STRIPE_SUBSCRIPTION_PRICE_ID');
    if (!priceId) throw new Error('STRIPE_SUBSCRIPTION_PRICE_ID is not configured');
    const price = await this.stripe.prices.retrieve(priceId);
    return (price.unit_amount ?? 0) / 100;
  }

  /**
   * Find an ACTIVELY-BILLING medication subscription for a given appointment by querying Stripe
   * live. Strictly scoped to medication subscriptions (metadata.type === 'medication_subscription')
   * for THIS appointment. Returns the sub if present, else null. Used to stop duplicate medication
   * subscriptions that would double-bill the patient.
   */
  private async findActiveMedicationSubscriptionFromStripe(
    customerId: string,
    appointmentId: string,
  ): Promise<Stripe.Subscription | null> {
    if (!customerId) return null;
    try {
      const subs = await this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });
      const liveStatuses = ['active', 'trialing', 'past_due', 'unpaid'];
      return (
        subs.data.find(
          (s) =>
            s.metadata?.type === 'medication_subscription' &&
            s.metadata?.appointmentId === appointmentId &&
            liveStatuses.includes(s.status),
        ) || null
      );
    } catch (e: any) {
      console.error('findActiveMedicationSubscriptionFromStripe error:', e.message);
      return null;
    }
  }

  /**
   * The patient's live medication subscription, whichever visit started it.
   * Follow-up visits update this one instead of starting another (which is what
   * double-billed patients). Live = active, trialing or past_due; a cancellation
   * scheduled for period end is still active. If an older double-billing left
   * several, the newest is used. Throws on Stripe errors: guessing "none" here
   * would start a second subscription.
   */
  private async findLiveMedicationSubscriptionForCustomer(customerId: string): Promise<Stripe.Subscription | null> {
    if (!customerId) return null;
    const subs = await this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    const live = subs.data
      .filter(
        (s) =>
          s.metadata?.type === 'medication_subscription' && ['active', 'trialing', 'past_due'].includes(s.status),
      )
      .sort((a, b) => b.created - a.created);
    if (!live.length) return null;
    if (live.length > 1) {
      console.warn(
        `⚠️  Customer ${customerId} has ${live.length} live medication subscriptions; using the newest (${live[0].id})`,
      );
    }
    return this.stripe.subscriptions.retrieve(live[0].id, { expand: ['items.data.price.product'] });
  }

  /**
   * What paying this visit's prescription would do to the patient's billing.
   * Nothing is guessed: the doctor said, per medication, which line of the
   * patient's current subscription it continues or replaces, or that it is new
   * (see NewMedicationModal, saved as planLink).
   *  - new: no live medication subscription, so checkout starts one (unchanged flow).
   *  - unchanged: every line continues at the same price; nothing to pay or confirm.
   *  - update: the live subscription changes. Per line:
   *      continue  the doctor's "same medication", same price
   *      change    "same medication" at a new price, or "replaces" (dose change /
   *                switch) — the new dose shows now, the new price bills from the
   *                next invoice, $0 today, no refund
   *      add       "new" — the doctor chose the full monthly price today (ships
   *                now) or starting on the next invoice ($0 today, ships then)
   *      stop      on the subscription but nothing continues or replaces it —
   *                removed after the next invoice, no refund
   *  - review: the prescription can't be applied as the doctor saw it — it has
   *    no answers (prescribed before this flow, or before the plan existed), or
   *    a line it continues/replaces is no longer on the subscription. Nothing is
   *    charged; the doctor re-opens the prescription.
   * Nothing is prorated. $0 lines are never on a subscription, so they don't take part.
   */
  async planMedicationChange(
    appointmentId: string,
    patientId: string,
    invoice?: any,
    customerId?: string | null,
  ): Promise<MedicationChangePlan> {
    const inv = invoice ?? (await this.calculateMedicationInvoice(appointmentId, patientId));
    if (customerId === undefined) {
      const user = await this.prisma.user.findUnique({ where: { id: patientId }, select: { stripeCustomerId: true } });
      customerId = user?.stripeCustomerId ?? null;
    }

    const prescribed = (inv.items || [])
      .map((it: any) => ({
        line: {
          action: 'add' as const,
          medicationId: it.medicationId ?? null,
          name: it.name,
          detail: [it.strength, it.dose].filter(Boolean).join(' ') || null,
          dosageSnapshot: [it.strength, it.dose, it.frequency, it.route].filter(Boolean).join(' ') || null,
          fromCents: null,
          toCents: Math.round(Number(it.price) * 100),
          itemId: null,
          billingStart: it.billingStart === 'next_invoice' ? ('next_invoice' as const) : ('now' as const),
          replacesName: null,
        } as MedicationPlanLine,
        link: (it.planLink ?? null) as MedicationPlanLink | null,
      }))
      .filter((p: any) => (p.line.toCents ?? 0) > 0);
    const newMonthly = prescribed.reduce((s: number, p: any) => s + (p.line.toCents ?? 0), 0) / 100;

    const sub = customerId ? await this.findLiveMedicationSubscriptionForCustomer(customerId) : null;
    const anyLinkedToPlan = prescribed.some((p: any) => p.link && p.link.kind !== 'new');
    if (!sub) {
      return {
        // The doctor continued/replaced lines of a plan that has since ended.
        mode: anyLinkedToPlan ? 'review' : 'new',
        reviewReason: anyLinkedToPlan ? 'The monthly plan this prescription continues is no longer active.' : null,
        subscriptionId: null,
        resumesCancelled: false,
        nextRenewal: null,
        currentMonthly: 0,
        newMonthly,
        dueToday: anyLinkedToPlan ? 0 : newMonthly,
        lines: prescribed.map((p: any) => p.line),
      };
    }

    const live = liveMedicationItems(sub);
    const claimed = new Set<string>();
    const lines: MedicationPlanLine[] = [];
    let reviewReason: string | null = null;
    for (const { line, link } of prescribed) {
      // Already applied by an earlier confirm of THIS visit (prices it created
      // carry its appointmentId): it's on the plan now, so it continues.
      const ours = live.find(
        (x) => !claimed.has(x.itemId) && x.appointmentId === appointmentId && x.medicationId === line.medicationId,
      );
      if (ours && (!link || link.kind === 'new' || link.itemId !== ours.itemId)) {
        claimed.add(ours.itemId);
        lines.push({ ...line, action: ours.cents === line.toCents ? 'continue' : 'change', fromCents: ours.cents, itemId: ours.itemId });
        continue;
      }
      if (!link) {
        reviewReason = 'This prescription was saved before the doctor confirmed how it affects the current plan.';
        lines.push(line);
        continue;
      }
      if (link.kind === 'new') {
        lines.push(line);
        continue;
      }
      const target = live.find((x) => x.itemId === link.itemId);
      if (!target || claimed.has(target.itemId) || (link.subscriptionId && link.subscriptionId !== sub.id)) {
        reviewReason = `"${link.itemName || line.name}" is no longer on the patient's current plan.`;
        lines.push(line);
        continue;
      }
      claimed.add(target.itemId);
      // A replace this visit already applied now bills the new medication itself.
      const appliedHere = target.appointmentId === appointmentId && target.medicationId === line.medicationId;
      const same = (link.kind === 'continue' || appliedHere) && target.cents === line.toCents;
      lines.push({
        ...line,
        action: same ? 'continue' : 'change',
        fromCents: target.cents,
        itemId: target.itemId,
        replacesName: link.kind === 'replace' ? link.itemName || target.name || null : null,
      });
    }
    for (const x of live) {
      if (claimed.has(x.itemId)) continue;
      lines.push({
        action: 'stop',
        medicationId: x.medicationId,
        name: x.name || 'Medication',
        detail: null,
        dosageSnapshot: null,
        fromCents: x.cents,
        toCents: null,
        itemId: x.itemId,
        billingStart: 'now',
        replacesName: null,
      });
    }

    const periodEnd = periodEndOf(sub);
    const dueTodayCents = lines
      .filter((l) => l.action === 'add' && l.billingStart === 'now')
      .reduce((s, l) => s + (l.toCents ?? 0), 0);

    const resumesCancelled = !!(sub.cancel_at_period_end || (sub as any).cancel_at);
    const unchanged = !resumesCancelled && lines.every((l) => l.action === 'continue');
    return {
      mode: reviewReason ? 'review' : unchanged ? 'unchanged' : 'update',
      reviewReason,
      subscriptionId: sub.id,
      resumesCancelled,
      nextRenewal: periodEnd ? new Date(periodEnd * 1000) : null,
      currentMonthly: live.reduce((s, x) => s + x.cents, 0) / 100,
      newMonthly,
      dueToday: reviewReason ? 0 : dueTodayCents / 100,
      lines,
    };
  }

  /** A monthly Stripe price for one prescribed medication, under a product named after it. */
  private async createMedicationLinePrice(
    line: MedicationPlanLine,
    ctx: { appointmentId: string; userId: string; patientName: string; patientEmail: string; idem: string },
  ): Promise<string> {
    const key = `${ctx.idem}-${line.medicationId || norm16(line.name)}-${line.toCents}`;
    const product = await this.stripe.products.create(
      {
        name: line.name,
        metadata: {
          appointmentId: ctx.appointmentId,
          userId: ctx.userId,
          medicationId: line.medicationId || '',
          patientName: ctx.patientName,
          patientEmail: ctx.patientEmail,
          type: 'medication',
        },
      },
      { idempotencyKey: `${key}-prod` },
    );
    const price = await this.stripe.prices.create(
      {
        unit_amount: line.toCents ?? 0,
        currency: 'usd',
        recurring: { interval: 'month' },
        product: product.id,
        metadata: {
          appointmentId: ctx.appointmentId,
          userId: ctx.userId,
          type: 'medication',
          medicationId: line.medicationId || '',
        },
      },
      { idempotencyKey: `${key}-price` },
    );
    return price.id;
  }

  /**
   * The doctor submitted a follow-up prescription (POST medications/apply).
   * Billing follows the doctor's answers right away, with no patient step, and
   * nothing is prorated:
   *  1. "Charge now" medications first, before anything else changes: their
   *     full monthly price on a one-off invoice (today until the next invoice),
   *     charged to the saved card. If the card can't be charged, nothing is
   *     changed and the doctor decides (onChargeFailure): send the patient that
   *     invoice, or add the medication to the next invoice instead. With no
   *     saved card the doctor already chose "send invoice" in the dialog.
   *  2. Undo a scheduled cancellation (re-prescribed = continuing).
   *  3. One subscription update, no proration: adds, swaps and stops all bill
   *     from the next invoice. A sent invoice stays open for the patient until
   *     the next invoice date, when it is voided and the medication bills with
   *     the renewal (see voidPendingMedicationCharges).
   * Charging first means a retry after a failure part-way never skips or
   * repeats the charge: it finds the visit's existing invoice and carries on.
   * First prescriptions (no monthly plan) are left to the patient's invoice page.
   * Runs once per visit: billingAppliedAt locks the prescription.
   */
  async applyMedicationsAtSubmit(
    appointmentId: string,
    onChargeFailure?: 'send_invoice' | 'next_invoice',
  ): Promise<MedicationSubmitResult> {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true, medicationPayment: true },
    });
    if (!appt) throw new NotFoundException('Appointment not found');
    if (appt.medicationPayment?.billingAppliedAt) {
      return { mode: 'applied', message: 'Billing for this prescription was already applied.' };
    }
    const userId = appt.patientId;
    const customerId = appt.patient.stripeCustomerId ?? null;
    const invoice: any = await this.calculateMedicationInvoice(appointmentId, userId);
    if (!invoice.items?.length) return { mode: 'none', message: 'No medications to bill.' };

    const plan = await this.planMedicationChange(appointmentId, userId, invoice, customerId);
    if (plan.mode === 'new') {
      return { mode: 'new', message: 'The patient will receive an invoice to start their monthly plan.' };
    }
    if (plan.mode === 'review') {
      return { mode: 'review', message: plan.reviewReason || "The patient's plan changed. Please re-check the prescription." };
    }
    if (!appt.patient.isSubscribed) {
      throw new BadRequestException(
        'This patient is not an active Performance member. Medications are member-only — send them a membership reminder first.',
      );
    }

    const subscriptionId = plan.subscriptionId!;
    if (plan.mode === 'unchanged') {
      await this.linkVisitToLiveMedicationSubscription(appointmentId, subscriptionId, customerId!, plan.newMonthly);
      // A retry after an earlier attempt charged the card but failed before
      // recording it: record that payment now (never charge it again).
      await this.recordPaidVisitCharge(appointmentId, userId, subscriptionId, customerId!);
      await this.markMedicationBillingApplied(appointmentId);
      return { mode: 'unchanged', message: 'Nothing changes: the medications continue on the current plan.', newMonthly: plan.newMonthly, nextRenewal: plan.nextRenewal };
    }

    const patientName = `${appt.patient.firstName || ''} ${appt.patient.lastName || ''}`.trim();
    const email = appt.patient.primaryEmail || appt.patient.email || '';
    const idem = medicationChangeIdem(appointmentId, plan);
    const priceCtx = { appointmentId, userId, patientName, patientEmail: email, idem };

    let sub = await this.stripe.subscriptions.retrieve(subscriptionId);

    // 1. Charge now — before the plan changes.
    let charged: { invoiceId: string | null; paymentIntentId: string | null; cents: number } | null = null;
    let pending: { invoiceId: string; amount: number; reason: 'declined' | 'no_card' } | null = null;
    let chargeNow = plan.lines.filter((l) => l.action === 'add' && l.billingStart === 'now');
    if (chargeNow.length) {
      const cardOnFile = await this.medicationCardOnFile(sub, customerId!);
      let inv: any = await this.createMedicationChargeInvoice(appointmentId, userId, subscriptionId, customerId!, plan, chargeNow, cardOnFile, idem);
      let declineReason: string | null = null;
      if (inv.status !== 'paid' && cardOnFile && !onChargeFailure) {
        try {
          inv = await this.stripe.invoices.pay(inv.id, { off_session: true });
        } catch (e: any) {
          declineReason = e?.raw?.message || e?.message || 'The card was declined.';
          console.warn(`Saved card declined for medication charge on ${appointmentId}: ${declineReason}`);
          inv = await this.stripe.invoices.retrieve(inv.id);
        }
      }
      const amount = (inv.amount_due ?? 0) / 100;
      if (inv.status === 'paid') {
        charged = { invoiceId: inv.id, paymentIntentId: await this.invoicePaymentIntentId(inv.id), cents: inv.amount_paid ?? 0 };
      } else if (!cardOnFile || onChargeFailure === 'send_invoice') {
        // No saved card (the doctor picked "Send invoice now"), or the doctor
        // chose to send it after the card failed: the patient pays it.
        await this.releaseMedicationChargeInvoice(inv.id);
        pending = { invoiceId: inv.id, amount, reason: cardOnFile ? 'declined' : 'no_card' };
      } else if (onChargeFailure === 'next_invoice') {
        // The doctor chose to bill it with the next invoice instead: $0 today.
        await this.stripe.invoices.voidInvoice(inv.id).catch((e) => console.error(`Could not void ${inv.id}: ${e.message}`));
        for (const l of chargeNow) l.billingStart = 'next_invoice';
        await this.setMedicationsBillingStart(appointmentId, chargeNow, 'next_invoice');
        chargeNow = [];
      } else {
        // Card failed: change nothing. The doctor must send the invoice or move
        // it to the next invoice (the invoice stays hidden from the patient).
        const pm = cardOnFile ? await this.stripe.paymentMethods.retrieve(cardOnFile).catch(() => null) : null;
        return {
          mode: 'charge_failed',
          message: `Couldn't charge ${pm?.card ? `${pm.card.brand} •••• ${pm.card.last4}` : 'the saved card'} ${`$${amount.toFixed(2)}`}. Choose how to bill it before the prescription is submitted.`,
          chargeFailure: {
            amount,
            card: pm?.card ? { brand: pm.card.brand, last4: pm.card.last4 } : null,
            reason: declineReason,
            medications: chargeNow.map((l) => [l.name, l.detail].filter(Boolean).join(' ')),
            nextRenewal: plan.nextRenewal,
          },
        };
      }
    }

    // 2. Re-prescribed = continuing: undo a scheduled cancellation.
    if (sub.cancel_at_period_end || (sub as any).cancel_at) {
      sub = await this.stripe.subscriptions.update(
        subscriptionId,
        (sub as any).cancel_at ? { cancel_at: '' } : { cancel_at_period_end: false },
      );
    }
    // 3. The plan itself.
    await this.applyMedicationItems(subscriptionId, plan, priceCtx);

    await this.finalizeMedicationChange(appointmentId, userId, subscriptionId, customerId!, plan, invoice, charged, pending);
    await this.markMedicationBillingApplied(appointmentId, pending);

    if (pending) {
      await this.sendMedicationChargePendingEmail(appointmentId, chargeNow, pending, plan.nextRenewal).catch((e) =>
        console.error(`Pending medication charge email failed for ${appointmentId}: ${e.message}`),
      );
    }
    const usd = (n: number) => `$${n.toFixed(2)}`;
    return {
      mode: 'update',
      newMonthly: plan.newMonthly,
      nextRenewal: plan.nextRenewal,
      chargedToday: (charged?.cents ?? 0) / 100,
      pendingCharge: pending ? { amount: pending.amount, reason: pending.reason } : null,
      message: pending
        ? pending.reason === 'declined'
          ? `The patient has been emailed a ${usd(pending.amount)} invoice and can pay it from their portal. If unpaid, it moves to the next invoice. Don't ship until paid.`
          : `No card on file: the patient has been emailed a ${usd(pending.amount)} invoice. Don't ship until paid.`
        : charged
          ? `Charged ${usd(charged.cents / 100)} to the saved card. Plan updated.`
          : 'Plan updated. Nothing charged today; changes bill from the next invoice.',
    };
  }

  private async markMedicationBillingApplied(
    appointmentId: string,
    pending: { invoiceId: string; amount: number; reason: 'declined' | 'no_card' } | null = null,
  ) {
    await this.prisma.medicationPayment.update({
      where: { appointmentId },
      data: {
        billingAppliedAt: new Date(),
        pendingChargeInvoiceId: pending?.invoiceId ?? null,
        pendingChargeAmount: pending?.amount ?? null,
        pendingChargeReason: pending?.reason ?? null,
      },
    });
  }

  /** Emails the patient that a "charge now" medication still needs paying (declined card / no card). */
  private async sendMedicationChargePendingEmail(
    appointmentId: string,
    lines: { name: string; detail?: string | null; toCents?: number | null }[] | { name: string; amount: number }[],
    pending: { amount: number; reason: 'declined' | 'no_card' },
    nextRenewal: Date | null,
  ) {
    const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId }, include: { patient: true } });
    const patient = appt?.patient;
    const to = patient?.primaryEmail || patient?.email;
    if (!patient || !to) return;
    const name = `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'there';
    const link = this.appointmentsService.patientLink(patient, `/dashboard/care-plan-details/${appointmentId}`);
    const items = (lines as any[]).map((l) =>
      'amount' in l ? l : { name: [l.name, l.detail].filter(Boolean).join(' '), amount: (l.toCents ?? 0) / 100 },
    );
    await this.mailerService.sendMedicationChargePendingEmail(to, name, link, items, pending.amount, pending.reason, nextRenewal);
  }

  /**
   * Doctor's prescribe dialog: who this patient is billing-wise.
   *  - membership: medications are member-only. A patient with no current
   *    Stripe subscription of any kind is treated as first-time (their invoice
   *    includes the membership); anyone else must be an active member, or the
   *    doctor is blocked from prescribing.
   *  - plan: the lines of their live medication subscription, so the doctor can
   *    say what each pick continues or replaces (null when they have none).
   *  - card: the saved card "charge now" would use (null → "send invoice").
   */
  async getPrescribeContextForAppointment(appointmentId: string) {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { medications: true, patient: { select: { stripeCustomerId: true, isSubscribed: true } } },
    });
    if (!appt) throw new NotFoundException('Appointment not found');
    const customerId = appt.patient?.stripeCustomerId ?? null;

    const subs = customerId ? (await this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })).data : [];
    const current = subs.filter((s) => ['active', 'trialing', 'past_due'].includes(s.status));
    const firstTime = current.length === 0;
    const member = !!appt.patient?.isSubscribed;

    const sub = customerId ? await this.findLiveMedicationSubscriptionForCustomer(customerId) : null;
    let plan: any = null;
    if (sub) {
      const periodEnd = periodEndOf(sub);
      const items = liveMedicationItems(sub);
      const ids = items.map((i) => i.medicationId).filter(Boolean) as string[];
      const catalogue = ids.length
        ? await this.prisma.medication.findMany({ where: { id: { in: ids } }, select: { id: true, strength: true, dose: true } })
        : [];
      plan = {
        subscriptionId: sub.id,
        nextRenewal: periodEnd ? new Date(periodEnd * 1000) : null,
        cancelling: !!(sub.cancel_at_period_end || (sub as any).cancel_at),
        currentMonthly: items.reduce((s, x) => s + x.cents, 0) / 100,
        items: items.map(({ itemId, medicationId, name, cents }) => {
          const c = catalogue.find((m) => m.id === medicationId);
          return { itemId, medicationId, name, detail: c ? [c.strength, c.dose].filter(Boolean).join(' ') || null : null, monthly: cents / 100 };
        }),
      };
    }

    let card: { brand: string; last4: string } | null = null;
    if (sub && customerId) {
      const pmId = await this.medicationCardOnFile(sub, customerId).catch(() => null);
      if (pmId) {
        const pm = await this.stripe.paymentMethods.retrieve(pmId).catch(() => null);
        if (pm?.card) card = { brand: pm.card.brand, last4: pm.card.last4 };
      }
    }

    // A "charge now" that failed and is waiting for the doctor's decision, so the
    // choice is offered again even after the dialog was closed (it reopens read-only).
    let chargeFailure: any = null;
    if (customerId) {
      const open = (await this.visitChargeInvoices(customerId, appointmentId)).find(
        (i) => i.status === 'open' && i.metadata?.awaitingDoctor,
      );
      if (open) {
        chargeFailure = {
          amount: (open.amount_due ?? 0) / 100,
          card,
          reason: null,
          medications: (open.lines?.data || []).map((l: any) => l.description || 'Medication'),
          nextRenewal: plan?.nextRenewal ?? null,
        };
      }
    }
    // A follow-up whose prescription was saved but billing never ran (it failed,
    // and the dialog was closed): the locked view offers "Retry billing".
    const row = await this.prisma.medicationPayment.findUnique({
      where: { appointmentId },
      select: { billingAppliedAt: true, status: true },
    });
    const billingPending =
      !!plan &&
      !chargeFailure &&
      !row?.billingAppliedAt &&
      row?.status !== 'SUCCEEDED' &&
      this.appointmentsService.hasPrescribedMedications(appt.medications);

    return {
      membership: { active: member, firstTime, blocked: !firstTime && !member },
      card,
      plan,
      chargeFailure,
      billingPending,
    };
  }

  /** Staff: email a lapsed member to renew their Performance membership so medications can be prescribed. */
  async sendMembershipReminder(appointmentId: string) {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true, doctor: { select: { firstName: true, lastName: true } } },
    });
    if (!appt) throw new NotFoundException('Appointment not found');
    const to = appt.patient.primaryEmail || appt.patient.email;
    if (!to) throw new BadRequestException('This patient has no email address on file.');
    const name = `${appt.patient.firstName || ''} ${appt.patient.lastName || ''}`.trim() || 'there';
    const doctorName = appt.doctor ? `Dr. ${`${appt.doctor.firstName || ''} ${appt.doctor.lastName || ''}`.trim()}` : 'Your doctor';
    const link = this.appointmentsService.patientLink(appt.patient, '/profile');
    await this.mailerService.sendMembershipRequiredEmail(to, name, link, doctorName);
    return { sentTo: to, sentAt: new Date() };
  }

  /**
   * What the patient owes on medications right now, for the dashboard and care
   * plan pop-up:
   *  - charge: a "charge now" the saved card declined (or no card) — shown until
   *    the next invoice date, when it is voided and billed with the renewal.
   *  - renewal: the monthly medication invoice, unpaid — shown from 3 days after
   *    its date (Stripe retries first), or right away when it absorbed a pending
   *    charge the patient was already looking at.
   * Paying either one pays that same Stripe invoice, so Stripe's own retries stop.
   */
  async getPendingMedicationPayments(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    const customerId = user?.stripeCustomerId;
    if (!customerId) return [];
    const open = await this.stripe.invoices.list({ customer: customerId, status: 'open', limit: 20 });
    const subs = new Map<string, Stripe.Subscription | null>();
    const getSub = async (id: string) => {
      if (!subs.has(id)) subs.set(id, await this.stripe.subscriptions.retrieve(id).catch(() => null));
      return subs.get(id) ?? null;
    };
    const out: any[] = [];
    for (const raw of open.data) {
      const inv: any = raw;
      if (inv.metadata?.type === 'medication_change') {
        // Card failed and the doctor hasn't chosen "send invoice" / "next invoice" yet.
        if (inv.metadata?.awaitingDoctor) continue;
        const sub = inv.metadata.subscriptionId ? await getSub(inv.metadata.subscriptionId) : null;
        // The renewal it was waiting for already happened (missed webhook):
        // the medication billed with it, so this one is no longer owed.
        if (sub && (periodStartOf(sub) ?? 0) > inv.created) {
          await this.voidMedicationChargeInvoice(inv.id);
          continue;
        }
        const end = sub ? periodEndOf(sub) : null;
        out.push(await this.pendingMedicationPaymentView(inv.id, 'charge', end ? new Date(end * 1000) : null));
        continue;
      }
      await this.normalizeInvoice(inv);
      if (!inv.subscription || inv.billing_reason !== 'subscription_cycle') continue;
      const sub = await getSub(typeof inv.subscription === 'string' ? inv.subscription : inv.subscription.id);
      if (sub?.metadata?.type !== 'medication_subscription') continue;
      const ageDays = (Date.now() / 1000 - inv.created) / 86400;
      if (ageDays < 3 && inv.metadata?.showNow !== '1') continue;
      out.push(await this.pendingMedicationPaymentView(inv.id, 'renewal'));
    }
    return out;
  }

  private async pendingMedicationPaymentView(invoiceId: string, kind: 'charge' | 'renewal', coversUntil: Date | null = null) {
    const inv: any = await this.stripe.invoices.retrieve(invoiceId, { expand: ['confirmation_secret'] });
    return {
      invoiceId: inv.id,
      kind,
      // charge: the date it covers until (the next monthly invoice), and why it wasn't paid automatically.
      coversUntil,
      reason: kind === 'charge' ? (inv.default_payment_method ? 'declined' : 'no_card') : null,
      amount: (inv.amount_due ?? 0) / 100,
      invoiceDate: new Date(inv.created * 1000),
      appointmentId: inv.metadata?.appointmentId || null,
      lines: (inv.lines?.data || []).map((l: any) => ({ description: l.description || 'Medication', amount: (l.amount ?? 0) / 100 })),
      clientSecret: inv.confirmation_secret?.client_secret ?? null,
    };
  }

  /**
   * The patient paid a pending medication invoice from the pop-up. The card they
   * used becomes the one their renewals use. A paid "charge now" clears the
   * visit's pending state (the medication can ship) and goes in the ledger; a
   * paid renewal is recorded by the invoice webhook. No confirmation email.
   */
  async confirmPendingMedicationPayment(userId: string, invoiceId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    const inv: any = await this.stripe.invoices.retrieve(invoiceId);
    const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    if (!user?.stripeCustomerId || customer !== user.stripeCustomerId) throw new ForbiddenException('Not your invoice');
    if (inv.status !== 'paid') throw new BadRequestException('Payment not completed yet');

    await this.normalizeInvoice(inv);
    const subscriptionId: string | null =
      inv.metadata?.subscriptionId || (typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id) || null;
    const paymentIntentId = await this.invoicePaymentIntentId(invoiceId);
    if (paymentIntentId && subscriptionId) {
      const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId).catch(() => null);
      const card = typeof pi?.payment_method === 'string' ? pi.payment_method : pi?.payment_method?.id;
      if (card) {
        await this.stripe.subscriptions
          .update(subscriptionId, { default_payment_method: card })
          .catch((e) => console.error(`Could not set the new card on ${subscriptionId}: ${e.message}`));
      }
    }

    if (inv.metadata?.type === 'medication_change') {
      const row = await this.prisma.medicationPayment.findFirst({ where: { pendingChargeInvoiceId: invoiceId } });
      if (row) {
        await this.prisma.medicationPayment.update({
          where: { id: row.id },
          data: { pendingChargeInvoiceId: null, pendingChargeAmount: null, pendingChargeReason: null },
        });
        await this.clearMedicationsAwaitingPayment(row.appointmentId, true);
        await this.paymentLedger.upsertFromStripe({
          receiptUrl: inv.hosted_invoice_url || null,
          hostedInvoiceUrl: inv.hosted_invoice_url || null,
          stripeInvoiceId: inv.id,
          stripePaymentIntentId: paymentIntentId,
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: customer,
          userId,
          appointmentId: row.appointmentId,
          channel: 'PLATFORM',
          category: 'MEDICATION',
          billing: 'ONE_TIME',
          amount: (inv.amount_paid ?? 0) / 100,
          currency: 'usd',
          status: 'SUCCEEDED',
          paidAt: new Date(),
          note: 'Medication added mid-cycle (full month until next invoice)',
          lineItems: (inv.lines?.data || []).map((l: any) => ({
            description: l.description || 'Medication',
            quantity: 1,
            unitAmount: (l.amount ?? 0) / 100,
            isSubscription: false,
          })),
          skipMedicationLifecycle: true,
        });
      }
    }
    return { success: true };
  }

  /**
   * The monthly medication invoice came round: "charge now" invoices still
   * unpaid for that subscription are voided — the medication was put on the
   * subscription when the doctor submitted, so this renewal bills it. If the
   * renewal itself failed and absorbed one, the patient (who was already looking
   * at a pending bill) sees the renewal straight away instead of after 3 days.
   */
  private async voidPendingMedicationCharges(subscriptionId: string, renewalInvoice: any, renewalPaid: boolean) {
    const rows = await this.prisma.medicationPayment.findMany({
      where: { stripeSubscriptionId: subscriptionId, pendingChargeInvoiceId: { not: null } },
    });
    let voided = 0;
    for (const row of rows) {
      if (await this.voidMedicationChargeInvoice(row.pendingChargeInvoiceId!)) voided++;
    }
    if (voided && !renewalPaid && renewalInvoice?.id) {
      await this.stripe.invoices
        .update(renewalInvoice.id, { metadata: { ...(renewalInvoice.metadata || {}), showNow: '1' } })
        .catch((e) => console.error(`Could not flag renewal ${renewalInvoice.id}: ${e.message}`));
    }
  }

  /** Voids one "charge now" invoice (if still open) and clears the visit's pending state. */
  private async voidMedicationChargeInvoice(invoiceId: string): Promise<boolean> {
    let voided = false;
    try {
      const inv = await this.stripe.invoices.retrieve(invoiceId);
      if (inv.status === 'open') {
        await this.stripe.invoices.voidInvoice(invoiceId);
        voided = true;
      }
    } catch (e: any) {
      console.error(`Could not void medication charge invoice ${invoiceId}: ${e.message}`);
    }
    const row = await this.prisma.medicationPayment.findFirst({ where: { pendingChargeInvoiceId: invoiceId } });
    if (row) {
      await this.prisma.medicationPayment.update({
        where: { id: row.id },
        data: { pendingChargeInvoiceId: null, pendingChargeAmount: null, pendingChargeReason: null },
      });
      // It now ships with the renewal; drop the "awaiting payment" mark only.
      await this.clearMedicationsAwaitingPayment(row.appointmentId, false);
    }
    return voided;
  }

  /** Removes the "awaiting payment" mark (and, when paid early, the start date) from a visit's medications. */
  private async clearMedicationsAwaitingPayment(appointmentId: string, paidNow: boolean) {
    try {
      const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId }, select: { medications: true } });
      const meds: any = appt?.medications;
      if (!meds || typeof meds !== 'object') return;
      for (const entries of Object.values(meds)) {
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
          if (!e || typeof e !== 'object' || !e.awaitingPayment) continue;
          delete e.awaitingPayment;
          if (paidNow) delete e.startsOn;
        }
      }
      await this.prisma.appointment.update({ where: { id: appointmentId }, data: { medications: meds } });
    } catch (e: any) {
      console.error(`Could not clear awaiting payment on ${appointmentId}: ${e.message}`);
    }
  }

  /**
   * Daily: monthly medication invoices still unpaid 3+ days after their date get
   * one email (then left past due; staff follow up). Marked on the Stripe
   * invoice so a re-run, or the other app sharing this Stripe account, skips it.
   */
  @Cron('0 15 * * *')
  async sendUnpaidMedicationInvoiceAlerts() {
    const now = Math.floor(Date.now() / 1000);
    try {
      for await (const raw of this.stripe.invoices.list({ status: 'open', created: { gte: now - 14 * 86400, lte: now - 3 * 86400 }, limit: 100 })) {
        const inv: any = raw;
        if (inv.metadata?.unpaidAlertSentAt) continue;
        await this.normalizeInvoice(inv);
        if (!inv.subscription || inv.billing_reason !== 'subscription_cycle') continue;
        const sub = await this.stripe.subscriptions
          .retrieve(typeof inv.subscription === 'string' ? inv.subscription : inv.subscription.id)
          .catch(() => null);
        if (sub?.metadata?.type !== 'medication_subscription') continue;
        const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
        const patient = await this.prisma.user.findFirst({ where: { stripeCustomerId: customer } });
        const to = patient?.primaryEmail || patient?.email;
        if (!patient || !to) continue;
        // Re-read and mark first, so two runs can't both send.
        const fresh: any = await this.stripe.invoices.retrieve(inv.id);
        if (fresh.status !== 'open' || fresh.metadata?.unpaidAlertSentAt) continue;
        await this.stripe.invoices.update(inv.id, { metadata: { ...(fresh.metadata || {}), unpaidAlertSentAt: new Date().toISOString() } });
        await this.mailerService
          .sendMedicationRenewalUnpaidEmail(
            to,
            `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'there',
            this.appointmentsService.patientLink(patient, '/dashboard/home'),
            (inv.amount_due ?? 0) / 100,
            new Date(inv.created * 1000),
            (inv.lines?.data || []).map((l: any) => ({ name: l.description || 'Medication', amount: (l.amount ?? 0) / 100 })),
          )
          .catch((e) => console.error(`Unpaid medication invoice email failed for ${inv.id}: ${e.message}`));
      }
    } catch (e: any) {
      console.error(`sendUnpaidMedicationInvoiceAlerts failed: ${e.message}`);
    }
  }

  /** The card renewals use: the subscription's, else the customer's default. */
  private async medicationCardOnFile(sub: Stripe.Subscription, customerId: string): Promise<string | null> {
    const fromSub = sub.default_payment_method;
    if (fromSub) return typeof fromSub === 'string' ? fromSub : fromSub.id;
    const customer: any = await this.stripe.customers.retrieve(customerId);
    const fromCustomer = customer?.invoice_settings?.default_payment_method;
    if (fromCustomer) return typeof fromCustomer === 'string' ? fromCustomer : fromCustomer.id;
    return null;
  }

  /**
   * This visit's existing "charge now" invoices (open or paid), newest first.
   * One visit has at most one that counts, so retries reuse it.
   */
  private async visitChargeInvoices(customerId: string, appointmentId: string): Promise<any[]> {
    const found: any[] = [];
    for (const status of ['paid', 'open'] as const) {
      const res = await this.stripe.invoices.list({ customer: customerId, status, limit: 100 });
      found.push(...res.data.filter((i: any) => i.metadata?.type === 'medication_change' && i.metadata?.appointmentId === appointmentId));
    }
    return found.sort((a, b) => b.created - a.created);
  }

  /** The patient can now see (and pay) a "charge now" invoice the doctor chose to send. */
  private async releaseMedicationChargeInvoice(invoiceId: string) {
    const inv: any = await this.stripe.invoices.retrieve(invoiceId);
    if (inv.metadata?.awaitingDoctor) {
      await this.stripe.invoices.update(invoiceId, { metadata: { awaitingDoctor: '' } });
    }
  }

  /** Saves the doctor's "add to next invoice" on the prescription (labels, ship date). */
  private async setMedicationsBillingStart(appointmentId: string, lines: MedicationPlanLine[], billingStart: 'now' | 'next_invoice') {
    const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId }, select: { medications: true } });
    const meds: any = appt?.medications;
    if (!meds || typeof meds !== 'object') return;
    const ids = new Set(lines.map((l) => l.medicationId).filter(Boolean));
    for (const entries of Object.values(meds)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) if (e && typeof e === 'object' && ids.has(e.id)) e.billingStart = billingStart;
    }
    await this.prisma.appointment.update({ where: { id: appointmentId }, data: { medications: meds } });
  }

  /**
   * An earlier attempt for this visit charged the card but failed before it was
   * recorded: put that payment in the ledger. Idempotent (keyed on the invoice).
   */
  private async recordPaidVisitCharge(appointmentId: string, userId: string, subscriptionId: string, customerId: string) {
    const paid = (await this.visitChargeInvoices(customerId, appointmentId)).find((i) => i.status === 'paid');
    if (!paid) return;
    await this.paymentLedger.upsertFromStripe({
      receiptUrl: paid.hosted_invoice_url || null,
      hostedInvoiceUrl: paid.hosted_invoice_url || null,
      stripeInvoiceId: paid.id,
      stripePaymentIntentId: await this.invoicePaymentIntentId(paid.id),
      stripeSubscriptionId: subscriptionId,
      stripeCustomerId: customerId,
      userId,
      appointmentId,
      channel: 'PLATFORM',
      category: 'MEDICATION',
      billing: 'ONE_TIME',
      amount: (paid.amount_paid ?? 0) / 100,
      currency: 'usd',
      status: 'SUCCEEDED',
      paidAt: paid.status_transitions?.paid_at ? new Date(paid.status_transitions.paid_at * 1000) : new Date(),
      note: 'Medication added mid-cycle (full month until next invoice)',
      lineItems: (paid.lines?.data || []).map((l: any) => ({
        description: l.description || 'Medication',
        quantity: 1,
        unitAmount: (l.amount ?? 0) / 100,
        isSubscription: false,
      })),
      skipMedicationLifecycle: true,
    });
  }

  /**
   * Finalized one-off invoice for the full monthly price of each "charge now"
   * medication, covering today until the next invoice. Kept off the subscription
   * so the next invoice bills only the regular month. One per visit: a retry
   * reuses the visit's paid or open invoice for the same amount (so the card is
   * never charged twice), and voids one left over from different prescriptions.
   * New invoices start hidden from the patient (awaitingDoctor) until the
   * charge succeeds or the doctor chooses to send it.
   */
  private async createMedicationChargeInvoice(
    appointmentId: string,
    userId: string,
    subscriptionId: string,
    customerId: string,
    plan: MedicationChangePlan,
    lines: MedicationPlanLine[],
    cardOnFile: string | null,
    idem: string,
  ) {
    const until = plan.nextRenewal ? ` (until ${plan.nextRenewal.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})` : '';
    const cents = lines.reduce((t, l) => t + (l.toCents ?? 0), 0);
    const existing = await this.visitChargeInvoices(customerId, appointmentId);
    const reuse = existing.find((i) => (i.status === 'paid' ? i.amount_paid : i.amount_due) === cents);
    for (const stale of existing) {
      if (stale !== reuse && stale.status === 'open') {
        await this.stripe.invoices.voidInvoice(stale.id).catch((e) => console.error(`Could not void ${stale.id}: ${e.message}`));
      }
    }
    if (reuse) return reuse;

    let inv: any = await this.stripe.invoices.create(
      {
        customer: customerId,
        collection_method: 'charge_automatically',
        auto_advance: false,
        pending_invoice_items_behavior: 'exclude',
        ...(cardOnFile ? { default_payment_method: cardOnFile } : {}),
        description: `Medication added to your monthly plan${until}`,
        metadata: { type: 'medication_change', appointmentId, userId, subscriptionId, awaitingDoctor: '1' },
      },
      { idempotencyKey: `${idem}-inv` },
    );
    // A retry gets Stripe's cached create response ("draft"), so read it fresh.
    inv = await this.stripe.invoices.retrieve(inv.id);
    if (inv.status === 'draft') {
      for (const [i, l] of lines.entries()) {
        await this.stripe.invoiceItems.create(
          {
            customer: customerId,
            invoice: inv.id,
            amount: l.toCents ?? 0,
            currency: 'usd',
            description: `${[l.name, l.detail].filter(Boolean).join(' ')}${until}`,
            metadata: { medicationId: l.medicationId || '', appointmentId, type: 'medication' },
          },
          { idempotencyKey: `${idem}-ii-${i}` },
        );
      }
      inv = await this.stripe.invoices.finalizeInvoice(inv.id, { auto_advance: false });
    }
    return inv;
  }

  /** The PaymentIntent that paid an invoice (Clover moved it to invoice.payments). */
  private async invoicePaymentIntentId(invoiceId: string): Promise<string | null> {
    try {
      const inv: any = await this.stripe.invoices.retrieve(invoiceId, { expand: ['payments'] });
      const pi = inv.payments?.data?.find((p: any) => p.status === 'paid')?.payment?.payment_intent ?? inv.payment_intent;
      return (typeof pi === 'string' ? pi : pi?.id) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Step 2 of applyMedicationsAtSubmit, from the plan made before anything was
   * applied. One update, no proration: the next invoice bills the new set.
   */
  private async applyMedicationItems(
    subscriptionId: string,
    plan: MedicationChangePlan,
    priceCtx: { appointmentId: string; userId: string; patientName: string; patientEmail: string; idem: string },
  ) {
    // Never strip the last item: if only stops are left the patient should
    // cancel instead (whole-plan cancel keeps the current month).
    if (!plan.lines.some((l) => l.action !== 'stop')) return;
    const items: Stripe.SubscriptionUpdateParams.Item[] = [];
    for (const l of plan.lines) {
      if (l.action === 'add') items.push({ price: await this.createMedicationLinePrice(l, priceCtx), quantity: 1 });
      if (l.action === 'change') items.push({ id: l.itemId!, price: await this.createMedicationLinePrice(l, priceCtx), quantity: 1 });
      if (l.action === 'stop') items.push({ id: l.itemId!, deleted: true });
    }
    if (!items.length) return;
    await this.stripe.subscriptions.update(
      subscriptionId,
      { items, proration_behavior: 'none' },
      { idempotencyKey: `${priceCtx.idem}-items` },
    );
  }

  /**
   * Point this visit at the live subscription and mark it paid. Shared by
   * "nothing changed" and a finished change.
   */
  private async linkVisitToLiveMedicationSubscription(
    appointmentId: string,
    subscriptionId: string,
    customerId: string,
    newMonthly: number,
    extra: { paymentIntent?: string | null } = {},
  ) {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    const periodEnd = periodEndOf(sub);
    const data = {
      stripeSubscriptionId: subscriptionId,
      stripeCustomerId: customerId,
      amount: newMonthly,
      status: 'SUCCEEDED' as const,
      paidAt: new Date(),
      subscriptionStatus: (sub.cancel_at_period_end || (sub as any).cancel_at ? 'canceling' : sub.status) as any,
      subscriptionEndDate: periodEnd ? new Date(periodEnd * 1000) : null,
      subscriptionCanceledAt: null,
      ...(extra.paymentIntent ? { paymentIntent: extra.paymentIntent } : {}),
    };
    await this.prisma.medicationPayment.upsert({
      where: { appointmentId },
      create: { appointmentId, currency: 'usd', ...data },
      update: data,
    });
  }

  /**
   * Records a finished change: visit row, the "starts on" date of medications
   * held for the next invoice, active medication set, ledger row for any charge.
   */
  private async finalizeMedicationChange(
    appointmentId: string,
    userId: string,
    subscriptionId: string,
    customerId: string,
    plan: MedicationChangePlan,
    invoice: any,
    charged: { invoiceId: string | null; paymentIntentId: string | null; cents: number } | null,
    pending: { invoiceId: string; amount: number; reason: 'declined' | 'no_card' } | null = null,
  ) {
    await this.linkVisitToLiveMedicationSubscription(appointmentId, subscriptionId, customerId, plan.newMonthly, {
      paymentIntent: charged?.paymentIntentId,
    });

    // "Add to next invoice" medications ship with that invoice; the date sits on
    // the prescription so the chart and whoever ships can see it.
    const deferred = plan.lines.filter((l) => l.action === 'add' && l.billingStart === 'next_invoice');
    if (deferred.length && plan.nextRenewal) {
      await this.markMedicationsStartOn(appointmentId, deferred, plan.nextRenewal);
    }
    // "Charge now" that wasn't paid: don't ship until the patient pays it, or
    // until it bills with the next invoice.
    if (pending) {
      const unpaid = plan.lines.filter((l) => l.action === 'add' && l.billingStart === 'now');
      await this.markMedicationsStartOn(appointmentId, unpaid, plan.nextRenewal, true);
    }

    const names = (invoice.items || []).map((i: any) => i.name).join(', ');
    await this.stripe.subscriptions
      .update(subscriptionId, { metadata: { medications: names.substring(0, 500), latestAppointmentId: appointmentId } })
      .catch((e) => console.error(`Could not update medication subscription metadata: ${e.message}`));

    let recordId: string | null = null;
    if (charged && charged.cents > 0 && (charged.invoiceId || charged.paymentIntentId)) {
      let hostedInvoiceUrl: string | null = null;
      let lineItems: any[] = [];
      if (charged.invoiceId) {
        try {
          const paidInv: any = await this.stripe.invoices.retrieve(charged.invoiceId);
          hostedInvoiceUrl = paidInv.hosted_invoice_url || null;
          lineItems = (paidInv.lines?.data || [])
            .filter((l: any) => (l.amount ?? 0) > 0)
            .map((l: any) => ({
              description: l.description || 'Medication',
              quantity: 1,
              unitAmount: (l.amount ?? 0) / 100,
              isSubscription: false,
            }));
        } catch (e: any) {
          console.error(`Could not read medication change invoice ${charged.invoiceId}: ${e.message}`);
        }
      }
      recordId = await this.paymentLedger.upsertFromStripe({
        receiptUrl: hostedInvoiceUrl,
        hostedInvoiceUrl,
        stripeInvoiceId: charged.invoiceId,
        stripePaymentIntentId: charged.paymentIntentId,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
        userId,
        appointmentId,
        channel: 'PLATFORM',
        category: 'MEDICATION',
        billing: 'ONE_TIME',
        amount: charged.cents / 100,
        currency: 'usd',
        status: 'SUCCEEDED',
        paidAt: new Date(),
        note: 'Medication added mid-cycle (full month until next invoice)',
        lineItems,
        skipMedicationLifecycle: true,
      });
    }

    await this.paymentLedger.replaceActiveMedicationSet({
      userId,
      stripeSubscriptionId: subscriptionId,
      startedAt: new Date(),
      sourcePaymentRecordId: recordId,
      items: (invoice.items || []).map((it: any) => ({
        medicationId: it.medicationId ?? null,
        medicationName: [it.name, it.strength, it.dose].filter(Boolean).join(' '),
        dosageSnapshot: [it.strength, it.dose, it.frequency, it.route].filter(Boolean).join(' ') || null,
      })),
    });
  }

  /** Stamps startsOn on the matching entries of the appointment's medications JSON. */
  private async markMedicationsStartOn(
    appointmentId: string,
    lines: MedicationPlanLine[],
    startsOn: Date | null,
    awaitingPayment = false,
  ) {
    try {
      const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId }, select: { medications: true } });
      const meds: any = appt?.medications;
      if (!meds || typeof meds !== 'object') return;
      const ids = new Set(lines.map((l) => l.medicationId).filter(Boolean));
      const iso = startsOn ? startsOn.toISOString() : null;
      for (const entries of Object.values(meds)) {
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
          if (!e || typeof e !== 'object' || !ids.has(e.id)) continue;
          if (iso) e.startsOn = iso;
          if (awaitingPayment) e.awaitingPayment = true;
        }
      }
      await this.prisma.appointment.update({ where: { id: appointmentId }, data: { medications: meds } });
    } catch (e: any) {
      console.error(`Could not mark start date on medications for ${appointmentId}: ${e.message}`);
    }
  }

  /**
   * A signed follow-up that prescribes exactly what the patient already pays
   * for needs no invoice: link it to the live subscription so the patient,
   * the chart and reminders all see it as covered. Only after signing (a paid
   * row locks the medications). Best-effort, never throws.
   */
  private async linkIfCoveredByLiveSubscription(appointmentId: string): Promise<boolean> {
    try {
      const appt = await this.prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: { patientId: true, notesSignedAt: true, medications: true, patient: { select: { stripeCustomerId: true } } },
      });
      if (!appt?.notesSignedAt || !appt.patient?.stripeCustomerId) return false;
      if (!this.appointmentsService.hasPrescribedMedications(appt.medications)) return false;
      const plan = await this.planMedicationChange(appointmentId, appt.patientId, undefined, appt.patient.stripeCustomerId);
      if (plan.mode !== 'unchanged' || !plan.subscriptionId) return false;
      await this.linkVisitToLiveMedicationSubscription(
        appointmentId,
        plan.subscriptionId,
        appt.patient.stripeCustomerId,
        plan.newMonthly,
      );
      console.log(`✅ Visit ${appointmentId} continues the live medication subscription ${plan.subscriptionId}; no invoice`);
      return true;
    } catch (e: any) {
      console.error(`linkIfCoveredByLiveSubscription(${appointmentId}) failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Create subscription for medication invoice (monthly billing)
   */
  async createMedicationPaymentIntent(appointmentId: string, userId: string) {
    // Calculate invoice
    const invoice = await this.calculateMedicationInvoice(appointmentId, userId);

    if (invoice.total <= 0) {
      throw new BadRequestException('No medications to pay for');
    }

    // Check if subscription already exists
    const existingPayment = await this.prisma.medicationPayment.findUnique({
      where: { appointmentId },
    });

    if (existingPayment && existingPayment.status === 'SUCCEEDED' && existingPayment.stripeSubscriptionId) {
      throw new BadRequestException('Medication subscription already active');
    }

    // Get user and appointment
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    if (appointment.patientId !== userId) {
      throw new BadRequestException('Unauthorized');
    }

    const user = appointment.patient;
    const email = user.primaryEmail || user.email;
    if (!email) {
      throw new BadRequestException('User email is required for subscription');
    }

    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        metadata: {
          userId: user.id,
        },
      });
      customerId = customer.id;

      // Update user with Stripe customer ID
      await this.prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId },
      });
    } else {
      // Verify customer still exists in Stripe
      try {
        await this.stripe.customers.retrieve(customerId);
      } catch (error: any) {
        if (error.code === 'resource_missing') {
          console.log(`⚠️  Customer ${customerId} not found in Stripe. Creating new customer.`);
          // Customer doesn't exist, create a new one
          const customer = await this.stripe.customers.create({
            email,
            name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
            metadata: {
              userId: user.id,
            },
          });
          customerId = customer.id;

          // Update user with new Stripe customer ID
          await this.prisma.user.update({
            where: { id: userId },
            data: { stripeCustomerId: customerId },
          });
        } else {
          throw error;
        }
      }
    }

    // A follow-up visit for a patient who already has a live medication
    // subscription (from any visit) changes that subscription instead of
    // starting a second one — the second one is what double-billed patients.
    const plan = await this.planMedicationChange(appointmentId, userId, invoice, customerId);
    if (plan.mode === 'review') {
      throw new BadRequestException(
        `${plan.reviewReason} Your doctor needs to review this prescription before it can be paid.`,
      );
    }
    // Follow-ups for a patient already on a monthly plan are billed when the
    // doctor submits (applyMedicationsAtSubmit); there is nothing to pay here.
    if (plan.mode === 'unchanged') {
      await this.linkVisitToLiveMedicationSubscription(appointmentId, plan.subscriptionId!, customerId, plan.newMonthly);
      return { mode: 'unchanged', applied: true, requiresPayment: false, chargedToday: 0, newMonthly: plan.newMonthly, nextRenewal: plan.nextRenewal, premium: null };
    }
    if (plan.mode !== 'new') {
      throw new BadRequestException('Your doctor has already applied this prescription to your monthly plan. Nothing to pay here.');
    }

    // P0 (M1): guard against duplicate medication subscriptions. Trust Stripe live, not just the
    // local DB row (which can drift). If an actively-billing medication subscription already exists
    // for this appointment, sync the DB row and refuse to create another that would double-bill.
    const existingActiveSub = await this.findActiveMedicationSubscriptionFromStripe(
      customerId,
      appointmentId,
    );
    if (existingActiveSub) {
      // findActiveMedicationSubscriptionFromStripe treats past_due and unpaid as
      // "live" too — those block a second subscription but must NOT read as paid,
      // so only a genuinely billing subscription stamps SUCCEEDED.
      const isBilling = ['active', 'trialing'].includes(existingActiveSub.status);

      await this.prisma.medicationPayment.upsert({
        where: { appointmentId },
        create: {
          appointmentId,
          stripeSubscriptionId: existingActiveSub.id,
          stripeCustomerId: customerId,
          amount: invoice.total,
          currency: invoice.currency,
          status: isBilling ? 'SUCCEEDED' : 'PENDING',
          subscriptionStatus: existingActiveSub.status as any,
        },
        update: {
          stripeSubscriptionId: existingActiveSub.id,
          stripeCustomerId: customerId,
          subscriptionStatus: existingActiveSub.status as any,
          // Without this the row keeps whatever status it had from an earlier
          // abandoned attempt (usually PENDING), and getMedicationPaymentStatus
          // returns paid:false — so the portal kept offering "Pay invoice" for a
          // subscription Stripe was already billing.
          ...(isBilling ? { status: 'SUCCEEDED' as const } : {}),
        },
      });
      throw new BadRequestException(
        'A medication subscription is already active for this appointment.',
      );
    }

    // P0 (M2): deterministic idempotency key base so concurrent/retried requests for the SAME
    // appointment + amount reuse the same Stripe objects instead of creating duplicates.
    const idemBase = `med-${appointmentId}-${Math.round(invoice.total * 100)}`;

    // Build readable medication list for Stripe description
    const patientFullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    const medNames = invoice.items.map((item: any) => item.name).join(', ');

    // Build ONE monthly Stripe price per medication — each under a product named
    // after that medication — so the invoice AND the Stripe dashboard itemize
    // every medication (name, unit price, amount) instead of a single lump sum.
    // Idempotency keys are scoped per (appointment, total, medication) so retries
    // reuse the same products/prices and never double-create.
    const subscriptionItems: Stripe.SubscriptionCreateParams.Item[] = [];
    for (let i = 0; i < invoice.items.length; i++) {
      const item: any = invoice.items[i];
      const amountCents = Math.round(Number(item.price) * 100);
      if (amountCents <= 0) continue; // skip any $0 lines
      const medKey = item.medicationId || `idx${i}`;

      const medProduct = await this.stripe.products.create(
        {
          name: item.name,
          metadata: {
            appointmentId,
            userId,
            medicationId: item.medicationId || '',
            patientName: patientFullName,
            patientEmail: email,
            type: 'medication',
          },
        },
        { idempotencyKey: `${idemBase}-prod-${medKey}` },
      );

      const medPrice = await this.stripe.prices.create(
        {
          unit_amount: amountCents,
          currency: invoice.currency,
          recurring: { interval: 'month' },
          product: medProduct.id,
          metadata: {
            appointmentId,
            userId,
            type: 'medication',
            medicationId: item.medicationId || '',
          },
        },
        { idempotencyKey: `${idemBase}-price-${medKey}` },
      );

      subscriptionItems.push({ price: medPrice.id, quantity: 1 });
    }

    if (subscriptionItems.length === 0) {
      throw new BadRequestException('No billable medication items to charge.');
    }
    console.log(
      `✅ Prepared ${subscriptionItems.length} itemized medication line(s) for appointment ${appointmentId} (total $${invoice.total})`,
    );

    // Partner platform credit — applies to this medication order's FIRST invoice only
    // (never a recurring month), same mechanism as the premium subscription. Capped at
    // this invoice's total so it never goes negative.
    let medCreditApplied: { partnerId: string; appliedCents: number } | null = null;
    const medCredit = await this.partnersService.findAvailableCreditByEmail(email);
    if (medCredit && medCredit.availableCents > 0) {
      const invoiceCents = Math.round(invoice.total * 100);
      const applyCents = Math.min(medCredit.availableCents, invoiceCents);
      if (applyCents > 0) {
        try {
          await this.stripe.invoiceItems.create(
            {
              customer: customerId,
              amount: -applyCents,
              currency: invoice.currency,
              description: 'Partner platform credit',
            },
            { idempotencyKey: `${idemBase}-credit-item` },
          );
          medCreditApplied = { partnerId: medCredit.partnerId, appliedCents: applyCents };
        } catch (err: any) {
          console.error(`Failed to apply partner credit to medication order: ${err.message}`);
        }
      }
    }

    // Create subscription with payment intent
    let subscription: Stripe.Subscription;
    try {
      subscription = await this.stripe.subscriptions.create(
        {
          customer: customerId,
          items: subscriptionItems,
          payment_behavior: 'default_incomplete',
          payment_settings: {
            save_default_payment_method: 'on_subscription',
            payment_method_types: ['card'],
          },
          expand: ['latest_invoice.confirmation_secret'],
          description: `Monthly Medications – ${patientFullName} | ${medNames.substring(0, 200)}`,
          metadata: {
            appointmentId,
            userId,
            patientName: patientFullName,
            patientEmail: email,
            medications: medNames.substring(0, 500),
            type: 'medication_subscription',
          },
        },
        { idempotencyKey: `${idemBase}-sub` },
      );
    } catch (error: any) {
      // If customer doesn't exist, create a new one and retry
      if (error.code === 'resource_missing' && error.param === 'customer') {
        console.log(`⚠️  Customer ${customerId} not found in Stripe. Creating new customer and retrying.`);
        const newCustomer = await this.stripe.customers.create({
          email,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
          metadata: {
            userId: user.id,
          },
        });
        customerId = newCustomer.id;

        // Update user with new Stripe customer ID
        await this.prisma.user.update({
          where: { id: userId },
          data: { stripeCustomerId: customerId },
        });

        // Retry subscription creation with new customer (distinct idempotency key — the
        // customer param changed, so it must not collide with the first attempt's key).
        subscription = await this.stripe.subscriptions.create(
          {
            customer: customerId,
            items: subscriptionItems,
            payment_behavior: 'default_incomplete',
            payment_settings: {
              save_default_payment_method: 'on_subscription',
              payment_method_types: ['card'],
            },
            expand: ['latest_invoice.confirmation_secret'],
            description: `Monthly Medications – ${patientFullName} | ${medNames.substring(0, 200)}`,
            metadata: {
              appointmentId,
              userId,
              patientName: patientFullName,
              patientEmail: email,
              medications: medNames.substring(0, 500),
              type: 'medication_subscription',
            },
          },
          { idempotencyKey: `${idemBase}-sub-retry` },
        );
      } else {
        throw error;
      }
    }

    // The invoice's OWN payment — a single PaymentIntent. The clover API exposes
    // it via invoice.confirmation_secret (invoice.payment_intent was removed). We
    // rely ONLY on this and NEVER create a second PI, so a medication subscription
    // can never double-charge.
    const invoiceRaw = subscription.latest_invoice;
    const invoiceId = typeof invoiceRaw === 'string' ? invoiceRaw : (invoiceRaw as Stripe.Invoice)?.id;
    console.log(`📋 Processing medication subscription ${subscription.id} - Invoice: ${invoiceId}`);

    let clientSecret: string | null =
      invoiceRaw && typeof invoiceRaw === 'object'
        ? ((invoiceRaw as any).confirmation_secret?.client_secret ?? null)
        : null;

    // Fallback: re-fetch the invoice with its confirmation secret expanded.
    if (!clientSecret && invoiceId) {
      try {
        const fullInvoice = (await this.stripe.invoices.retrieve(invoiceId, {
          expand: ['confirmation_secret'],
        })) as any;
        clientSecret = fullInvoice.confirmation_secret?.client_secret ?? null;
      } catch (error: any) {
        console.error(`❌ Failed to retrieve invoice confirmation secret: ${error.message}`);
      }
    }

    if (!clientSecret) {
      // Fail loudly rather than fall back to creating a second payment intent —
      // that fallback is exactly what double-charged customers.
      console.error(`❌ No confirmation secret for medication subscription ${subscription.id}`);
      throw new BadRequestException(
        'Failed to obtain the medication subscription payment secret from Stripe',
      );
    }

    // The confirmation secret is a PaymentIntent client secret (pi_..._secret_...).
    const resolvedPaymentIntentId = clientSecret.startsWith('pi_')
      ? clientSecret.split('_secret_')[0]
      : null;
    let paymentIntent: Stripe.PaymentIntent | null = null;
    if (resolvedPaymentIntentId) {
      try {
        // Tag the invoice's PI with our metadata so confirm can verify + resolve it.
        paymentIntent = await this.stripe.paymentIntents.update(resolvedPaymentIntentId, {
          metadata: {
            invoiceId: invoiceId || '',
            subscriptionId: subscription.id,
            appointmentId,
            userId,
            type: 'medication',
          },
        });
      } catch (metaErr: any) {
        console.error(`Failed to tag medication PI metadata: ${metaErr.message}`);
        try {
          paymentIntent = await this.stripe.paymentIntents.retrieve(resolvedPaymentIntentId);
        } catch {
          /* fall through to the guard below */
        }
      }
    }

    if (!clientSecret || !paymentIntent) {
      console.error(`❌ Failed to resolve payment intent for medication subscription ${subscription.id}`);
      throw new BadRequestException('Failed to generate payment client secret for subscription');
    }

    // Create or update payment record
    if (existingPayment) {
      await this.prisma.medicationPayment.update({
        where: { appointmentId },
        data: {
          stripePaymentId: paymentIntent.id,
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: customerId,
          amount: invoice.total,
          currency: invoice.currency,
          status: 'PENDING',
          paymentIntent: paymentIntent.id,
          ...(medCreditApplied && {
            partnerCreditPartnerId: medCreditApplied.partnerId,
            partnerCreditAppliedCents: medCreditApplied.appliedCents,
            partnerCreditDeducted: false,
          }),
        },
      });
    } else {
      await this.prisma.medicationPayment.create({
        data: {
          appointmentId,
          stripePaymentId: paymentIntent.id,
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: customerId,
          amount: invoice.total,
          currency: invoice.currency,
          status: 'PENDING',
          paymentIntent: paymentIntent.id,
          ...(medCreditApplied && {
            partnerCreditPartnerId: medCreditApplied.partnerId,
            partnerCreditAppliedCents: medCreditApplied.appliedCents,
          }),
        },
      });
    }

    // Medications are member-only. If this patient isn't premium yet, start that
    // membership in the same checkout — as its own subscription, so cancelling
    // medications later doesn't also cancel their membership. Two subscriptions,
    // two secrets, confirmed back-to-back with the one card they enter.
    let premium: { clientSecret: string; subscriptionId: string; amount: number } | null = null;
    if (!invoice.isSubscribed) {
      const premiumResult = await this.createSubscription(userId);
      premium = {
        clientSecret: (premiumResult as any).clientSecret,
        subscriptionId: (premiumResult as any).subscriptionId,
        amount: (premiumResult as any).amount ?? 0,
      };
    }

    return {
      clientSecret: clientSecret,
      paymentIntentId: paymentIntent.id,
      subscriptionId: subscription.id,
      amount: invoice.total,
      currency: invoice.currency,
      // Present only when a premium membership had to be started alongside.
      premium,
    };
  }

  /**
   * Confirm medication payment (subscription setup)
   */
  async confirmMedicationPayment(paymentIntentId: string, userId: string) {
    // Verify payment intent
    const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      throw new BadRequestException('Payment not completed');
    }


    // Get payment record with appointment and patient
    const payment = await this.prisma.medicationPayment.findFirst({
      where: { paymentIntent: paymentIntentId },
      include: { 
        appointment: {
          include: {
            patient: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment record not found');
    }

    // Verify user owns this appointment
    if (payment.appointment.patientId !== userId) {
      throw new BadRequestException('Unauthorized');
    }

    // Handle subscription activation if exists
    if (payment.stripeSubscriptionId) {
      try {
      const subscription = await this.stripe.subscriptions.retrieve(payment.stripeSubscriptionId);
        
        // If subscription is incomplete, we need to pay the invoice to activate it
        if (subscription.status === 'incomplete' || subscription.status === 'incomplete_expired') {
          console.log(`📋 Subscription ${subscription.id} is incomplete. Paying invoice to activate...`);
          
          // Get the latest invoice for this subscription
          const invoiceId = typeof subscription.latest_invoice === 'string' 
            ? subscription.latest_invoice 
            : subscription.latest_invoice?.id;
          
          if (invoiceId) {
            try {
              // Pay the invoice using the payment intent
              const invoice = await this.stripe.invoices.retrieve(invoiceId);
              
              if (invoice.status === 'open' || invoice.status === 'draft') {
                // Get payment method from payment intent
                let paymentMethodId: string | undefined;
                
                if (paymentIntent.payment_method) {
                  if (typeof paymentIntent.payment_method === 'string') {
                    paymentMethodId = paymentIntent.payment_method;
                  } else if (typeof paymentIntent.payment_method === 'object' && 'id' in paymentIntent.payment_method) {
                    paymentMethodId = (paymentIntent.payment_method as any).id;
                  }
                }
                
                if (paymentMethodId) {
                  // Pay the invoice with the payment method
                  await this.stripe.invoices.pay(invoiceId, {
                    payment_method: paymentMethodId,
                  });
                  console.log(`✅ Invoice ${invoiceId} paid successfully with payment method ${paymentMethodId}`);
                } else {
                  // If no payment method, try to finalize and pay the invoice
                  // This will use the default payment method or prompt for one
                  console.log(`⚠️  No payment method found on payment intent. Attempting to pay invoice directly...`);
                  try {
                    await this.stripe.invoices.pay(invoiceId);
                    console.log(`✅ Invoice ${invoiceId} paid successfully`);
                  } catch (payError: any) {
                    console.error(`❌ Failed to pay invoice directly: ${payError.message}`);
                    // If invoice can't be paid automatically, it's okay - subscription might activate via webhook
                  }
                }
                
                // Retrieve subscription again to get updated status
                const updatedSubscription = await this.stripe.subscriptions.retrieve(payment.stripeSubscriptionId);
                console.log(`📊 Subscription status after payment: ${updatedSubscription.status}`);
                
                // Check if subscription is now active
                if (updatedSubscription.status !== 'active' && updatedSubscription.status !== 'trialing') {
                  console.warn(`⚠️  Subscription ${payment.stripeSubscriptionId} is still not active after payment. Status: ${updatedSubscription.status}`);
                  // Don't throw error - subscription might activate asynchronously
                }
              } else if (invoice.status === 'paid') {
                console.log(`✅ Invoice ${invoiceId} is already paid`);
              } else {
                console.log(`ℹ️  Invoice ${invoiceId} status: ${invoice.status}`);
              }
            } catch (invoiceError: any) {
              console.error(`❌ Failed to pay invoice: ${invoiceError.message}`);
              // Don't throw - subscription might still activate
            }
          }
        } else if (subscription.status !== 'active' && subscription.status !== 'trialing') {
          // Subscription exists but is not in a valid state
          console.warn(`⚠️  Subscription ${payment.stripeSubscriptionId} status: ${subscription.status}`);
          // Don't throw error for other statuses like 'past_due' - allow payment confirmation
        }
      } catch (error: any) {
        // If subscription doesn't exist in Stripe, clean up stale data
        if (error.code === 'resource_missing') {
          console.log(`⚠️  Medication subscription ${payment.stripeSubscriptionId} not found in Stripe. Cleaning up stale data.`);
          await this.prisma.medicationPayment.update({
            where: { id: payment.id },
            data: {
              stripeSubscriptionId: null,
            },
          });
          throw new BadRequestException('Subscription not found in Stripe. Please create a new payment intent.');
        }
        throw error;
      }
    }

    // Get updated subscription status
    let subscriptionStatus: string | null = null;
    let subscriptionEndDate: Date | null = null;
    if (payment.stripeSubscriptionId) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(payment.stripeSubscriptionId);
        subscriptionStatus = subscription.status;
        subscriptionEndDate = periodEndOf(subscription)
          ? new Date(periodEndOf(subscription) * 1000)
          : null;
      } catch (error) {
        console.error('Error retrieving subscription status after confirmation:', error);
      }
    }

    // Update payment status
    // Note: These fields will be available after Prisma client regeneration
    await this.prisma.medicationPayment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCEEDED',
        paidAt: new Date(),
        subscriptionStatus: subscriptionStatus as any,
        subscriptionEndDate: subscriptionEndDate as any,
        subscriptionCanceledAt: null as any, // Clear any previous cancellation
      },
    });

    // Actually spend the reserved partner credit now that payment truly succeeded —
    // guarded so a retried confirm-payment call never double-spends.
    if (
      payment.partnerCreditPartnerId &&
      (payment.partnerCreditAppliedCents ?? 0) > 0 &&
      !payment.partnerCreditDeducted
    ) {
      await this.partnersService.spendCredit(payment.partnerCreditPartnerId, payment.partnerCreditAppliedCents!);
      await this.prisma.medicationPayment.update({
        where: { id: payment.id },
        data: { partnerCreditDeducted: true },
      });
    }

    // Calculate invoice to get item details for email
    const invoice = await this.calculateMedicationInvoice(payment.appointmentId, userId);

    // No payment confirmation email: patients only hear about payments that need action.

    // --- Dual-write into the unified payment ledger (additive; Part A + B) ---
    // Existing medicationPayment logic above is untouched. Medication line items
    // feed the set-based MedicationOrder lifecycle inside the ledger service.
    const isMedSubscription = !!payment.stripeSubscriptionId;
    // Without this, the live Stripe invoice for this same charge never gets matched
    // against this ledger row (getPatientHistory dedupes by stripeInvoiceId) and shows
    // up a second time in Billing History as its own "1 × ... (at $X/month)" row —
    // same invoiceId this PI was tagged with at createMedicationPaymentIntent time.
    const medInvoiceId = (paymentIntent.metadata?.invoiceId as string) || null;

    // Same reason as the membership write: Billing History needs a URL to link
    // to, otherwise the row has no invoice to open.
    let medHostedInvoiceUrl: string | null = null;
    if (medInvoiceId) {
      try {
        const medInv = (await this.stripe.invoices.retrieve(medInvoiceId)) as any;
        medHostedInvoiceUrl = medInv.hosted_invoice_url || null;
      } catch (err: any) {
        console.error(`Could not read hosted invoice url for ${medInvoiceId}: ${err.message}`);
      }
    }
    await this.paymentLedger.upsertFromStripe({
      stripePaymentIntentId: paymentIntentId,
      stripeInvoiceId: medInvoiceId,
      stripeSubscriptionId: payment.stripeSubscriptionId,
      stripeCustomerId: payment.stripeCustomerId,
      userId,
      appointmentId: payment.appointmentId,
      medicationPaymentId: payment.id,
      channel: 'PLATFORM',
      category: 'MEDICATION',
      billing: isMedSubscription ? 'SUBSCRIPTION' : 'ONE_TIME',
      amount: Number(payment.amount),
      currency: 'usd',
      status: 'SUCCEEDED',
      paidAt: new Date(),
      note: 'Medication order',
      receiptUrl: medHostedInvoiceUrl,
      lineItems: (invoice.items || []).map((it: any) => ({
        description: [it.name, it.strength, it.dose].filter(Boolean).join(' '),
        medicationId: it.medicationId ?? null,
        quantity: 1,
        unitAmount: Number(it.price ?? 0),
        isSubscription: isMedSubscription,
        dosageSnapshot: [it.strength, it.dose, it.frequency, it.route]
          .filter(Boolean)
          .join(' ') || null,
      })),
    });

    return {
      success: true,
      paymentId: payment.id,
      appointmentId: payment.appointmentId,
    };
  }

  /**
   * Get medication payment status
   */
  /**
   * Patient chart: has the patient paid for their most recently prescribed
   * medications? Finds the latest appointment that actually has medications
   * prescribed, and returns its invoice (what the patient is asked to pay), the
   * payment/subscription state and the reminder history. Staff-only (checked by
   * the controller), so any doctor/admin can see it, not just the visit's doctor.
   */
  async getLatestMedicationPaymentForPatient(patientId: string) {
    const candidates = await this.prisma.appointment.findMany({
      where: { patientId, NOT: { medications: { equals: Prisma.DbNull } } },
      orderBy: [{ appointmentDate: 'desc' }, { appointmentTime: 'desc' }],
      take: 25,
      select: {
        id: true,
        appointmentDate: true,
        appointmentTime: true,
        medications: true,
        notesSignedAt: true,
        medicationPaymentReminderSentAt: true,
        medicationPaymentReminderCount: true,
        doctor: { select: { firstName: true, lastName: true } },
      },
    });
    const latest = candidates.find((a) => this.appointmentsService.hasPrescribedMedications(a.medications));
    if (!latest) return { hasPrescription: false };

    const [payment, invoice] = await Promise.all([
      this.getMedicationPaymentStatus(latest.id, '', 'admin'),
      this.calculateMedicationInvoice(latest.id, patientId).catch(() => null),
    ]);

    return {
      hasPrescription: true,
      appointmentId: latest.id,
      appointmentDate: latest.appointmentDate,
      appointmentTime: latest.appointmentTime,
      doctorName: latest.doctor ? `Dr. ${latest.doctor.firstName} ${latest.doctor.lastName}` : null,
      notesSignedAt: latest.notesSignedAt,
      reminder: {
        lastSentAt: latest.medicationPaymentReminderSentAt,
        count: latest.medicationPaymentReminderCount,
      },
      invoice: invoice
        ? {
            items: (invoice.items || []).map((i: any) => ({
              name: i.name,
              strength: i.strength,
              dose: i.dose,
              frequency: i.frequency,
              route: i.route,
              price: Number(i.price ?? 0),
            })),
            total: Number(invoice.total ?? 0),
            requiresPremium: !!(invoice as any).requiresPremium,
            premiumMonthly: Number((invoice as any).premiumMonthly ?? 0),
            isSubscribed: !!invoice.isSubscribed,
          }
        : null,
      paid: this.isMedicationPaid(payment),
      payment,
    };
  }

  /**
   * Paid = the payment succeeded and, for a subscription, it's still billing
   * (active/trialing, or set to cancel at period end). getMedicationPaymentStatus's
   * own `paid` flag is subscription-only, so one-time payments need this.
   */
  private isMedicationPaid(p: any): boolean {
    if (!p || p.status !== 'SUCCEEDED') return false;
    if (!p.isSubscription) return true;
    return ['active', 'trialing', 'canceling'].includes(p.subscriptionStatus);
  }

  /** Staff "remind to pay" for the latest prescription; refuses if it's already paid. */
  async sendMedicationPaymentReminder(appointmentId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { patientId: true },
    });
    if (!appointment) throw new NotFoundException('Appointment not found');

    // A "charge now" still unpaid: resend that, not the whole plan.
    const row = await this.prisma.medicationPayment.findUnique({ where: { appointmentId } });
    if (row?.pendingChargeInvoiceId) {
      const inv: any = await this.stripe.invoices.retrieve(row.pendingChargeInvoiceId);
      const sub = row.stripeSubscriptionId ? await this.stripe.subscriptions.retrieve(row.stripeSubscriptionId).catch(() => null) : null;
      const end = sub ? periodEndOf(sub) : null;
      await this.sendMedicationChargePendingEmail(
        appointmentId,
        (inv.lines?.data || []).map((l: any) => ({ name: l.description || 'Medication', amount: (l.amount ?? 0) / 100 })),
        { amount: Number(row.pendingChargeAmount ?? 0), reason: (row.pendingChargeReason as any) || 'declined' },
        end ? new Date(end * 1000) : null,
      );
      return { sentAt: new Date() };
    }
    if (row?.billingAppliedAt) {
      throw new BadRequestException('Nothing to pay: these medications are covered by the patient\'s monthly plan.');
    }
    const payment = await this.getMedicationPaymentStatus(appointmentId, '', 'admin');
    if (this.isMedicationPaid(payment)) throw new BadRequestException('This patient has already paid for these medications.');

    const invoice = await this.calculateMedicationInvoice(appointmentId, appointment.patientId).catch(() => null);
    return this.appointmentsService.sendMedicationPaymentReminder(appointmentId, {
      items: (invoice?.items || []).map((i: any) => ({
        name: i.name,
        detail: [i.strength, i.frequency].filter(Boolean).join(', ') || undefined,
      })),
      total: invoice?.total ? Number(invoice.total) : null,
    });
  }

  /**
   * A later visit (notes signed) that changed this same subscription: this
   * visit's medication list is then history, and the later one is current.
   */
  private async laterVisitOnSameSubscription(appointmentId: string, payment: { stripeSubscriptionId: string | null; paidAt: Date | null }) {
    if (!payment.stripeSubscriptionId) return null;
    const later = await this.prisma.medicationPayment.findFirst({
      where: {
        stripeSubscriptionId: payment.stripeSubscriptionId,
        status: 'SUCCEEDED',
        appointmentId: { not: appointmentId },
        paidAt: { gt: payment.paidAt ?? new Date(0) },
        appointment: { notesSignedAt: { not: null } },
      },
      orderBy: { paidAt: 'desc' },
      select: { appointmentId: true, appointment: { select: { appointmentDate: true } } },
    });
    return later ? { appointmentId: later.appointmentId, appointmentDate: later.appointment.appointmentDate } : null;
  }

  /**
   * What this follow-up visit did to the patient's monthly plan, per medication,
   * from what was saved when the doctor submitted: their answers on the
   * prescription (planLink / billingStart / startsOn), the ledger row for a
   * "charge now" that was paid, and the pending-charge fields for one that wasn't.
   */
  private async visitBillingSummary(appointmentId: string, payment: any) {
    const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId }, select: { medications: true } });
    const charge = await this.prisma.paymentRecord.findFirst({
      where: { appointmentId, category: 'MEDICATION' as any, billing: 'ONE_TIME' as any, status: 'SUCCEEDED' as any },
      orderBy: { paidAt: 'desc' },
      select: { amount: true, paidAt: true },
    });
    const pending = payment.pendingChargeInvoiceId ? Number(payment.pendingChargeAmount ?? 0) : null;
    const lines: any[] = [];
    for (const entries of Object.values((appt?.medications as any) || {})) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries as any[]) {
        if (!e || typeof e !== 'object' || !e.name) continue;
        const price = Number(e.priceOverride ?? 0);
        const link = e.planLink || null;
        const base = { name: e.name, detail: [e.strength, e.dose].filter(Boolean).join(' ') || null, monthly: price };
        if (!link || link.kind === 'new') {
          const status =
            e.billingStart === 'next_invoice'
              ? 'next_invoice'
              : e.awaitingPayment
                ? 'pending'
                : charge
                  ? 'charged'
                  : 'moved_to_next_invoice'; // declined/no card and not paid before the renewal
          lines.push({ ...base, status, startsOn: e.startsOn ?? null });
        } else if (link.kind === 'replace') {
          lines.push({ ...base, status: 'replaced', replaces: link.itemName ?? null, from: link.itemMonthly ?? null });
        } else {
          const from = typeof link.itemMonthly === 'number' ? link.itemMonthly : null;
          lines.push({ ...base, status: from !== null && Math.abs(from - price) >= 0.005 ? 'price_changed' : 'continued', from });
        }
      }
    }
    return {
      appliedAt: payment.billingAppliedAt,
      charged: charge ? { amount: Number(charge.amount), paidAt: charge.paidAt } : null,
      pending: pending !== null ? { amount: pending, reason: payment.pendingChargeReason } : null,
      lines,
    };
  }

  async getMedicationPaymentStatus(appointmentId: string, userId: string, userType?: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Allow access if user is the patient OR the doctor assigned to the appointment OR an admin
    const isPatient = appointment.patientId === userId;
    const isDoctor = appointment.doctorId === userId;
    const isAdmin = userType === 'admin';

    if (!isPatient && !isDoctor && !isAdmin) {
      throw new BadRequestException('Unauthorized');
    }

    let payment = await this.prisma.medicationPayment.findUnique({
      where: { appointmentId },
    });

    // Same medications as the plan already being billed: covered, no invoice.
    if (!payment && (await this.linkIfCoveredByLiveSubscription(appointmentId))) {
      payment = await this.prisma.medicationPayment.findUnique({ where: { appointmentId } });
    }

    if (!payment) {
      return {
        status: 'UNPAID',
        paid: false,
        isSubscription: false,
      };
    }

    // Check subscription status if exists
    let subscriptionStatus: Stripe.Subscription.Status | null = null;
    let cancelAtPeriodEnd = false;
    let currentPeriodEnd: Date | null = null;
    let subscriptionStartedAt: Date | null = null;
    let currentMonthly: number | null = null;

    if (payment.stripeSubscriptionId) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(payment.stripeSubscriptionId);
        subscriptionStatus = subscription.status;
        // The plan's real start (not when this visit was linked to it) and what
        // it bills now, after any follow-up visit changed it.
        subscriptionStartedAt = subscription.start_date ? new Date(subscription.start_date * 1000) : null;
        currentMonthly =
          subscription.items.data.reduce((t, it) => t + (it.price.unit_amount ?? 0) * (it.quantity ?? 1), 0) / 100;
        // A cancellation can be scheduled via cancel_at_period_end OR a cancel_at timestamp
        // (the Stripe Billing Portal / dashboard use cancel_at). Treat either as canceling so a
        // cancellation done directly in Stripe is reflected here.
        cancelAtPeriodEnd = !!(subscription.cancel_at_period_end || (subscription as any).cancel_at);
        currentPeriodEnd = periodEndOf(subscription)
          ? new Date(periodEndOf(subscription) * 1000)
          : null;
        
        // Update database with latest subscription status
        // If cancel_at_period_end is true, set status to 'canceling' even if Stripe shows 'active'
        const dbSubscriptionStatus = cancelAtPeriodEnd ? 'canceling' : subscription.status;
        
        // Get period dates with fallback logic
        const sub = subscription as any;
        let periodStart: number | null = periodStartOf(sub) || null;
        let periodEnd: number | null = periodEndOf(sub) || null;

        // If subscription doesn't have period dates, try to get from latest invoice
        if ((!periodStart || !periodEnd) && sub.latest_invoice) {
          try {
            const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
            if (invoiceId) {
              const invoice = await this.stripe.invoices.retrieve(invoiceId);
              const inv = invoice as any;
              if (inv.period_start) periodStart = inv.period_start;
              if (inv.period_end) periodEnd = inv.period_end;
            }
          } catch (invError: any) {
            console.log(`⚠️  Could not retrieve invoice for period dates: ${invError.message}`);
          }
        }

        // Convert to Date objects
        let subscriptionStartDate: Date | null = periodStart ? new Date(periodStart * 1000) : null;
        let calculatedPeriodEnd: Date | null = periodEnd ? new Date(periodEnd * 1000) : null;

        // If start and end dates are the same, calculate end as start + 1 month
        if (subscriptionStartDate && calculatedPeriodEnd && 
            subscriptionStartDate.getTime() === calculatedPeriodEnd.getTime()) {
          calculatedPeriodEnd = new Date(subscriptionStartDate);
          calculatedPeriodEnd.setMonth(calculatedPeriodEnd.getMonth() + 1);
        }

        // Use calculated period end or fallback to currentPeriodEnd
        const finalPeriodEnd = calculatedPeriodEnd || currentPeriodEnd;

        // Stripe is the source of truth. If it is actively billing this
        // subscription, the local row must say SUCCEEDED — otherwise `paid`
        // below stays false and the portal keeps offering "Pay invoice" for a
        // subscription the patient is already being charged for. Self-heals rows
        // left PENDING by an abandoned first attempt.
        const stripeIsBilling = subscription.status === 'active' || subscription.status === 'trialing';
        const reconciledStatus =
          stripeIsBilling && payment.status !== 'SUCCEEDED' ? { status: 'SUCCEEDED' as const } : {};

        await this.prisma.medicationPayment.update({
          where: { appointmentId },
          data: {
            subscriptionStatus: dbSubscriptionStatus as any,
            subscriptionEndDate: finalPeriodEnd as any,
            subscriptionCanceledAt: (cancelAtPeriodEnd ? ((payment as any).subscriptionCanceledAt || new Date()) : null) as any,
            ...reconciledStatus,
          },
        });
        if (Object.keys(reconciledStatus).length) {
          payment.status = 'SUCCEEDED' as any;
          console.log(`✅ Reconciled medication payment ${appointmentId} to SUCCEEDED from live Stripe subscription`);
        }
      } catch (error: any) {
        console.error('Error retrieving subscription status:', error);
        // If subscription doesn't exist in Stripe, clean up stale data
        if (error.code === 'resource_missing') {
          console.log(`⚠️  Medication subscription ${payment.stripeSubscriptionId} not found in Stripe. Cleaning up stale data.`);
          await this.prisma.medicationPayment.update({
            where: { appointmentId },
            data: {
              stripeSubscriptionId: null,
              status: 'PENDING', // Reset to pending so user can retry
              subscriptionStatus: null as any,
              subscriptionCanceledAt: null as any,
              subscriptionEndDate: null as any,
            },
          });
        }
      }
    }

    // Return the database status if cancel_at_period_end is true, otherwise use Stripe status
    const finalSubscriptionStatus = cancelAtPeriodEnd ? 'canceling' : subscriptionStatus;
    
    // Get the end date from database first, then fallback to calculated
    const finalEndDate = (payment as any).subscriptionEndDate || currentPeriodEnd;

    return {
      status: payment.status,
      paid: payment.status === 'SUCCEEDED' && (subscriptionStatus === 'active' || subscriptionStatus === 'trialing'),
      isSubscription: !!payment.stripeSubscriptionId,
      subscriptionStatus: finalSubscriptionStatus,
      cancelAtPeriodEnd: cancelAtPeriodEnd,
      subscriptionEndDate: finalEndDate,
      subscriptionCanceledAt: (payment as any).subscriptionCanceledAt,
      amount: Number(payment.amount),
      paidAt: payment.paidAt,
      paymentIntent: payment.paymentIntent,
      subscriptionId: payment.stripeSubscriptionId,
      // Follow-up billed to the existing monthly plan when the doctor submitted:
      // the visit didn't start a subscription, so paidAt isn't a start date.
      billingAppliedAt: payment.billingAppliedAt,
      subscriptionStartedAt,
      nextBillingDate: currentPeriodEnd,
      currentMonthly,
      supersededBy: await this.laterVisitOnSameSubscription(appointmentId, payment),
      visitBilling: payment.billingAppliedAt ? await this.visitBillingSummary(appointmentId, payment) : null,
      pendingCharge: payment.pendingChargeInvoiceId
        ? { amount: Number(payment.pendingChargeAmount ?? 0), reason: payment.pendingChargeReason }
        : null,
    };
  }

  /**
   * Cancel medication subscription for an appointment
   * This cancels the Stripe subscription and updates the payment record
   */
  // Flip a subscription's ACTIVE medication order to PAST when it's cancelled, so
  // the set-based active-medication model matches the legacy/care-plan view.
  private async flipMedicationOrderToPast(
    stripeSubscriptionId: string | null,
    endedAt: Date | null,
  ): Promise<void> {
    if (!stripeSubscriptionId) return;
    try {
      await this.prisma.medicationOrder.updateMany({
        where: { stripeSubscriptionId, status: 'ACTIVE' as any },
        data: { status: 'PAST' as any, endedAt: endedAt ?? new Date() },
      });
    } catch (err: any) {
      console.error(`[medication] flip order to PAST failed: ${err?.message}`);
    }
  }

  async cancelMedicationSubscription(appointmentId: string, userId: string, userType?: string) {
    // Get appointment to verify authorization
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryEmail: true,
          },
        },
        service: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Allow access if user is the doctor assigned to the appointment, the patient, OR an admin
    const isDoctor = appointment.doctorId === userId;
    const isPatient = appointment.patientId === userId;
    const isAdmin = userType === 'admin';

    if (!isDoctor && !isPatient && !isAdmin) {
      throw new BadRequestException('Unauthorized. Only the assigned doctor, patient, or admin can cancel medication subscriptions.');
    }

    // Get medication payment record
    const payment = await this.prisma.medicationPayment.findUnique({
      where: { appointmentId },
    });

    if (!payment) {
      throw new NotFoundException('No medication subscription found for this appointment');
    }

    if (!payment.stripeSubscriptionId) {
      throw new BadRequestException('No active subscription found for this appointment');
    }

    // Cancel subscription in Stripe at period end (same as monthly membership)
    try {
      const subscription = await this.stripe.subscriptions.retrieve(payment.stripeSubscriptionId);
      
      if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
        // Subscription already canceled
        console.log(`Subscription ${payment.stripeSubscriptionId} is already canceled`);
        await this.prisma.medicationPayment.update({
          where: { appointmentId },
          data: {
            status: 'CANCELLED',
            subscriptionStatus: 'canceled' as any,
          },
        });
        await this.flipMedicationOrderToPast(payment.stripeSubscriptionId, new Date());
        return {
          success: true,
          message: 'Medication subscription was already canceled',
          appointmentId,
          subscriptionId: payment.stripeSubscriptionId,
        };
      } else {
        // Cancel subscription at period end (same as monthly membership)
        const updatedSubscription = await this.stripe.subscriptions.update(
          payment.stripeSubscriptionId,
          {
            cancel_at_period_end: true,
          }
        );
        console.log(`✅ Set medication subscription ${payment.stripeSubscriptionId} to cancel at period end for appointment ${appointmentId}`);
        
        // Get subscription end date with robust fallback logic (same as monthly subscription)
        const sub = updatedSubscription as any;
        let periodStart: number | null = periodStartOf(sub) || null;
        let periodEnd: number | null = periodEndOf(sub) || null;

        console.log(`🔍 Subscription ${sub.id} - current_period_start: ${periodStart}, current_period_end: ${periodEnd}`);

        // If subscription doesn't have period dates, try to get from latest invoice
        if ((!periodStart || !periodEnd) && sub.latest_invoice) {
          try {
            const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
            if (invoiceId) {
              const invoice = await this.stripe.invoices.retrieve(invoiceId);
              const inv = invoice as any;
              if (inv.period_start) periodStart = inv.period_start;
              if (inv.period_end) periodEnd = inv.period_end;
              console.log(`📅 Using period_start from invoice: ${periodStart}`);
              console.log(`📅 Using period_end from invoice: ${periodEnd}`);
            }
          } catch (invError: any) {
            console.log(`⚠️  Could not retrieve invoice for period dates: ${invError.message}`);
          }
        }

        // Convert to Date objects
        let subscriptionStartDate: Date | null = periodStart ? new Date(periodStart * 1000) : null;
        let subscriptionEndDate: Date | null = periodEnd ? new Date(periodEnd * 1000) : null;

        // If start and end dates are the same, calculate end as start + 1 month
        if (subscriptionStartDate && subscriptionEndDate && 
            subscriptionStartDate.getTime() === subscriptionEndDate.getTime()) {
          console.log(`⚠️  Start and end dates are identical. Calculating end date as start + 1 month.`);
          subscriptionEndDate = new Date(subscriptionStartDate);
          subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);
          console.log(`📅 Calculated end date: ${subscriptionEndDate.toISOString()}`);
        }

        // If we still don't have an end date, calculate it as current date + 1 month
        if (!subscriptionEndDate) {
          console.warn(`⚠️  No period end found, calculating as current date + 1 month`);
          subscriptionEndDate = new Date();
          subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);
        }

        console.log(`📅 Final subscription end date: ${subscriptionEndDate.toISOString()}`);

        // Update payment record to reflect cancellation at period end
        // Note: These fields will be available after Prisma client regeneration
        const updateData: any = {
          subscriptionStatus: 'canceling', // Set to canceling when cancel_at_period_end is true
          subscriptionCanceledAt: new Date(),
          subscriptionEndDate: subscriptionEndDate, // Always set the end date
          // Keep status as SUCCEEDED since subscription is still active until period end
        };

        console.log(`💾 Updating medication payment with:`, {
          subscriptionStatus: 'canceling',
          subscriptionCanceledAt: updateData.subscriptionCanceledAt.toISOString(),
          subscriptionEndDate: subscriptionEndDate.toISOString(),
        });

        const updated = await this.prisma.medicationPayment.update({
          where: { appointmentId },
          data: updateData,
        });

        // Reflect the cancellation in the unified active-medication model so the
        // set-based orders match the care plan / legacy view (which flips to PAST
        // on cancellation). The paid charge in the ledger stays SUCCEEDED.
        await this.flipMedicationOrderToPast(payment.stripeSubscriptionId, subscriptionEndDate);

        // Verify the update
        const verifyUpdated = await this.prisma.medicationPayment.findUnique({
          where: { appointmentId },
        });

        console.log(`✅ Updated medication payment. Verification:`, {
          subscriptionStatus: (verifyUpdated as any)?.subscriptionStatus,
          subscriptionEndDate: (verifyUpdated as any)?.subscriptionEndDate?.toISOString() || 'NULL',
          subscriptionCanceledAt: (verifyUpdated as any)?.subscriptionCanceledAt?.toISOString() || 'NULL',
        });

        // Send cancellation email to patient with end date
        try {
          const patient = appointment.patient;
          if (patient.primaryEmail) {
            const patientName = `${patient.firstName || ''} ${patient.lastName || ''}`.trim() || 'Valued Patient';
            
            // Get service name and medication names
            const serviceName = appointment.service?.name || undefined;
            
            // Get medication names from appointment medications
            let oldMedicationName: string | undefined = undefined;
            if (appointment.medications && typeof appointment.medications === 'object') {
              const medicationNames: string[] = [];
              Object.values(appointment.medications).forEach((meds: any) => {
                if (Array.isArray(meds)) {
                  meds.forEach((med: any) => {
                    if (typeof med === 'string') {
                      medicationNames.push(med);
                    } else if (med && typeof med === 'object' && med.name) {
                      medicationNames.push(med.name);
                    }
                  });
                }
              });
              if (medicationNames.length > 0) {
                oldMedicationName = medicationNames.join(', ');
              }
            }
            
            await this.mailerService.sendMedicationSubscriptionCancellationEmail(
              patient.primaryEmail,
              patientName,
              appointmentId,
              Number(payment.amount),
              subscriptionEndDate || undefined,
              serviceName,
              oldMedicationName,
            );
            console.log(`✅ Medication subscription cancellation email sent to ${patient.primaryEmail}`);
          }
        } catch (emailError) {
          console.error('Failed to send medication subscription cancellation email:', emailError);
          // Don't throw - cancellation is already processed
        }

        return {
          success: true,
          message: 'Medication subscription will be canceled at the end of the billing period',
          appointmentId,
          subscriptionId: payment.stripeSubscriptionId,
          endsAt: subscriptionEndDate,
        };
      }
    } catch (error: any) {
      console.error(`❌ Error canceling medication subscription: ${error.message}`);
      
      // If subscription doesn't exist in Stripe, clean up stale data
      if (error.code === 'resource_missing') {
        console.log(`⚠️  Medication subscription ${payment.stripeSubscriptionId} not found in Stripe. Cleaning up stale data.`);
        await this.prisma.medicationPayment.update({
          where: { appointmentId },
          data: {
            stripeSubscriptionId: null,
            status: 'CANCELLED',
          },
        });
        return {
          success: true,
          message: 'Medication subscription canceled (subscription was already removed in Stripe)',
          appointmentId,
        };
      }
      
      throw new BadRequestException(`Failed to cancel medication subscription: ${error.message}`);
    }
  }

  /**
   * Reactivate a canceled medication subscription
   */
  async reactivateMedicationSubscription(appointmentId: string, userId: string) {
    // Get appointment to verify authorization
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Verify user owns this appointment
    if (appointment.patientId !== userId) {
      throw new BadRequestException('Unauthorized');
    }

    // Get medication payment record
    const payment = await this.prisma.medicationPayment.findUnique({
      where: { appointmentId },
    });

    if (!payment || !payment.stripeSubscriptionId) {
      throw new NotFoundException('No medication subscription found for this appointment');
    }

    try {
      const subscription = await this.stripe.subscriptions.retrieve(payment.stripeSubscriptionId);
      
      if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
        throw new BadRequestException('Subscription is already canceled and cannot be reactivated');
      }

      // Reactivate subscription if a cancellation is scheduled — either via cancel_at_period_end
      // or a cancel_at timestamp (Billing Portal / dashboard). Stripe rejects passing both params,
      // so clear only the one that was actually used.
      if (subscription.cancel_at_period_end || (subscription as any).cancel_at) {
        const reactivateParams: Stripe.SubscriptionUpdateParams = (subscription as any).cancel_at
          ? { cancel_at: '' }
          : { cancel_at_period_end: false };
        const updatedSubscription = await this.stripe.subscriptions.update(
          payment.stripeSubscriptionId,
          reactivateParams,
        );

        // Get subscription end date with robust fallback logic
        const sub = updatedSubscription as any;
        let periodEnd: number | null = periodEndOf(sub) || null;

        // If subscription doesn't have period_end, try to get from latest invoice
        if (!periodEnd && sub.latest_invoice) {
          try {
            const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
            if (invoiceId) {
              const invoice = await this.stripe.invoices.retrieve(invoiceId);
              const inv = invoice as any;
              if (inv.period_end) periodEnd = inv.period_end;
            }
          } catch (invError: any) {
            console.log(`⚠️  Could not retrieve invoice for period end: ${invError.message}`);
          }
        }

        // Convert to Date object
        let subscriptionEndDate: Date | null = periodEnd ? new Date(periodEnd * 1000) : null;

        // If we still don't have an end date, calculate it as current date + 1 month
        if (!subscriptionEndDate) {
          subscriptionEndDate = new Date();
          subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1);
        }

        // Update payment record
        await this.prisma.medicationPayment.update({
          where: { appointmentId },
          data: {
            subscriptionStatus: 'active' as any,
            subscriptionCanceledAt: null as any,
            subscriptionEndDate: subscriptionEndDate as any,
          },
        });

        return {
          success: true,
          message: 'Medication subscription reactivated successfully',
          appointmentId,
          subscriptionId: payment.stripeSubscriptionId,
          endsAt: subscriptionEndDate,
        };
      } else {
        // Subscription is already active
        return {
          success: true,
          message: 'Subscription is already active',
          appointmentId,
          subscriptionId: payment.stripeSubscriptionId,
        };
      }
    } catch (error: any) {
      console.error(`❌ Error reactivating medication subscription: ${error.message}`);
      throw new BadRequestException(`Failed to reactivate medication subscription: ${error.message}`);
    }
  }

  /**
   * Stripe's own hosted receipt URL for a succeeded PaymentIntent's charge — lets a
   * ledger row that has no line items (signup, appointment) still offer something
   * concrete to view on expand instead of nothing. Best-effort: never throws, just
   * returns null if the charge/receipt isn't available for any reason.
   */
  async getReceiptUrl(paymentIntentId: string): Promise<string | null> {
    try {
      const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      });
      const charge = pi.latest_charge;
      if (charge && typeof charge !== 'string') {
        return (charge as Stripe.Charge).receipt_url ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * A subscription's current billing period (unix seconds). Since Stripe API
 * 2025-03-31.basil (we use 2025-10-29.clover) `current_period_start/end` live on
 * the subscription ITEMS, not the subscription — reading the old field gives
 * undefined, and the invoice-period fallback then returns the PREVIOUS period
 * (a renewal invoice bills the period that just ended). Read both places.
 */
function periodStartOf(sub: any): any {
  return sub?.current_period_start ?? sub?.items?.data?.[0]?.current_period_start ?? null;
}
function periodEndOf(sub: any): any {
  return sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
}

/** Short stable token from free text, for idempotency keys. */
function norm16(s: string): string {
  return createHash('sha1').update((s || '').trim().toLowerCase()).digest('hex').slice(0, 16);
}

/** What happened when the doctor submitted a prescription (applyMedicationsAtSubmit). */
export interface MedicationSubmitResult {
  mode: 'new' | 'unchanged' | 'update' | 'review' | 'none' | 'applied' | 'charge_failed';
  message: string;
  /** charge_failed: the saved card couldn't be charged; nothing changed yet. */
  chargeFailure?: {
    amount: number;
    card: { brand: string; last4: string } | null;
    reason: string | null;
    medications: string[];
    nextRenewal: Date | null;
  };
  newMonthly?: number;
  nextRenewal?: Date | null;
  chargedToday?: number;
  pendingCharge?: { amount: number; reason: 'declined' | 'no_card' } | null;
}

/** The medications a live subscription bills, matched back to the catalogue where possible. */
function liveMedicationItems(sub: Stripe.Subscription) {
  return sub.items.data.map((it) => {
    const product: any = it.price.product;
    return {
      itemId: it.id,
      medicationId:
        it.price.metadata?.medicationId || (typeof product === 'object' ? product?.metadata?.medicationId : '') || null,
      name: typeof product === 'object' && !product?.deleted ? product.name : '',
      cents: (it.price.unit_amount ?? 0) * (it.quantity ?? 1),
      /** The visit whose prescription created this price (follow-up adds and swaps set it). */
      appointmentId: it.price.metadata?.appointmentId || null,
    };
  });
}

/** Same prescription contents → same Stripe objects on a retry or double click. */
function medicationChangeIdem(appointmentId: string, plan: MedicationChangePlan): string {
  const contentKey = createHash('sha1')
    .update(JSON.stringify(plan.lines.map((l) => [l.action, l.medicationId, l.toCents, l.itemId, l.billingStart])))
    .digest('hex')
    .slice(0, 16);
  return `medupd-${appointmentId}-${contentKey}`;
}

/** One prescribed or billed medication and what a follow-up visit does to it. See planMedicationChange. */
export interface MedicationPlanLine {
  action: 'continue' | 'change' | 'add' | 'stop';
  medicationId: string | null;
  name: string;
  detail: string | null;
  dosageSnapshot: string | null;
  /** Monthly cents on the live subscription today (null for an add). */
  fromCents: number | null;
  /** Monthly cents after this visit (null for a stop). */
  toCents: number | null;
  /** The live subscription item this line continues, changes or stops. */
  itemId: string | null;
  /** For an add: full monthly price today, or first billed on the next invoice. */
  billingStart: 'now' | 'next_invoice';
  /** For a change the doctor marked "replaces": the plan line it replaces. */
  replacesName: string | null;
}

/**
 * The doctor's answer, saved on each prescribed medication: which line of the
 * patient's live subscription it continues or replaces, or that it is new.
 */
export interface MedicationPlanLink {
  kind: 'continue' | 'replace' | 'new';
  subscriptionId: string | null;
  itemId: string | null;
  itemName: string | null;
}

function parsePlanLink(raw: any): MedicationPlanLink | null {
  if (!raw || typeof raw !== 'object' || !['continue', 'replace', 'new'].includes(raw.kind)) return null;
  const str = (v: any) => (typeof v === 'string' && v ? v : null);
  const link = { kind: raw.kind, subscriptionId: str(raw.subscriptionId), itemId: str(raw.itemId), itemName: str(raw.itemName) };
  return link.kind !== 'new' && !link.itemId ? null : link;
}

export interface MedicationChangePlan {
  mode: 'new' | 'unchanged' | 'update' | 'review';
  /** Why the prescription needs the doctor again (mode review). */
  reviewReason: string | null;
  subscriptionId: string | null;
  /** The live subscription was set to cancel; confirming resumes it. */
  resumesCancelled: boolean;
  nextRenewal: Date | null;
  currentMonthly: number;
  newMonthly: number;
  /** Full monthly price of the medications the doctor chose to charge now. */
  dueToday: number;
  lines: MedicationPlanLine[];
}
