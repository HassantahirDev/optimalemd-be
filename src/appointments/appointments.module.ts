import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AppointmentsCleanupService } from './appointments-cleanup.service';
import { BookingsService } from './bookings.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailerModule } from '../mailer/mailer.module';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module';

@Module({
  imports: [ConfigModule, PrismaModule, MailerModule, GoogleCalendarModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, AppointmentsCleanupService, BookingsService],
  exports: [AppointmentsService, BookingsService],
})
export class AppointmentsModule {}
