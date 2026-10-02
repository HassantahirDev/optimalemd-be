import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIntakeFormDto } from './dto/create-intake-form.dto';
import { MedicalFormService } from '../medical-form/medical-form.service';

@Injectable()
export class IntakeService {
  constructor(
    private prisma: PrismaService,
    private medicalFormService: MedicalFormService,
  ) {}

  async checkIntakeCompletionStatus(patientId: string): Promise<{
    hasCompletedIntake: boolean;
    needsScreen2: boolean;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: {
        hasCompletedIntakeForm: true,
        hasCompletedMedicalForm: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Check if user has any medical forms
    const hasAnyMedicalForm = await this.prisma.medicalForm.findFirst({
      where: { patientId },
    });

    // Check if user has a medical form with Screen 2 data (height, weight, waist)
    const hasScreen2Data = await this.prisma.medicalForm.findFirst({
      where: {
        patientId,
        height: { not: null },
        weight: { not: null },
        waist: { not: null },
      },
    });

    // User needs Screen 2 if they don't have height, weight, waist data in medical form
    const needsScreen2 = !hasScreen2Data;

    // User has completed intake ONLY if they have completed the full tabular form
    // This means they have a medical form AND hasCompletedMedicalForm is true
    const hasCompletedIntake = !!hasAnyMedicalForm && user.hasCompletedMedicalForm;


    return {
      hasCompletedIntake,
      needsScreen2,
    };
  }

  async completeScreen2(patientId: string, screen2Data: {
    height?: string;
    weight?: string;
    waist?: string;
  }): Promise<any> {
    // Validate that all three required fields are provided
    if (!screen2Data.height || !screen2Data.weight || !screen2Data.waist) {
      throw new Error('Height, weight, and waist are all required to complete Screen 2');
    }

    // Create a medical form with Screen 2 data (height, weight, waist)
    // This will be the initial medical form that gets updated later with the full intake
    const medicalForm = await this.prisma.medicalForm.create({
      data: {
        patientId,
        height: screen2Data.height,
        weight: screen2Data.weight,
        waist: screen2Data.waist,
        // Set other required fields to default values
        goalMoreEnergy: false,
        goalBetterSexualPerformance: false,
        goalLoseWeight: false,
        goalHairRestoration: false,
        goalImproveMood: false,
        goalLongevity: false,
        goalOther: false,
        symptomFatigue: false,
        symptomLowLibido: false,
        symptomMuscleLoss: false,
        symptomWeightGain: false,
        symptomGynecomastia: false,
        symptomBrainFog: false,
        symptomMoodSwings: false,
        symptomPoorSleep: false,
        symptomHairThinning: false,
        historyProstateBreastCancer: false,
        historyBloodClotsMIStroke: false,
        currentlyUsingHormonesPeptides: false,
        planningChildrenNext12Months: false,
        labSchedulingNeeded: true,
        consentTelemedicineCare: false,
        consentElectiveOptimizationTreatment: false,
        consentRequiredLabMonitoring: false,
      },
    });

    // Note: We don't update hasCompletedIntakeForm here because that's only for Screen 2 completion
    // The presence of height, weight, waist in medical form indicates Screen 2 completion

    return medicalForm;
  }

  async createIntakeForm(patientId: string, appointmentId: string, intakeData: CreateIntakeFormDto): Promise<any> {
    // Find the existing medical form created during Screen 2 (should be the only one without appointmentId)
    const existingForm = await this.prisma.medicalForm.findFirst({
      where: {
        patientId,
        appointmentId: null, // The form created during Screen 2 doesn't have an appointmentId yet
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (existingForm) {
      // Convert consentDate string to Date object if provided
      const processedData: any = {
        ...intakeData,
        appointmentId,
        // Set labSchedulingNeeded to true by default if not provided
        labSchedulingNeeded: intakeData.labSchedulingNeeded !== undefined ? intakeData.labSchedulingNeeded : true,
      };
      
      if (processedData.consentDate && typeof processedData.consentDate === 'string') {
        processedData.consentDate = new Date(processedData.consentDate);
      }

      // Update the existing medical form with the full intake data and link it to the appointment
      const updatedForm = await this.prisma.medicalForm.update({
        where: { id: existingForm.id },
        data: processedData,
      });

      // Mark that the user has completed the full medical form
      await this.prisma.user.update({
        where: { id: patientId },
        data: {
          hasCompletedMedicalForm: true,
          medicalFormCompletedAt: new Date(),
        },
      });

      // Note: The appointment is already linked to the medical form through the appointmentId field

      return updatedForm;
    } else {
      // If no existing form found, create a new one (fallback)
      // Convert consentDate string to Date object if provided
      const processedData: any = { 
        ...intakeData,
        // Set labSchedulingNeeded to true by default if not provided
        labSchedulingNeeded: intakeData.labSchedulingNeeded !== undefined ? intakeData.labSchedulingNeeded : true,
      };
      if (processedData.consentDate && typeof processedData.consentDate === 'string') {
        processedData.consentDate = new Date(processedData.consentDate);
      }

      const medicalForm = await this.medicalFormService.createMedicalForm(
        patientId,
        appointmentId,
        processedData
      );

      // Mark that the user has completed the full medical form
      await this.prisma.user.update({
        where: { id: patientId },
        data: {
          hasCompletedMedicalForm: true,
          medicalFormCompletedAt: new Date(),
        },
      });

      // Note: The appointment is already linked to the medical form through the appointmentId field

      return medicalForm;
    }
  }

  async copyPreviousMedicalForm(patientId: string, appointmentId: string): Promise<any> {
    // Find the most recent medical form for this patient (regardless of appointment status)
    const previousForm = await this.prisma.medicalForm.findFirst({
      where: {
        patientId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!previousForm) {
      throw new NotFoundException('No previous medical form found to copy');
    }

    // Create a copy of the previous form for the new appointment
    const { id, createdAt, updatedAt, ...formData } = previousForm;
    
    const newForm = await this.prisma.medicalForm.create({
      data: {
        ...formData,
        appointmentId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // Note: The appointment is already linked to the medical form through the appointmentId field

    return newForm;
  }

  async getIntakeFormForAppointment(appointmentId: string): Promise<any> {
    return this.prisma.medicalForm.findUnique({
      where: { appointmentId },
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryEmail: true,
            primaryPhone: true,
            dateOfBirth: true,
            gender: true,
            completeAddress: true,
            city: true,
            state: true,
            zipcode: true,
            emergencyContactName: true,
            emergencyContactPhone: true,
          },
        },
        appointment: {
          select: {
            id: true,
            appointmentDate: true,
            appointmentTime: true,
            status: true,
            service: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });
  }
}
