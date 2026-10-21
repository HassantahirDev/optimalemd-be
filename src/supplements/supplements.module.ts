import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { MailerModule } from '../mailer/mailer.module';
import { PaymentsModule } from '../payments/payments.module';
import { StripeModule } from '../stripe/stripe.module';
import { SUPPLEMENTS_SERVICE } from './supplements.catalog';
import { SupplementsController } from './supplements.controller';
import { SupplementsService } from './supplements.service';
import { SupplementOrdersAdminController } from './supplement-orders-admin.controller';
import { SupplementOrdersAdminService } from './supplement-orders-admin.service';

@Module({
  imports: [ConfigModule, PrismaModule, MailerModule, PaymentsModule, StripeModule],
  controllers: [SupplementsController, SupplementOrdersAdminController],
  providers: [
    SupplementsService,
    SupplementOrdersAdminService,
    { provide: SUPPLEMENTS_SERVICE, useExisting: SupplementsService },
  ],
  exports: [SupplementsService],
})
export class SupplementsModule {}
