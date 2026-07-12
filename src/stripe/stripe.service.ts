import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentsService } from '../appointments/appointments.service';
import { MailerService } from '../mailer/mailer.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import { ReferralService } from '../referral/referral.service';
import { PaymentLedgerService } from '../payments/payment-ledger.service';
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
    const { appointmentId, welcomeOrderId, amount, currency = 'usd' } = createPaymentIntentDto;

    let metadata: any = {};
    let description = '';

    let stripeCustomerId: string | undefined;

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
      };
      description = `Appointment – ${serviceName} | Patient: ${patientName} | ${doctorName}`;

    } else if (welcomeOrderId) {
      const welcomeOrder = await this.prisma.welcomeOrder.findUnique({
        where: { id: welcomeOrderId },
        include: { user: { select: { id: true, firstName: true, lastName: true, primaryEmail: true, stripeCustomerId: true } } },
      });

      if (!welcomeOrder) throw new NotFoundException('Welcome order not found');
      if (welcomeOrder.paymentStatus === 'SUCCEEDED') throw new BadRequestException('Welcome order is already paid');

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

    // Create payment intent
    let paymentIntent;
    try {
      paymentIntent = await this.stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency,
        metadata,
        description,
        ...(stripeCustomerId && { customer: stripeCustomerId }),
        receipt_email: metadata.patientEmail,
      });
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

    // Create payment record
    if (appointmentId) {
      await this.prisma.payment.create({
        data: {
          appointmentId,
          stripePaymentId: paymentIntent.id,
          amount,
          currency,
          status: 'PENDING',
          paymentIntent: paymentIntent.id,
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

    // Update payment status
    const updatedPayment = await this.prisma.payment.update({
      where: { paymentIntent: paymentIntentId },
      data: {
        status: 'SUCCEEDED',
        paidAt: new Date(),
      },
      select: { amount: true, appointmentId: true },
    });

    // --- Dual-write consult payment into the unified ledger (additive; Part A) ---
    // Existing Payment logic above is untouched.
    const paidAppt = await this.prisma.appointment.findUnique({
      where: { id: updatedPayment.appointmentId },
      select: { patientId: true },
    });
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
      await this.referralService.applyCreditsToAppointment(appointment.patientId, appointmentId);
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
          'You already have an active premium subscription.',
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

    // Create subscription with payment intent
    let subscription: Stripe.Subscription;
    try {
      subscription = await this.stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: 'default_incomplete',
        payment_settings: {
          save_default_payment_method: 'on_subscription',
          payment_method_types: ['card'],
        },
        expand: ['latest_invoice.confirmation_secret'],
        description: `Premium Subscription – ${`${user.firstName || ''} ${user.lastName || ''}`.trim()}`,
        metadata: {
          userId: user.id,
          patientName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
          patientEmail: user.primaryEmail || user.email || '',
          type: 'premium_subscription',
        },
      });
    } catch (stripeError: any) {
      console.error('Stripe subscription creation error:', stripeError);
      throw new BadRequestException(
        stripeError.message || 'Failed to create subscription with Stripe'
      );
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
    if (sub.current_period_start) {
      subscriptionData.subscriptionStartDate = new Date(sub.current_period_start * 1000);
    }
    if (sub.current_period_end) {
      subscriptionData.subscriptionEndDate = new Date(sub.current_period_end * 1000);
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
    
    try {
      updatedSubscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      console.log(`📊 Subscription ${subscriptionId} status: ${updatedSubscription.status}`);
      
      // Try to get period dates from invoice if subscription doesn't have them
      if (invoiceId) {
        try {
          const invoice = await this.stripe.invoices.retrieve(invoiceId);
          const inv = invoice as any;
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
      console.log(`📅 Subscription period - start: ${sub.current_period_start}, end: ${sub.current_period_end}`);
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
    const periodStart = sub.current_period_start ?? invoicePeriodStart;
    const periodEnd = sub.current_period_end ?? invoicePeriodEnd;
    
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
        note: 'Premium membership subscription',
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
    const subscriptionEndDate = (subscription as any).current_period_end
      ? new Date((subscription as any).current_period_end * 1000)
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
          let periodStart: number | null = sub.current_period_start || null;
          let periodEnd: number | null = sub.current_period_end || null;

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

              await this.mailerService.sendSubscriptionConfirmationEmail(
                userForEmail.primaryEmail,
                userName,
                subscriptionStartDate,
                subscriptionEndDate,
                monthlyAmount
              );
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
          let periodStart: number | null = sub.current_period_start || null;
          let periodEnd: number | null = sub.current_period_end || null;

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

              await this.mailerService.sendSubscriptionConfirmationEmail(
                userForEmail.primaryEmail,
                userName,
                subscriptionStartDate,
                subscriptionEndDate,
                monthlyAmount
              );
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
      } else {
        // No premium subscription exists in Stripe at all — ensure DB reflects unsubscribed.
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
    }

    let stripeSubscription: any = null;
    let invoicePeriodStart: number | null = null;
    let invoicePeriodEnd: number | null = null;
    
    if (user.stripeSubscriptionId) {
      try {
        stripeSubscription = await this.stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        
        // Always get dates from Stripe subscription first
        const sub = stripeSubscription as any;
        console.log(`🔍 Subscription ${user.stripeSubscriptionId} - current_period_start: ${sub.current_period_start}, current_period_end: ${sub.current_period_end}`);
        console.log(`🔍 Subscription status: ${sub.status}, id: ${sub.id}`);
        
        // Try to get period dates from latest invoice ONLY if subscription doesn't have them
        if ((!sub.current_period_start || !sub.current_period_end) && sub.latest_invoice) {
          try {
            const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id;
            if (invoiceId) {
              const invoice = await this.stripe.invoices.retrieve(invoiceId);
              const inv = invoice as any;
              console.log(`🔍 Invoice ${invoiceId} - period_start: ${inv.period_start}, period_end: ${inv.period_end}`);
              
              // Only use invoice dates if subscription doesn't have them
              if (!sub.current_period_start && inv.period_start) {
                invoicePeriodStart = inv.period_start;
                console.log(`📅 Using period_start from invoice: ${invoicePeriodStart}`);
              }
              if (!sub.current_period_end && inv.period_end) {
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
        const periodStart = sub.current_period_start ?? invoicePeriodStart;
        const periodEnd = sub.current_period_end ?? invoicePeriodEnd;
        
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
        const needsUpdate = 
          stripeStatus !== dbStatus || 
          (isActiveInStripe && !user.isSubscribed) ||
          (!user.subscriptionStartDate && stripeStartDate) ||
          (!user.subscriptionEndDate && stripeEndDate);
        
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
        note: 'Premium membership subscription',
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
          let periodStart: number | null = sub.current_period_start || null;
          let periodEnd: number | null = sub.current_period_end || null;

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

          // P0: only premium-membership invoices update the user's premium fields. A medication
          // (or other) subscription invoice must not flip premium membership status/dates.
          if (sub.metadata?.type !== 'premium_subscription') {
            console.log(`ℹ️  Skipping non-premium invoice.payment_succeeded (type=${sub.metadata?.type})`);
            break;
          }

          console.log(`✅ Activating subscription for user ${userId}`);
          
          // Extract dates with robust fallback logic (same as renewSubscription)
          let periodStart: number | null = sub.current_period_start || null;
          let periodEnd: number | null = sub.current_period_end || null;

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
    
    if (!medicationsData || Object.keys(medicationsData).length === 0) {
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
    Object.values(medicationsData).forEach((meds: any[]) => {
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
    }> = [];

    Object.entries(medicationsData).forEach(([category, meds]) => {
      meds.forEach((med: any) => {
        if (typeof med === 'object' && med.id) {
          const medication = medications.find(m => m.id === med.id);
          if (medication) {
            const standardPrice = Number(medication.standardPrice);
            const membershipPrice = medication.membershipPrice ? Number(medication.membershipPrice) : null;
            
            standardTotal += standardPrice;
            if (membershipPrice !== null) {
              memberTotal += membershipPrice;
            } else {
              memberTotal += standardPrice;
            }

            tempItems.push({
              medicationId: medication.id,
              name: medication.name,
              strength: medication.strength,
              dose: medication.dose,
              frequency: medication.frequency,
              route: medication.route,
              standardPrice,
              membershipPrice,
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
    }> = [];

    let subtotal = 0;
    let totalDiscount = 0;

    tempItems.forEach((tempItem) => {
      // If payment is made, use the prices that were actually paid
      // Otherwise, use current subscription status
      const shouldUseMemberPrice = usePaidPrices 
        ? paidAsSubscribed 
        : (isSubscribed && tempItem.membershipPrice !== null);
      
      const price = shouldUseMemberPrice && tempItem.membershipPrice !== null 
        ? tempItem.membershipPrice 
        : tempItem.standardPrice;
      
      const discount = shouldUseMemberPrice && tempItem.membershipPrice !== null 
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
              price,
              discount,
            });

            subtotal += price;
            totalDiscount += discount;
    });

    return {
      items,
      subtotal,
      total: subtotal,
      isSubscribed, // Current subscription status (for UI hints)
      discount: totalDiscount,
      currency: 'usd',
      isPaid: usePaidPrices, // Indicates if showing paid prices
    };
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

    // P0 (M1): guard against duplicate medication subscriptions. Trust Stripe live, not just the
    // local DB row (which can drift). If an actively-billing medication subscription already exists
    // for this appointment, sync the DB row and refuse to create another that would double-bill.
    const existingActiveSub = await this.findActiveMedicationSubscriptionFromStripe(
      customerId,
      appointmentId,
    );
    if (existingActiveSub) {
      await this.prisma.medicationPayment.upsert({
        where: { appointmentId },
        create: {
          appointmentId,
          stripeSubscriptionId: existingActiveSub.id,
          stripeCustomerId: customerId,
          amount: invoice.total,
          currency: invoice.currency,
          status: 'SUCCEEDED',
          subscriptionStatus: existingActiveSub.status as any,
        },
        update: {
          stripeSubscriptionId: existingActiveSub.id,
          stripeCustomerId: customerId,
          subscriptionStatus: existingActiveSub.status as any,
        },
      });
      throw new BadRequestException(
        'A medication subscription is already active for this appointment.',
      );
    }

    // P0 (M2): deterministic idempotency key base so concurrent/retried requests for the SAME
    // appointment + amount reuse the same Stripe objects instead of creating duplicates.
    const idemBase = `med-${appointmentId}-${Math.round(invoice.total * 100)}`;

    // For dynamic pricing, we create a new price each time since the amount varies
    // We use a base product name but create unique prices for each appointment's medication set
    // Check if we already have a product for this appointment (in case of retries)
    let productId: string | undefined;
    try {
      // Try to find existing product for this appointment
      const products = await this.stripe.products.search({
        query: `metadata['appointmentId']:'${appointmentId}' AND metadata['type']:'medication'`,
        limit: 1,
      });
      
      if (products.data.length > 0) {
        productId = products.data[0].id;
        console.log(`✅ Reusing existing product ${productId} for appointment ${appointmentId}`);
      }
    } catch (error) {
      console.log('Could not search for existing product, will create new one');
    }

    // Build readable medication list for Stripe description
    const patientFullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    const medNames = invoice.items.map((item: any) => item.name).join(', ');

    // Create product if it doesn't exist
    let product: Stripe.Product;
    if (productId) {
      product = await this.stripe.products.retrieve(productId);
    } else {
      product = await this.stripe.products.create(
        {
          name: `Medications – ${patientFullName}`,
          metadata: {
            appointmentId,
            userId,
            patientName: patientFullName,
            patientEmail: email,
            type: 'medication',
            medications: medNames.substring(0, 500),
          },
        },
        { idempotencyKey: `${idemBase}-product` },
      );
      console.log(`✅ Created new product ${product.id} for appointment ${appointmentId}`);
    }

    // Create a new price with the current invoice total (amounts can change)
    // This allows for dynamic pricing per appointment. (No volatile fields in metadata so the
    // idempotency key reliably reuses the same price on concurrent/retried requests.)
    const price = await this.stripe.prices.create(
      {
        unit_amount: Math.round(invoice.total * 100), // Convert to cents
        currency: invoice.currency,
        recurring: {
          interval: 'month',
        },
        product: product.id, // Use existing product
        metadata: {
          appointmentId,
          userId,
          type: 'medication',
          invoiceTotal: invoice.total.toString(),
        },
      },
      { idempotencyKey: `${idemBase}-price` },
    );
    console.log(`✅ Created new price ${price.id} for $${invoice.total} (appointment ${appointmentId})`);

    // Create subscription with payment intent
    let subscription: Stripe.Subscription;
    try {
      subscription = await this.stripe.subscriptions.create(
        {
          customer: customerId,
          items: [{ price: price.id }],
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
            items: [{ price: price.id }],
            payment_behavior: 'default_incomplete',
            payment_settings: {
              save_default_payment_method: 'on_subscription',
              payment_method_types: ['card'],
            },
            expand: ['latest_invoice.payment_intent'],
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
        },
      });
    }

    return {
      clientSecret: clientSecret,
      paymentIntentId: paymentIntent.id,
      subscriptionId: subscription.id,
      amount: invoice.total,
      currency: invoice.currency,
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
        subscriptionEndDate = (subscription as any).current_period_end
          ? new Date((subscription as any).current_period_end * 1000)
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

    // Calculate invoice to get item details for email
    const invoice = await this.calculateMedicationInvoice(payment.appointmentId, userId);

    // Send confirmation email with invoice details
    try {
      const patient = payment.appointment.patient;
      if (patient.email) {
        await this.mailerService.sendMedicationPaymentConfirmationEmail(
          patient.email,
          `${patient.firstName} ${patient.lastName}`,
          Number(payment.amount),
          payment.appointmentId,
          invoice.items,
          invoice.isSubscribed,
          invoice.discount,
        );
        console.log(`Medication payment confirmation email sent to ${patient.email}`);
      } else {
        console.warn(`Cannot send medication payment confirmation email: patient ${patient.id} has no email address`);
      }
    } catch (emailError) {
      // Log error but don't fail the payment confirmation
      console.error('Failed to send medication payment confirmation email:', emailError);
    }

    // --- Dual-write into the unified payment ledger (additive; Part A + B) ---
    // Existing medicationPayment logic above is untouched. Medication line items
    // feed the set-based MedicationOrder lifecycle inside the ledger service.
    const isMedSubscription = !!payment.stripeSubscriptionId;
    await this.paymentLedger.upsertFromStripe({
      stripePaymentIntentId: paymentIntentId,
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

    const payment = await this.prisma.medicationPayment.findUnique({
      where: { appointmentId },
    });

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
    
    if (payment.stripeSubscriptionId) {
      try {
        const subscription = await this.stripe.subscriptions.retrieve(payment.stripeSubscriptionId);
        subscriptionStatus = subscription.status;
        // A cancellation can be scheduled via cancel_at_period_end OR a cancel_at timestamp
        // (the Stripe Billing Portal / dashboard use cancel_at). Treat either as canceling so a
        // cancellation done directly in Stripe is reflected here.
        cancelAtPeriodEnd = !!(subscription.cancel_at_period_end || (subscription as any).cancel_at);
        currentPeriodEnd = (subscription as any).current_period_end
          ? new Date((subscription as any).current_period_end * 1000)
          : null;
        
        // Update database with latest subscription status
        // If cancel_at_period_end is true, set status to 'canceling' even if Stripe shows 'active'
        const dbSubscriptionStatus = cancelAtPeriodEnd ? 'canceling' : subscription.status;
        
        // Get period dates with fallback logic
        const sub = subscription as any;
        let periodStart: number | null = sub.current_period_start || null;
        let periodEnd: number | null = sub.current_period_end || null;

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

        // Note: These fields will be available after Prisma client regeneration
        await this.prisma.medicationPayment.update({
          where: { appointmentId },
          data: {
            subscriptionStatus: dbSubscriptionStatus as any,
            subscriptionEndDate: finalPeriodEnd as any,
            subscriptionCanceledAt: (cancelAtPeriodEnd ? ((payment as any).subscriptionCanceledAt || new Date()) : null) as any,
          },
        });
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
        let periodStart: number | null = sub.current_period_start || null;
        let periodEnd: number | null = sub.current_period_end || null;

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
        let periodEnd: number | null = sub.current_period_end || null;

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
}
