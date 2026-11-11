import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { MailerModule } from '../mailer/mailer.module';
import { UspsService } from './usps.service';
import { ShipmentsService } from './shipments.service';
import { ShipmentsAdminController } from './shipments-admin.controller';

@Module({
  imports: [ConfigModule, PrismaModule, MailerModule],
  controllers: [ShipmentsAdminController],
  providers: [UspsService, ShipmentsService],
  exports: [ShipmentsService],
})
export class ShippingModule {}
