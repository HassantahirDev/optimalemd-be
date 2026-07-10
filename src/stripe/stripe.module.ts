import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { StripeController, StripeWebhookController } from './stripe.controller';
import { StripePosController } from './stripe-pos.controller';
import { StripePosService } from './stripe-pos.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AppointmentsModule } from '../appointments/appointments.module';
import { MailerModule } from '../mailer/mailer.module';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module';
import { ReferralModule } from '../referral/referral.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [ConfigModule, PrismaModule, AppointmentsModule, MailerModule, GoogleCalendarModule, ReferralModule, PaymentsModule],
  providers: [StripeService, StripePosService],
  controllers: [StripeController, StripeWebhookController, StripePosController],
  exports: [StripeService],
})
export class StripeModule {}
