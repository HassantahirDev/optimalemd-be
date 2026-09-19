import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { ConfigService } from '@nestjs/config';
import { CreateMedicalFormDto, MedicalFormResponseDto } from './dto';

@Injectable()
export class MedicalFormService {
  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService,
    private configService: ConfigService
  ) {}

  async createMedicalForm(patientId: string, appointmentId: string, createMedicalFormDto: CreateMedicalFormDto): Promise<MedicalFormResponseDto> {
    // Check if patient exists
    const patient = await this.prisma.user.findUnique({
      where: { id: patientId }
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    // Check if appointment exists and belongs to patient
    const appointment = await this.prisma.appointment.findFirst({
      where: { 
        id: appointmentId,
        patientId: patientId
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found or does not belong to patient');
    }

    // Check if medical form already exists for this appointment
    const existingForm = await this.prisma.medicalForm.findUnique({
      where: { appointmentId }
    });

    if (existingForm) {
      throw new ConflictException('Medical form already exists for this appointment');
    }

    // Create medical form
    const medicalForm = await this.prisma.medicalForm.create({
      data: {
        patientId,
        appointmentId,
        ...createMedicalFormDto,
        // Set labSchedulingNeeded to true by default if not provided
        labSchedulingNeeded: createMedicalFormDto.labSchedulingNeeded !== undefined ? createMedicalFormDto.labSchedulingNeeded : true,
      }
    });

    // Update user's form completion status
    await this.prisma.user.update({
      where: { id: patientId },
      data: {
        hasCompletedMedicalForm: true,
        medicalFormCompletedAt: new Date()
      }
    });

    return this.mapToResponseDto(medicalForm);
  }

  async getMedicalFormByAppointmentId(appointmentId: string): Promise<MedicalFormResponseDto> {
    const medicalForm = await this.prisma.medicalForm.findUnique({
      where: { appointmentId }
    });

    if (!medicalForm) {
      throw new NotFoundException('Medical form not found for this appointment');
    }

    return this.mapToResponseDto(medicalForm);
  }

  /**
   * Weight/BMI per visit, newest first — one entry per medical form that actually
   * recorded a measurement. Dated by the appointment it belongs to (that's the
   * visit the reading was taken at); forms with no appointment fall back to when
   * the form itself was created. Read-only.
   */
  async getBiometricsHistory(patientId: string) {
    const forms = await this.prisma.medicalForm.findMany({
      where: { patientId },
      select: {
        id: true,
        weight: true,
        height: true,
        waist: true,
        bmi: true,
        createdAt: true,
        updatedAt: true,
        appointment: { select: { id: true, appointmentDate: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const num = (v: string | null | undefined) => {
      if (!v) return null;
      const m = String(v).match(/-?\d+(\.\d+)?/);
      if (!m) return null;
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : null;
    };

    return forms
      .map((f) => ({
        id: f.id,
        appointmentId: f.appointment?.id || null,
        date: (f.appointment?.appointmentDate || f.createdAt).toISOString(),
        weight: num(f.weight),
        weightRaw: f.weight || null,
        bmi: num(f.bmi),
        height: f.height || null,
        waist: num(f.waist),
      }))
      // A form with neither reading contributes no column to the history table.
      .filter((e) => e.weight !== null || e.bmi !== null || e.waist !== null)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async getMedicalFormByPatientId(patientId: string): Promise<MedicalFormResponseDto> {
    const medicalForm = await this.prisma.medicalForm.findFirst({
      where: { patientId },
      orderBy: { createdAt: 'desc' }
    });

    if (!medicalForm) {
      throw new NotFoundException('Medical form not found for this patient');
    }

    return this.mapToResponseDto(medicalForm);
  }

  async updateMedicalForm(appointmentId: string, updateData: Partial<CreateMedicalFormDto>): Promise<MedicalFormResponseDto> {
    const existingForm = await this.prisma.medicalForm.findUnique({
      where: { appointmentId }
    });

    if (!existingForm) {
      throw new NotFoundException('Medical form not found for this appointment');
    }

    // Set labSchedulingNeeded to true by default if not provided
    const processedUpdateData = {
      ...updateData,
      labSchedulingNeeded: updateData.labSchedulingNeeded !== undefined ? updateData.labSchedulingNeeded : true,
    };

    const updatedForm = await this.prisma.medicalForm.update({
      where: { appointmentId },
      data: processedUpdateData
    });

    return this.mapToResponseDto(updatedForm);
  }

  async updateMedicalFormByPatientId(patientId: string, updateData: Partial<CreateMedicalFormDto>): Promise<MedicalFormResponseDto> {
    const processedUpdateData = this.processMedicalFormWriteData(updateData);

    const count = await this.prisma.medicalForm.count({ where: { patientId } });

    if (count === 0) {
      const medicalForm = await this.prisma.medicalForm.create({
        data: {
          patientId,
          ...processedUpdateData,
        },
      });

      await this.prisma.user.update({
        where: { id: patientId },
        data: {
          hasCompletedMedicalForm: true,
          medicalFormCompletedAt: new Date(),
        },
      });

      return this.mapToResponseDto(medicalForm);
    }

    await this.prisma.medicalForm.updateMany({
      where: { patientId },
      data: processedUpdateData,
    });

    const updatedForm = await this.prisma.medicalForm.findFirst({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
    });

    return this.mapToResponseDto(updatedForm!);
  }

  private processMedicalFormWriteData(updateData: Partial<CreateMedicalFormDto>) {
    const processed: Record<string, unknown> = {
      ...updateData,
      labSchedulingNeeded:
        updateData.labSchedulingNeeded !== undefined
          ? updateData.labSchedulingNeeded
          : true,
    };

    if (updateData.consentDate) {
      processed.consentDate = new Date(updateData.consentDate as string);
    }

    return processed;
  }

  async updateMedicalFormByAppointmentId(appointmentId: string, updateData: Partial<CreateMedicalFormDto>): Promise<MedicalFormResponseDto> {
    // This method is an alias for updateMedicalForm to match the controller method name
    return this.updateMedicalForm(appointmentId, updateData);
  }

  async deleteMedicalForm(appointmentId: string): Promise<void> {
    const existingForm = await this.prisma.medicalForm.findUnique({
      where: { appointmentId }
    });

    if (!existingForm) {
      throw new NotFoundException('Medical form not found for this appointment');
    }

    await this.prisma.medicalForm.delete({
      where: { appointmentId }
    });
  }

  async checkFormCompletion(patientId: string): Promise<{ hasCompletedForm: boolean; completedAt?: Date }> {
    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: {
        hasCompletedMedicalForm: true,
        medicalFormCompletedAt: true
      }
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    return {
      hasCompletedForm: patient.hasCompletedMedicalForm,
      completedAt: patient.medicalFormCompletedAt || undefined
    };
  }

  private mapToResponseDto(medicalForm: any): any {
    return {
      id: medicalForm.id,
      patientId: medicalForm.patientId,
      appointmentId: medicalForm.appointmentId,
      
      // Screen 2 - About You
      height: medicalForm.height,
      weight: medicalForm.weight,
      waist: medicalForm.waist,
      emergencyContactName: medicalForm.emergencyContactName,
      emergencyContactPhone: medicalForm.emergencyContactPhone,
      
      // Screen 3 - Your Goals
      goalMoreEnergy: medicalForm.goalMoreEnergy,
      goalBetterSexualPerformance: medicalForm.goalBetterSexualPerformance,
      goalLoseWeight: medicalForm.goalLoseWeight,
      goalHairRestoration: medicalForm.goalHairRestoration,
      goalImproveMood: medicalForm.goalImproveMood,
      goalLongevity: medicalForm.goalLongevity,
      goalOther: medicalForm.goalOther,
      goalOtherDescription: medicalForm.goalOtherDescription,
      
      // Screen 4 - Medical Background
      chronicConditions: medicalForm.chronicConditions,
      pastSurgeriesHospitalizations: medicalForm.pastSurgeriesHospitalizations,
      currentMedications: medicalForm.currentMedications,
      familyHistory: medicalForm.familyHistory,
      allergies: medicalForm.allergies,
      
      // Screen 5 - Lifestyle & Habits
      sleepHoursPerNight: medicalForm.sleepHoursPerNight,
      sleepQuality: medicalForm.sleepQuality,
      exerciseFrequency: medicalForm.exerciseFrequency,
      dietType: medicalForm.dietType,
      alcoholUse: medicalForm.alcoholUse,
      alcoholDaysPerWeek: medicalForm.alcoholDaysPerWeek,
      alcoholDrinksPerDay: medicalForm.alcoholDrinksPerDay,
      alcoholUseExplanation: medicalForm.alcoholUseExplanation,
      tobaccoUse: medicalForm.tobaccoUse,
      tobaccoProductTypes: medicalForm.tobaccoProductTypes,
      tobaccoCigaretteFrequency: medicalForm.tobaccoCigaretteFrequency,
      tobaccoNonCigaretteFrequency: medicalForm.tobaccoNonCigaretteFrequency,
      tobaccoUseExplanation: medicalForm.tobaccoUseExplanation,
      cannabisOtherSubstances: medicalForm.cannabisOtherSubstances,
      cannabisOtherSubstancesList: medicalForm.cannabisOtherSubstancesList,
      stressLevel: medicalForm.stressLevel,

      // Personal & Family
      maritalStatus: medicalForm.maritalStatus,
      hasChildren: medicalForm.hasChildren,
      childrenCountAndAges: medicalForm.childrenCountAndAges,
      wantsFutureChildren: medicalForm.wantsFutureChildren,

      // Work Info
      jobOccupation: medicalForm.jobOccupation,
      workHoursPerWeek: medicalForm.workHoursPerWeek,

      // Screen 6 - Symptom Check
      symptomFatigue: medicalForm.symptomFatigue,
      symptomLowLibido: medicalForm.symptomLowLibido,
      symptomMuscleLoss: medicalForm.symptomMuscleLoss,
      symptomWeightGain: medicalForm.symptomWeightGain,
      symptomGynecomastia: medicalForm.symptomGynecomastia,
      symptomBrainFog: medicalForm.symptomBrainFog,
      symptomMoodSwings: medicalForm.symptomMoodSwings,
      symptomPoorSleep: medicalForm.symptomPoorSleep,
      symptomHairThinning: medicalForm.symptomHairThinning,
      
      // Screen 7 - Safety Check
      historyProstateBreastCancer: medicalForm.historyProstateBreastCancer,
      historyProstateBreastCancerExplanation: medicalForm.historyProstateBreastCancerExplanation,
      historyBloodClotsMIStroke: medicalForm.historyBloodClotsMIStroke,
      historyBloodClotsMIStrokeExplanation: medicalForm.historyBloodClotsMIStrokeExplanation,
      currentlyUsingHormonesPeptides: medicalForm.currentlyUsingHormonesPeptides,
      currentlyUsingHormonesPeptidesExplanation: medicalForm.currentlyUsingHormonesPeptidesExplanation,
      planningChildrenNext12Months: medicalForm.planningChildrenNext12Months,
      planningChildrenNext12MonthsExplanation: medicalForm.planningChildrenNext12MonthsExplanation,
      
      // Screen 8 - Labs & Uploads
      labUploads: medicalForm.labUploads,
      labSchedulingNeeded: medicalForm.labSchedulingNeeded,
      
      // Screen 9 - Consent & Finalize
      consentTelemedicineCare: medicalForm.consentTelemedicineCare,
      consentElectiveOptimizationTreatment: medicalForm.consentElectiveOptimizationTreatment,
      consentRequiredLabMonitoring: medicalForm.consentRequiredLabMonitoring,
      digitalSignature: medicalForm.digitalSignature,
      consentDate: medicalForm.consentDate,
      
      // Legacy fields (kept for backward compatibility)
      chiefComplaint: medicalForm.chiefComplaint,
      historyOfPresentIllness: medicalForm.historyOfPresentIllness,
      pastMedicalHistory: medicalForm.pastMedicalHistory,
      pastSurgicalHistory: medicalForm.pastSurgicalHistory,
      recreationalDrugs: medicalForm.recreationalDrugs,
      otherSocialHistory: medicalForm.otherSocialHistory,
      workHistory: medicalForm.workHistory,
      medications: medicalForm.medications,
      generalSymptoms: medicalForm.generalSymptoms,
      cardiovascularSymptoms: medicalForm.cardiovascularSymptoms,
      respiratorySymptoms: medicalForm.respiratorySymptoms,
      gastrointestinalSymptoms: medicalForm.gastrointestinalSymptoms,
      genitourinarySymptoms: medicalForm.genitourinarySymptoms,
      neurologicalSymptoms: medicalForm.neurologicalSymptoms,
      musculoskeletalSymptoms: medicalForm.musculoskeletalSymptoms,
      skinSymptoms: medicalForm.skinSymptoms,
      psychiatricSymptoms: medicalForm.psychiatricSymptoms,
      endocrineSymptoms: medicalForm.endocrineSymptoms,
      otherSymptoms: medicalForm.otherSymptoms,
      bloodPressure: medicalForm.bloodPressure,
      heartRate: medicalForm.heartRate,
      respiratoryRate: medicalForm.respiratoryRate,
      temperature: medicalForm.temperature,
      oxygenSaturation: medicalForm.oxygenSaturation,
      bmi: medicalForm.bmi,
      generalExam: medicalForm.generalExam,
      heentExam: medicalForm.heentExam,
      chestLungsExam: medicalForm.chestLungsExam,
      heartExam: medicalForm.heartExam,
      abdomenExam: medicalForm.abdomenExam,
      neurologicalExam: medicalForm.neurologicalExam,
      musculoskeletalExam: medicalForm.musculoskeletalExam,
      investigationsLabs: medicalForm.investigationsLabs,
      assessmentDiagnosis: medicalForm.assessmentDiagnosis,
      planTreatment: medicalForm.planTreatment,
      referrals: medicalForm.referrals,
      additionalNotes: medicalForm.additionalNotes,
      clinician: medicalForm.clinician,
      pharmacy: medicalForm.pharmacy,
      insurance: medicalForm.insurance,
      primaryCareProvider: medicalForm.primaryCareProvider,
      referringPhysicians: medicalForm.referringPhysicians,
      createdAt: medicalForm.createdAt,
      updatedAt: medicalForm.updatedAt
    };
  }

  async resendMedicalFormEmail(email: string, name: string): Promise<void> {
    // Check if patient exists
    const patient = await this.prisma.user.findUnique({
      where: { primaryEmail: email }
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    // Send medical form email
    const formLink = `${this.configService.get<string>('frontend.url')}/form`;
    await this.mailerService.sendMedicalFormEmail(email, name, formLink);
  }
}
