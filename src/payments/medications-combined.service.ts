import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LegacyMedicationGroup {
  appointmentId: string;
  medications: string[];
  since: Date | null;
  endedAt: Date | null;
  subscriptionStatus: string | null;
  billing: 'ONE_TIME' | 'SUBSCRIPTION';
  status: 'ACTIVE' | 'PAST';
}

/**
 * Combined active/past medications for a patient:
 *  - "sets": the NEW set-based MedicationOrder model (post-launch flow).
 *  - "legacy": the OLD per-appointment flow, derived from each appointment's
 *    medications JSON + its MedicationPayment subscription status.
 *
 * Both are returned so the UI can keep rendering old records the old way while
 * following the new set-based flow for new records.
 */
@Injectable()
export class MedicationsCombinedService {
  constructor(private readonly prisma: PrismaService) {}

  async getCombined(userId: string) {
    const [orders, legacy] = await Promise.all([
      this.prisma.medicationOrder.findMany({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        include: { items: true },
      }),
      this.getLegacyGroups(userId),
    ]);

    return {
      activeSets: orders.filter((o) => o.status === 'ACTIVE'),
      pastSets: orders.filter((o) => o.status === 'PAST'),
      legacyActive: legacy.filter((l) => l.status === 'ACTIVE'),
      legacyPast: legacy.filter((l) => l.status === 'PAST'),
    };
  }

  // --- OLD flow: per-appointment medications + subscription status -----------
  private async getLegacyGroups(userId: string): Promise<LegacyMedicationGroup[]> {
    const appointments = await this.prisma.appointment.findMany({
      where: { patientId: userId, medications: { not: null as any } },
      select: {
        id: true,
        medications: true,
        medicationPayment: {
          select: {
            status: true,
            paidAt: true,
            subscriptionStatus: true,
            subscriptionCanceledAt: true,
            subscriptionEndDate: true,
            stripeSubscriptionId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const groups: LegacyMedicationGroup[] = [];
    for (const appt of appointments) {
      const pay = appt.medicationPayment;
      // Only reflect medications the patient actually paid for.
      if (!pay || pay.status !== 'SUCCEEDED') continue;

      const meds = this.extractMedicationNames(appt.medications);
      if (!meds.length) continue;

      const isSubscription = !!pay.stripeSubscriptionId;
      const sub = (pay.subscriptionStatus || '').toLowerCase();
      const canceled =
        sub === 'canceled' ||
        sub === 'cancelled' ||
        !!pay.subscriptionCanceledAt ||
        (isSubscription &&
          !!pay.subscriptionEndDate &&
          pay.subscriptionEndDate.getTime() < Date.now());

      groups.push({
        appointmentId: appt.id,
        medications: meds,
        since: pay.paidAt,
        endedAt: canceled ? pay.subscriptionEndDate || pay.subscriptionCanceledAt || null : null,
        subscriptionStatus: pay.subscriptionStatus || (isSubscription ? null : 'one_time'),
        billing: isSubscription ? 'SUBSCRIPTION' : 'ONE_TIME',
        status: canceled ? 'PAST' : 'ACTIVE',
      });
    }
    return groups;
  }

  private extractMedicationNames(medications: any): string[] {
    if (!medications || typeof medications !== 'object') return [];
    const names: string[] = [];
    for (const entries of Object.values(medications)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry === 'string' && entry.trim()) {
          names.push(entry.trim());
        } else if (entry && typeof entry === 'object') {
          const name = entry.name || entry.medicationName || entry.label;
          if (name) {
            const detail = [entry.strength, entry.dose].filter(Boolean).join(' ');
            names.push(detail ? `${name} ${detail}` : name);
          }
        }
      }
    }
    // de-dupe while preserving order
    return Array.from(new Set(names));
  }
}
