import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppointmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { buildAutoLoginLink } from '../common/utils/auto-login-link.util';

type ReminderKind = '24h' | '30m';

@Injectable()
export class AppointmentRemindersService {
  private readonly logger = new Logger(AppointmentRemindersService.name);

  /** How far either side of the target the sweep will accept, in minutes. */
  private readonly WINDOW_MINUTES = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailerService: MailerService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * The exact instant an appointment starts.
   *
   * `appointmentDate` is a @db.Date and `appointmentTime` is "HH:MM", and BOTH
   * are UTC. This is the same conversion the booking page performs in
   * utcToLocalTime() and every existing appointment email performs before
   * formatting — build the instant with Date.UTC and let the formatter handle
   * the display zone. Never subtract hours from the date alone, and never parse
   * the time string in server-local time: the server runs in UTC in production
   * and something else in development, which is exactly how reminders drift.
   */
  private appointmentInstant(appointmentDate: Date, appointmentTime: string): Date | null {
    const [hours, minutes] = String(appointmentTime || '').split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

    const iso = appointmentDate.toISOString().split('T')[0];
    const [year, month, day] = iso.split('-').map(Number);
    if (!year || !month || !day) return null;

    return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));
  }

  /**
   * The one host that must NOT run the reminder sweep.
   *
   * formamd-production is the primary backend and IS expected to send reminders.
   * Only the legacy optimale deployment sits this out, so the job runs in exactly
   * one place without needing configuration.
   *
   * Hardcoded on purpose, and deliberately NOT reusing LEGACY_BACKEND_URL — that
   * variable is read elsewhere (uploads, reports, blog) as a SINGLE origin which
   * gets concatenated onto a path, so turning it into a list breaks legacy file
   * proxying.
   */
  private readonly SKIP_HOST =
    'optimaleproduction-ckfmbfgyccfjg3dc.canadacentral-01.azurewebsites.net';

  /**
   * Azure App Service sets WEBSITE_HOSTNAME on every deployed instance. Locally
   * it is undefined, so the sweep runs in development.
   */
  private isSkippedHost(): boolean {
    const me = process.env.WEBSITE_HOSTNAME;
    if (!me) return false;
    return me.toLowerCase() === this.SKIP_HOST;
  }

  @Cron('0 */5 * * * *') // every 5 minutes
  async sweep(): Promise<void> {
    if (this.isSkippedHost()) {
      this.logger.debug(`Skipping reminder sweep on ${process.env.WEBSITE_HOSTNAME}`);
      return;
    }

    try {
      await this.run('24h', 24 * 60);
      await this.run('30m', 30);
    } catch (err) {
      // A reminder failure must never take the scheduler down.
      this.logger.error('Reminder sweep failed', err as any);
    }
  }

  private async run(kind: ReminderKind, minutesAhead: number): Promise<void> {
    const now = Date.now();
    const target = now + minutesAhead * 60_000;
    const windowMs = this.WINDOW_MINUTES * 60_000;

    const sentField = kind === '24h' ? 'reminder24hSentAt' : 'reminder30mSentAt';

    // Narrow by date in SQL — the instant itself can't be computed in the query
    // because the time lives in a separate string column. One day either side
    // covers every timezone offset.
    const candidates = await this.prisma.appointment.findMany({
      where: {
        status: AppointmentStatus.CONFIRMED,
        [sentField]: null,
        appointmentDate: {
          gte: new Date(target - 36 * 60 * 60_000),
          lte: new Date(target + 36 * 60 * 60_000),
        },
      },
      select: {
        id: true,
        createdAt: true,
        appointmentDate: true,
        appointmentTime: true,
        patient: {
          select: { id: true, firstName: true, lastName: true, primaryEmail: true, email: true },
        },
        doctor: { select: { firstName: true, lastName: true } },
      },
    });

    for (const appt of candidates) {
      const startsAt = this.appointmentInstant(appt.appointmentDate, appt.appointmentTime);
      if (!startsAt) continue;

      // Already started, or not yet due.
      if (startsAt.getTime() <= now) continue;
      if (Math.abs(startsAt.getTime() - target) > windowMs) continue;

      // A booking made AFTER its own reminder point never gets that reminder:
      // someone who books 20 minutes before the slot should not receive a
      // "starts in 30 minutes" email, and a same-day booking gets no 24h notice.
      const reminderPoint = startsAt.getTime() - minutesAhead * 60_000;
      if (appt.createdAt.getTime() > reminderPoint) continue;

      await this.sendReminder(kind, sentField, appt);
    }
  }

  private async sendReminder(kind: ReminderKind, sentField: string, appt: any): Promise<void> {
    const to = appt.patient?.primaryEmail || appt.patient?.email;
    if (!to) return;

    // Claim it FIRST, conditionally. If the other server got here a moment ago
    // its update already set the field, count comes back 0, and we skip — so the
    // email is sent at most once no matter how many instances are running.
    const claim = await this.prisma.appointment.updateMany({
      where: { id: appt.id, [sentField]: null },
      data: { [sentField]: new Date() },
    });
    if (claim.count === 0) return;

    try {
      const patientName =
        `${appt.patient.firstName || ''} ${appt.patient.lastName || ''}`.trim() || 'there';
      const doctorName = appt.doctor
        ? `Dr. ${appt.doctor.firstName} ${appt.doctor.lastName}`
        : 'your provider';

      // Straight to this appointment's own page, signed in.
      const appointmentLink = buildAutoLoginLink(
        this.jwtService,
        this.configService,
        appt.patient,
        `/dashboard/care-plan-details/${appt.id}`,
      );

      await this.mailerService.sendAppointmentReminderEmail(
        to,
        patientName,
        doctorName,
        appt.appointmentDate.toISOString().split('T')[0],
        appt.appointmentTime,
        kind,
        appointmentLink,
      );
      this.logger.log(`Sent ${kind} reminder for appointment ${appt.id}`);
    } catch (err) {
      // Release the claim so the next sweep can retry — a mail outage shouldn't
      // silently consume the patient's only reminder.
      await this.prisma.appointment.updateMany({
        where: { id: appt.id },
        data: { [sentField]: null },
      });
      this.logger.error(`Failed ${kind} reminder for appointment ${appt.id}`, err as any);
    }
  }
}
