import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface QuestionnaireAnswers {
  qadam?: number[];
  iief?: number[];
  phq9: number[];
  phq9Difficulty: number;
}

/** Allowed answer range per question, in question order (see the patient form). */
const QADAM_RANGE = Array.from({ length: 10 }, () => [1, 5] as const);
const IIEF_RANGE = [[0, 5], [0, 5], [0, 5], [0, 5], [0, 5], [1, 5]] as const;
const PHQ9_RANGE = Array.from({ length: 9 }, () => [0, 3] as const);

/**
 * qADAM, IIEF (erectile domain) and PHQ-9, answered by the patient before every
 * booking. Stored as integers so the doctor side can sum scores. qADAM and IIEF
 * are male questionnaires; everyone else answers PHQ-9 only.
 */
@Injectable()
export class AppointmentQuestionnaireService {
  constructor(private readonly prisma: PrismaService) {}

  private isMale(gender: string | null | undefined) {
    return /^m(ale)?$/i.test((gender || '').trim());
  }

  /** Which questionnaires this patient answers. */
  async getContext(patientId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: patientId }, select: { gender: true } });
    if (!user) throw new NotFoundException('Patient not found');
    return { includeMaleQuestionnaires: this.isMale(user.gender) };
  }

  async getForAppointment(appointmentId: string, patientId: string) {
    const row = await this.prisma.appointmentQuestionnaire.findUnique({ where: { appointmentId } });
    if (row && row.patientId !== patientId) throw new ForbiddenException('Not your appointment');
    return row;
  }

  async submit(patientId: string, appointmentId: string, answers: QuestionnaireAnswers) {
    const appt = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { patientId: true, patient: { select: { gender: true } } },
    });
    if (!appt) throw new NotFoundException('Appointment not found');
    if (appt.patientId !== patientId) throw new ForbiddenException('Not your appointment');

    const male = this.isMale(appt.patient?.gender);
    const qadam = male ? this.validated('qADAM', answers?.qadam, QADAM_RANGE) : [];
    const iief = male ? this.validated('IIEF', answers?.iief, IIEF_RANGE) : [];
    const phq9 = this.validated('PHQ-9', answers?.phq9, PHQ9_RANGE);
    const [difficulty] = this.validated('PHQ-9 difficulty', [answers?.phq9Difficulty as number], [[0, 3]]);

    const data = { qadam, iief, phq9, phq9Difficulty: difficulty, submittedAt: new Date() };
    return this.prisma.appointmentQuestionnaire.upsert({
      where: { appointmentId },
      create: { appointmentId, patientId, ...data },
      update: data,
    });
  }

  /** Every question answered, each an integer within its scale. */
  private validated(name: string, values: unknown, ranges: readonly (readonly [number, number])[]): number[] {
    if (!Array.isArray(values) || values.length !== ranges.length) {
      throw new BadRequestException(`${name}: please answer all ${ranges.length} questions.`);
    }
    return values.map((v, i) => {
      const [min, max] = ranges[i];
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) {
        throw new BadRequestException(`${name}: answer ${i + 1} must be a whole number from ${min} to ${max}.`);
      }
      return v as number;
    });
  }
}
