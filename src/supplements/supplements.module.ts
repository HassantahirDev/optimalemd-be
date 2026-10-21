import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { MailerModule } from '../mailer/mailer.module';
import { PaymentsModule } from '../payments/payments.module';
import { SupplementsController } from './supplements.controller';
import { SupplementsService } from './supplements.service';
import { SupplementOrdersAdminController } from './supplement-orders-admin.controller';
import { SupplementOrdersAdminService } from './supplement-orders-admin.service';

@Module({
  imports: [ConfigModule, PrismaModule, MailerModule, PaymentsModule],
  controllers: [SupplementsController, SupplementOrdersAdminController],
  providers: [SupplementsService, SupplementOrdersAdminService],
  exports: [SupplementsService],
})
export class SupplementsModule {}
