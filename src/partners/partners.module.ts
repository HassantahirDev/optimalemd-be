import { Module } from '@nestjs/common';
import { PartnersService } from './partners.service';
import { PartnersController } from './partners.controller';
import { PartnersAdminController } from './partners-admin.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PartnersController, PartnersAdminController],
  providers: [PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
