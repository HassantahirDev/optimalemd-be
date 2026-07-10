import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { MailerService } from '../mailer/mailer.service';
import { ReferralService } from '../referral/referral.service';
import { PaymentLedgerService } from '../payments/payment-ledger.service';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { generateNextPatientId } from '../common/utils/patient-id.utils';
import {
  CreateWelcomeOrderDto,
  UpdateSignupStepDto,
  SignupProgressResponseDto,
  ResumeSignupResponseDto,
  WelcomeOrderStatus,
  PaymentStatus
} from './dto/new-signup.dto';

@Injectable()
export class NewSignupService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailerService: MailerService,
    private referralService: ReferralService,
    private paymentLedger: PaymentLedgerService,
  ) {}

  // Generate unique order number
  private generateOrderNumber(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `WO-${timestamp}-${random}`;
  }

  // Normalize phone number: remove spaces, dashes, parentheses after country code
  private normalizePhoneNumber(phone: string | undefined): string | undefined {
    if (!phone || phone.trim() === '+1' || phone.trim() === '') {
      return phone ? phone.trim() : undefined;
    }
    // Remove all spaces, dashes, and parentheses
    return phone.replace(/[\s\-\(\)]/g, '');
  }

  // Check if email already exists and if there's an incomplete signup
  async checkEmailExists(email: string): Promise<{ exists: boolean; hasIncompleteSignup: boolean; welcomeOrderId?: string; isActive?: boolean }> {
    if (!email) {
      return { exists: false, hasIncompleteSignup: false };
    }

    // Normalize email to lowercase for case-insensitive matching
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists and get their active status
    const existingUser = await this.prisma.user.findUnique({
      where: { primaryEmail: normalizedEmail },
      select: { id: true, isActive: true },
    });

    const userExists = !!existingUser;
    
    // If user exists but is inactive, prevent signup
    if (userExists && existingUser && !existingUser.isActive) {
      return {
        exists: true,
        hasIncompleteSignup: false,
        isActive: false,
      };
    }

    // Check for incomplete welcome orders (either by email or userId if user exists)
    // A welcome order is incomplete if:
    // 1. isCompleted is false, OR
    // 2. isCompleted is true but signup isn't truly complete (all steps not done)
    // We check for welcome orders regardless of status - status doesn't matter for incomplete detection
    const allWelcomeOrders = await this.prisma.welcomeOrder.findMany({
      where: {
        OR: [
          { email: normalizedEmail },
          ...(userExists ? [{ userId: existingUser.id }] : []),
        ],
      },
      include: {
        signupSteps: {
          orderBy: [
            { stepNumber: 'asc' },
            { subStepNumber: 'asc' },
          ],
        },
      },
      orderBy: {
        createdAt: 'desc', // Get the most recent one first
      },
    });

    // Find incomplete welcome order - either explicitly incomplete or incorrectly marked as complete
    let incompleteWelcomeOrder: { id: string; email: string; userId: string | null } | null = null;
    for (const order of allWelcomeOrders) {
      // If explicitly marked as incomplete, it's incomplete
      if (!order.isCompleted) {
        incompleteWelcomeOrder = {
          id: order.id,
          email: order.email,
          userId: order.userId,
        };
        break;
      }
      
      // Check if it's incorrectly marked as complete
      // Signup is truly complete only if all required steps are done:
      // - Step 0 (Gender)
      // - Step 1 (Basic Info) 
      // - Step 2 (Checkout/Payment) - paymentStatus should be SUCCEEDED
      // - Step 3 (Password) - user should exist (userId should be set)
      // - Step 4 (Details) - all 3 sub-steps should be done (0: BMI, 1: Medical, 2: Consent)
      
      const hasGender = order.signupSteps.some(s => s.stepNumber === 0 && s.isCompleted);
      const hasBasicInfo = order.signupSteps.some(s => s.stepNumber === 1 && s.isCompleted);
      const hasPayment = order.paymentStatus === 'SUCCEEDED';
      const hasPassword = !!order.userId; // User created means password step is done
      const hasAllDetails = order.signupSteps.some(s => s.stepNumber === 4 && s.subStepNumber === 0 && s.isCompleted) && // BMI
                            order.signupSteps.some(s => s.stepNumber === 4 && s.subStepNumber === 1 && s.isCompleted) && // Medical
                            order.signupSteps.some(s => s.stepNumber === 4 && s.subStepNumber === 2 && s.isCompleted); // Consent
      
      const isTrulyComplete = hasGender && hasBasicInfo && hasPayment && hasPassword && hasAllDetails;
      
      // If marked as completed but not truly complete, treat as incomplete
      if (!isTrulyComplete) {
        incompleteWelcomeOrder = {
          id: order.id,
          email: order.email,
          userId: order.userId,
        };
        break;
      }
    }

    return {
      exists: userExists,
      hasIncompleteSignup: !!incompleteWelcomeOrder,
      welcomeOrderId: incompleteWelcomeOrder?.id,
      isActive: userExists ? (existingUser?.isActive ?? true) : undefined,
    };
  }

  // Create a new welcome order
  async createWelcomeOrder(createDto: CreateWelcomeOrderDto) {
    const orderNumber = this.generateOrderNumber();
    
    const welcomeOrder = await this.prisma.welcomeOrder.create({
      data: {
        email: createDto.email,
        orderNumber,
        totalAmount: createDto.totalAmount,
        discountAmount: createDto.discountAmount,
        finalAmount: createDto.finalAmount,
        status: WelcomeOrderStatus.PENDING,
        currentStep: 0,
        currentSubStep: 0,
        ...(createDto.userId && { userId: createDto.userId }),
      },
      include: {
        signupSteps: true,
      },
    });

    return welcomeOrder;
  }

  // Update signup step
  async updateSignupStep(welcomeOrderId: string, updateDto: UpdateSignupStepDto) {
    // Check if welcome order exists
    const welcomeOrder = await this.prisma.welcomeOrder.findUnique({
      where: { id: welcomeOrderId },
    });

    if (!welcomeOrder) {
      throw new NotFoundException('Welcome order not found');
    }

    // Update or create signup step
    const signupStep = await this.prisma.signupStep.upsert({
      where: {
        welcomeOrderId_stepNumber_subStepNumber: {
          welcomeOrderId,
          stepNumber: updateDto.stepNumber,
          subStepNumber: updateDto.subStepNumber || 0,
        },
      },
      update: {
        stepName: updateDto.stepName,
        subStepName: updateDto.subStepName,
        stepData: updateDto.stepData,
        isCompleted: updateDto.isCompleted || false,
        isValid: updateDto.isValid || false,
        validationErrors: updateDto.validationErrors,
        completedAt: updateDto.isCompleted ? new Date() : null,
        updatedAt: new Date(),
      },
      create: {
        welcomeOrderId,
        stepNumber: updateDto.stepNumber,
        stepName: updateDto.stepName,
        subStepNumber: updateDto.subStepNumber,
        subStepName: updateDto.subStepName,
        stepData: updateDto.stepData,
        isCompleted: updateDto.isCompleted || false,
        isValid: updateDto.isValid || false,
        validationErrors: updateDto.validationErrors,
        completedAt: updateDto.isCompleted ? new Date() : null,
      },
    });

    // Update welcome order progress - don't mark as completed until all steps are done
    // Only mark as completed when explicitly called via completeSignup, not when updating individual steps
    await this.prisma.welcomeOrder.update({
      where: { id: welcomeOrderId },
      data: {
        currentStep: updateDto.stepNumber,
        currentSubStep: updateDto.subStepNumber || 0,
        // Only update status if not already completed - keep IN_PROGRESS for incomplete signups
        status: welcomeOrder.isCompleted 
          ? WelcomeOrderStatus.COMPLETED 
          : WelcomeOrderStatus.IN_PROGRESS,
        // Never set isCompleted to true here - only in completeSignup method
        // isCompleted remains false until explicitly completed via completeSignup
      },
    });

    return signupStep;
  }

  // Get signup progress
  async getSignupProgress(welcomeOrderId: string): Promise<SignupProgressResponseDto> {
    const welcomeOrder = await this.prisma.welcomeOrder.findUnique({
      where: { id: welcomeOrderId },
      include: {
        signupSteps: {
          orderBy: [
            { stepNumber: 'asc' },
            { subStepNumber: 'asc' },
          ],
        },
      },
    });

    if (!welcomeOrder) {
      throw new NotFoundException('Welcome order not found');
    }

    return {
      welcomeOrderId: welcomeOrder.id,
      email: welcomeOrder.email,
      currentStep: welcomeOrder.currentStep,
      currentSubStep: welcomeOrder.currentSubStep,
      isCompleted: welcomeOrder.isCompleted,
      paymentStatus: welcomeOrder.paymentStatus as PaymentStatus, // Include payment status for step skipping logic
      paymentIntentId: welcomeOrder.paymentIntentId || undefined, // Include payment intent ID (convert null to undefined)
      userId: welcomeOrder.userId || undefined, // Include userId to check if user already exists
      steps: welcomeOrder.signupSteps.map(step => ({
        stepNumber: step.stepNumber,
        stepName: step.stepName,
        subStepNumber: step.subStepNumber || undefined,
        subStepName: step.subStepName || undefined,
        stepData: step.stepData || undefined, // Include stepData for loading form
        isCompleted: step.isCompleted,
        isValid: step.isValid,
        completedAt: step.completedAt || undefined,
      })),
    };
  }

  // Resume signup by email (also checks by userId if user exists)
  async resumeSignupByEmail(email: string): Promise<ResumeSignupResponseDto> {
    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();
    
    // First check if user exists - if so, also search by userId
    const existingUser = await this.prisma.user.findUnique({
      where: { primaryEmail: normalizedEmail },
      select: { id: true },
    });

    // Find incomplete welcome order by email OR userId (if user exists)
    const welcomeOrder = await this.prisma.welcomeOrder.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          ...(existingUser ? [{ userId: existingUser.id }] : []),
        ],
        isCompleted: false,
        status: {
          in: [WelcomeOrderStatus.PENDING, WelcomeOrderStatus.IN_PROGRESS],
        },
      },
      include: {
        signupSteps: {
          where: {
            stepNumber: {
              lte: 4, // Only include steps 0-4
            },
          },
          orderBy: [
            { stepNumber: 'asc' },
            { subStepNumber: 'asc' },
          ],
        },
      },
      orderBy: {
        createdAt: 'desc', // Get the most recent one
      },
    });

    if (!welcomeOrder) {
      throw new NotFoundException('No incomplete signup found for this email');
    }

    // Get the current step data
    const currentStep = welcomeOrder.signupSteps.find(
      step => step.stepNumber === welcomeOrder.currentStep && 
              step.subStepNumber === welcomeOrder.currentSubStep
    );

    return {
      welcomeOrderId: welcomeOrder.id,
      email: welcomeOrder.email,
      currentStep: welcomeOrder.currentStep,
      currentSubStep: welcomeOrder.currentSubStep,
      stepData: currentStep?.stepData || {},
      canResume: true,
    };
  }

  // Complete the signup process and create or update user
  async completeSignup(welcomeOrderId: string, userData: any) {
    const welcomeOrder = await this.prisma.welcomeOrder.findUnique({
      where: { id: welcomeOrderId },
      include: {
        signupSteps: {
          orderBy: [
            { stepNumber: 'asc' },
            { subStepNumber: 'asc' },
          ],
        },
        user: true,
      },
    });

    if (!welcomeOrder) {
      throw new NotFoundException('Welcome order not found');
    }

    if (welcomeOrder.isCompleted) {
      throw new BadRequestException('Signup already completed');
    }

    // Collect data from signup steps (especially step 4 which has dateOfBirth, address, phone)
    let mergedUserData: any = { ...userData };
    
    // Merge data from signup steps
    welcomeOrder.signupSteps.forEach(step => {
      if (step.stepData && typeof step.stepData === 'object') {
        const stepData = step.stepData as any;
        
        // Step 4 contains dateOfBirth, completeAddress, city, zipcode, primaryPhone, etc.
        if (step.stepNumber === 4) {
          if (stepData.dateOfBirth) mergedUserData.dateOfBirth = stepData.dateOfBirth;
          if (stepData.completeAddress) mergedUserData.completeAddress = stepData.completeAddress;
          if (stepData.city) mergedUserData.city = stepData.city;
          if (stepData.zipcode) mergedUserData.zipcode = stepData.zipcode;
          if (stepData.primaryPhone) mergedUserData.primaryPhone = stepData.primaryPhone;
          if (stepData.alternativePhone) mergedUserData.alternativePhone = stepData.alternativePhone;
        }
        
        // Merge all other step data
        Object.keys(stepData).forEach(key => {
          if (stepData[key] !== undefined && stepData[key] !== null && stepData[key] !== '') {
            mergedUserData[key] = stepData[key];
          }
        });
      }
    });

    // Check if user already exists (from Step3Password)
    let user;
    if (welcomeOrder.userId) {
      // User already exists, update it
      const updateData: any = {};
      
      if (mergedUserData.firstName) updateData.firstName = mergedUserData.firstName;
      if (mergedUserData.lastName) updateData.lastName = mergedUserData.lastName;
      if (mergedUserData.gender) updateData.gender = mergedUserData.gender;
      if (mergedUserData.state) updateData.state = mergedUserData.state;
      
      // Handle dateOfBirth
      if (mergedUserData.dateOfBirth) {
        const dateValue = mergedUserData.dateOfBirth;
        if (typeof dateValue === 'string') {
          const date = new Date(dateValue);
          if (!isNaN(date.getTime())) {
            updateData.dateOfBirth = date;
          }
        } else if (dateValue instanceof Date) {
          updateData.dateOfBirth = dateValue;
        }
      }
      
      if (mergedUserData.completeAddress) updateData.completeAddress = mergedUserData.completeAddress;
      if (mergedUserData.city) updateData.city = mergedUserData.city;
      if (mergedUserData.zipcode) updateData.zipcode = mergedUserData.zipcode;
      if (mergedUserData.primaryPhone) {
        const normalizedPhone = this.normalizePhoneNumber(mergedUserData.primaryPhone);
        updateData.primaryPhone = normalizedPhone;
        updateData.phone = normalizedPhone;
      }
      if (mergedUserData.alternativePhone) updateData.alternativePhone = this.normalizePhoneNumber(mergedUserData.alternativePhone);
      if (mergedUserData.emergencyContactName) updateData.emergencyContactName = mergedUserData.emergencyContactName;
      if (mergedUserData.emergencyContactRelationship) updateData.emergencyContactRelationship = mergedUserData.emergencyContactRelationship;
      if (mergedUserData.emergencyContactPhone) updateData.emergencyContactPhone = this.normalizePhoneNumber(mergedUserData.emergencyContactPhone);
      if (mergedUserData.referringSource) updateData.referringSource = mergedUserData.referringSource;
      if (mergedUserData.preferredMethodOfCommunication) updateData.preferredMethodOfCommunication = mergedUserData.preferredMethodOfCommunication;
      if (mergedUserData.disabilityAccessibilityNeeds) updateData.disabilityAccessibilityNeeds = mergedUserData.disabilityAccessibilityNeeds;
      
      // Handle consents
      if (mergedUserData.consentForTreatment !== undefined) {
        updateData.consentForTreatment = mergedUserData.consentForTreatment ? 'Y' : 'N';
      }
      if (mergedUserData.hipaaPrivacyNoticeAcknowledgment !== undefined) {
        updateData.hipaaPrivacyNoticeAcknowledgment = mergedUserData.hipaaPrivacyNoticeAcknowledgment ? 'Y' : 'N';
      }
      if (mergedUserData.releaseOfMedicalRecordsConsent !== undefined) {
        updateData.releaseOfMedicalRecordsConsent = mergedUserData.releaseOfMedicalRecordsConsent ? 'Y' : 'N';
      }
      
      // Update legacy fields
      if (mergedUserData.email) {
        updateData.email = mergedUserData.email;
        updateData.primaryEmail = mergedUserData.email;
      }
      if (mergedUserData.primaryPhone) {
        const normalizedPhone = this.normalizePhoneNumber(mergedUserData.primaryPhone);
        updateData.phone = normalizedPhone;
        updateData.primaryPhone = normalizedPhone;
      }
      
      updateData.hasCompletedIntakeForm = true;
      updateData.intakeFormCompletedAt = new Date();

      user = await this.prisma.user.update({
        where: { id: welcomeOrder.userId },
        data: updateData,
      });
      
      console.log('✅ Updated existing user with all collected data:', user.id);
    } else {
      // User doesn't exist, create it
      const createData: any = {
        firstName: mergedUserData.firstName || userData.firstName,
        lastName: mergedUserData.lastName || userData.lastName,
        email: mergedUserData.email || userData.email,
        primaryEmail: mergedUserData.email || userData.email,
        password: mergedUserData.password || userData.password,
        gender: mergedUserData.gender || userData.gender,
        state: mergedUserData.state || userData.state,
        isEmailVerified: false,
        hasCompletedIntakeForm: true,
        intakeFormCompletedAt: new Date(),
      };
      
      // Handle dateOfBirth
      if (mergedUserData.dateOfBirth) {
        const dateValue = mergedUserData.dateOfBirth;
        if (typeof dateValue === 'string') {
          const date = new Date(dateValue);
          if (!isNaN(date.getTime())) {
            createData.dateOfBirth = date;
          }
        } else if (dateValue instanceof Date) {
          createData.dateOfBirth = dateValue;
        }
      }
      
      if (mergedUserData.completeAddress) createData.completeAddress = mergedUserData.completeAddress;
      if (mergedUserData.city) createData.city = mergedUserData.city;
      if (mergedUserData.zipcode) createData.zipcode = mergedUserData.zipcode;
      if (mergedUserData.primaryPhone) {
        const normalizedPhone = this.normalizePhoneNumber(mergedUserData.primaryPhone);
        createData.primaryPhone = normalizedPhone;
        createData.phone = normalizedPhone;
      }
      if (mergedUserData.alternativePhone) createData.alternativePhone = this.normalizePhoneNumber(mergedUserData.alternativePhone);
      if (mergedUserData.emergencyContactName) createData.emergencyContactName = mergedUserData.emergencyContactName;
      if (mergedUserData.emergencyContactRelationship) createData.emergencyContactRelationship = mergedUserData.emergencyContactRelationship;
      if (mergedUserData.emergencyContactPhone) createData.emergencyContactPhone = this.normalizePhoneNumber(mergedUserData.emergencyContactPhone);
      if (mergedUserData.referringSource) createData.referringSource = mergedUserData.referringSource;
      if (mergedUserData.preferredMethodOfCommunication) createData.preferredMethodOfCommunication = mergedUserData.preferredMethodOfCommunication;
      if (mergedUserData.disabilityAccessibilityNeeds) createData.disabilityAccessibilityNeeds = mergedUserData.disabilityAccessibilityNeeds;
      
      // Handle consents
      if (mergedUserData.consentForTreatment !== undefined) {
        createData.consentForTreatment = mergedUserData.consentForTreatment ? 'Y' : 'N';
      }
      if (mergedUserData.hipaaPrivacyNoticeAcknowledgment !== undefined) {
        createData.hipaaPrivacyNoticeAcknowledgment = mergedUserData.hipaaPrivacyNoticeAcknowledgment ? 'Y' : 'N';
      }
      if (mergedUserData.releaseOfMedicalRecordsConsent !== undefined) {
        createData.releaseOfMedicalRecordsConsent = mergedUserData.releaseOfMedicalRecordsConsent ? 'Y' : 'N';
      }

      user = await this.prisma.user.create({
        data: createData,
      });
      
      console.log('✅ Created new user with all collected data:', user.id);
    }

    // Update welcome order with user ID and mark as completed
    await this.prisma.welcomeOrder.update({
      where: { id: welcomeOrderId },
      data: {
        userId: user.id,
        status: WelcomeOrderStatus.COMPLETED,
        isCompleted: true,
        completedAt: new Date(),
      },
    });

    // Update all signup steps with user ID
    await this.prisma.signupStep.updateMany({
      where: { welcomeOrderId },
      data: { userId: user.id },
    });

    return {
      user,
      welcomeOrder: {
        ...welcomeOrder,
        userId: user.id,
        status: WelcomeOrderStatus.COMPLETED,
        isCompleted: true,
        completedAt: new Date(),
      },
    };
  }

  // Get welcome order by ID
  async getWelcomeOrder(welcomeOrderId: string) {
    const welcomeOrder = await this.prisma.welcomeOrder.findUnique({
      where: { id: welcomeOrderId },
      include: {
        signupSteps: {
          orderBy: [
            { stepNumber: 'asc' },
            { subStepNumber: 'asc' },
          ],
        },
        user: true,
      },
    });

    if (!welcomeOrder) {
      throw new NotFoundException('Welcome order not found');
    }

    return welcomeOrder;
  }

  // Update payment status
  async updatePaymentStatus(welcomeOrderId: string, paymentIntentId: string, status: PaymentStatus) {
    // Fetch welcome order with signup steps to get user info
    const existingOrder = await this.prisma.welcomeOrder.findUnique({
      where: { id: welcomeOrderId },
      include: {
        signupSteps: {
          orderBy: [
            { stepNumber: 'asc' },
            { subStepNumber: 'asc' },
          ],
        },
      },
    });

    if (!existingOrder) {
      throw new NotFoundException('Welcome order not found');
    }

    const welcomeOrder = await this.prisma.welcomeOrder.update({
      where: { id: welcomeOrderId },
      data: {
        paymentIntentId,
        paymentStatus: status,
        paidAt: status === PaymentStatus.SUCCEEDED ? new Date() : null,
        // Update order status when payment succeeds
        status: status === PaymentStatus.SUCCEEDED ? WelcomeOrderStatus.IN_PROGRESS : WelcomeOrderStatus.PENDING,
      },
    });

    // --- Dual-write signup payment into the unified ledger (additive; Part A) ---
    // welcomeOrder logic above is untouched. Runs only on success.
    if (status === PaymentStatus.SUCCEEDED) {
      await this.paymentLedger.upsertFromStripe({
        stripePaymentIntentId: paymentIntentId,
        userId: welcomeOrder.userId ?? null,
        welcomeOrderId: welcomeOrder.id,
        channel: 'PLATFORM',
        category: 'SIGNUP',
        billing: 'ONE_TIME',
        amount: Number(welcomeOrder.finalAmount),
        currency: 'usd',
        status: 'SUCCEEDED',
        paidAt: welcomeOrder.paidAt ?? new Date(),
        note: `Signup order ${welcomeOrder.orderNumber}`,
      });
    }

    // Send payment confirmation email if payment succeeded
    if (status === PaymentStatus.SUCCEEDED) {
      try {
        // Get firstName and lastName from signup steps (step 1 - Basic Info)
        let firstName = '';
        let lastName = '';
        const basicInfoStep = existingOrder.signupSteps.find(step => step.stepNumber === 1);
        if (basicInfoStep && basicInfoStep.stepData) {
          const stepData = basicInfoStep.stepData as any;
          firstName = stepData.firstName || '';
          lastName = stepData.lastName || '';
        }

        const name = `${firstName} ${lastName}`.trim() || 'Valued Customer';
        const amount = Number(welcomeOrder.finalAmount);

        await this.mailerService.sendPaymentConfirmationEmail(
          welcomeOrder.email,
          name,
          amount,
          welcomeOrder.orderNumber
        );
        console.log(`✅ Payment confirmation email sent to ${welcomeOrder.email}`);
      } catch (emailError: any) {
        console.error('Failed to send payment confirmation email:', emailError);
        // Don't throw - payment is already confirmed, email failure shouldn't block the response
      }
    }

    return welcomeOrder;
  }

  // Get welcome order status by user ID
  async getWelcomeOrderStatusByUserId(userId: string) {
    const welcomeOrder = await this.prisma.welcomeOrder.findFirst({
      where: { 
        userId,
        status: WelcomeOrderStatus.IN_PROGRESS
      },
      include: {
        signupSteps: {
          orderBy: [
            { stepNumber: 'asc' },
            { subStepNumber: 'asc' },
          ],
        },
      },
    });

    return welcomeOrder;
  }

  // Complete welcome order (mark as COMPLETED)
  async completeWelcomeOrder(welcomeOrderId: string) {
    const welcomeOrder = await this.prisma.welcomeOrder.update({
      where: { id: welcomeOrderId },
      data: {
        status: WelcomeOrderStatus.COMPLETED,
        isCompleted: true,
        completedAt: new Date(),
      },
    });

    return welcomeOrder;
  }

  // Update user medical form completion status
  async updateUserMedicalFormCompletion(userId: string) {
    const currentTime = new Date();
    
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        hasCompletedMedicalForm: true,
        medicalFormCompletedAt: currentTime,
        hasCompletedIntakeForm: true,
        intakeFormCompletedAt: currentTime,
      },
    });

    return user;
  }

  // Create user step by step (for basic info step)
  async createUserStepByStep(userData: any) {
    try {
      console.log('Creating user step by step with data:', userData);

      // Convert email to lowercase for case-insensitive matching
      const normalizedEmail = userData.primaryEmail.toLowerCase();

      // Check if user already exists by primary email
      const existingUserByEmail = await this.prisma.user.findUnique({
        where: { primaryEmail: normalizedEmail },
      });

      if (existingUserByEmail) {
        throw new BadRequestException('An account with this email address already exists. Please use a different email or try logging in instead.');
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(userData.password, 12);

      // Generate patient ID
      const patientId = await generateNextPatientId(this.prisma);

      // Create user with only the provided fields
      const user = await this.prisma.user.create({
        data: {
          firstName: userData.firstName,
          lastName: userData.lastName,
          primaryEmail: normalizedEmail, // Use normalized email
          email: normalizedEmail, // Legacy field - keep for compatibility
          gender: userData.gender,
          password: hashedPassword,
          patientId, // Assign sequential patient ID
          isActive: userData.isActive ?? true,
          isEmailVerified: userData.isEmailVerified ?? false,
          hasCompletedMedicalForm: userData.hasCompletedMedicalForm ?? false,
          hasCompletedIntakeForm: userData.hasCompletedIntakeForm ?? false,
          // Only include other fields if they are provided
          ...(userData.title && { title: userData.title }),
          ...(userData.middleName && { middleName: userData.middleName }),
          ...(userData.dateOfBirth && { dateOfBirth: new Date(userData.dateOfBirth) }),
          ...(userData.completeAddress && { completeAddress: userData.completeAddress }),
          ...(userData.city && { city: userData.city }),
          ...(userData.state && { state: userData.state }),
          ...(userData.zipcode && { zipcode: userData.zipcode }),
          ...(userData.alternativeEmail && { alternativeEmail: userData.alternativeEmail }),
          ...(userData.primaryPhone && { primaryPhone: userData.primaryPhone }),
          ...(userData.alternativePhone && { alternativePhone: this.normalizePhoneNumber(userData.alternativePhone) }),
          ...(userData.emergencyContactName && { emergencyContactName: userData.emergencyContactName }),
          ...(userData.emergencyContactRelationship && { emergencyContactRelationship: userData.emergencyContactRelationship }),
          ...(userData.emergencyContactPhone && { emergencyContactPhone: this.normalizePhoneNumber(userData.emergencyContactPhone) }),
          ...(userData.referringSource && { referringSource: userData.referringSource }),
          ...(userData.consentForTreatment && { consentForTreatment: userData.consentForTreatment }),
          ...(userData.hipaaPrivacyNoticeAcknowledgment && { hipaaPrivacyNoticeAcknowledgment: userData.hipaaPrivacyNoticeAcknowledgment }),
          ...(userData.releaseOfMedicalRecordsConsent && { releaseOfMedicalRecordsConsent: userData.releaseOfMedicalRecordsConsent }),
          ...(userData.preferredMethodOfCommunication && { preferredMethodOfCommunication: userData.preferredMethodOfCommunication }),
          ...(userData.disabilityAccessibilityNeeds && { disabilityAccessibilityNeeds: userData.disabilityAccessibilityNeeds }),
          ...(userData.phone && { phone: userData.phone }),
        },
      });

      console.log('User created successfully:', user);

      // Hook referral: if a referral code was passed, create the referral record
      if (userData.referralCode) {
        try {
          await this.referralService.createReferralOnSignup(
            userData.referralCode,
            normalizedEmail,
            user.id,
          );
        } catch (refErr) {
          console.error('Referral creation failed (non-fatal):', refErr);
        }
      }

      // Generate JWT token (same format as login)
      const payload = { sub: user.id, email: user.primaryEmail, userType: 'user' };
      const accessToken = this.jwtService.sign(payload);

      return {
        user,
        accessToken,
      };
    } catch (error) {
      console.error('Error creating user step by step:', error);
      
      // Handle specific error types with user-friendly messages
      if (error instanceof BadRequestException) {
        throw error; // Re-throw our custom validation errors
      }
      
      // Handle Prisma errors
      if (error.code === 'P2002') {
        if (error.meta && error.meta.target && error.meta.target.includes('primaryEmail')) {
          throw new BadRequestException('An account with this email address already exists. Please use a different email or try logging in instead.');
        }
        throw new BadRequestException('This information is already in use. Please check your details and try again.');
      }
      
      if (error.code === 'P2025') {
        throw new BadRequestException('Unable to create account. Please try again.');
      }
      
      // Handle validation errors
      if (error.message && error.message.includes('Invalid value for argument')) {
        if (error.message.includes('dateOfBirth')) {
          throw new BadRequestException('Invalid date format. Please use MM-DD-YYYY format.');
        }
        throw new BadRequestException('Invalid data format. Please check your information and try again.');
      }
      
      // Generic error for unexpected issues
      throw new BadRequestException('Unable to create account. Please check your information and try again.');
    }
  }

  // Update welcome order with user ID
  async updateWelcomeOrder(welcomeOrderId: string, updateData: { userId: string }) {
    try {
      console.log('Updating welcome order with user ID:', { welcomeOrderId, userId: updateData.userId });

      const welcomeOrder = await this.prisma.welcomeOrder.update({
        where: { id: welcomeOrderId },
        data: {
          userId: updateData.userId,
        },
      });

      console.log('Welcome order updated successfully:', welcomeOrder);
      return welcomeOrder;
    } catch (error) {
      console.error('Error updating welcome order:', error);
      throw new BadRequestException('Failed to update welcome order: ' + error.message);
    }
  }

  // Update user profile with additional information
  async updateUserProfile(userId: string, userData: any) {
    try {
      console.log('Updating user profile for user:', userId, 'with data:', userData);

      // Filter out undefined/null values and prepare update data
      const updateData: any = {};
      
      // Explicitly handle each expected field
      const fieldsToUpdate = [
        'dateOfBirth',
        'completeAddress',
        'city',
        'zipcode',
        'primaryPhone',
        'alternativePhone',
        'emergencyContactName',
        'emergencyContactRelationship',
        'emergencyContactPhone',
        'referringSource',
        'preferredMethodOfCommunication',
        'disabilityAccessibilityNeeds',
      ];

      fieldsToUpdate.forEach(key => {
        if (userData[key] !== undefined && userData[key] !== null) {
          if (key === 'dateOfBirth') {
            // Special handling for dateOfBirth
            const dateValue = userData[key];
            if (dateValue && dateValue !== '') {
              const date = new Date(dateValue);
              if (isNaN(date.getTime())) {
                throw new BadRequestException('Invalid date format. Please use YYYY-MM-DD format.');
              }
              const currentYear = new Date().getFullYear();
              const dateYear = date.getFullYear();
              if (dateYear < currentYear - 150 || dateYear > currentYear) {
                throw new BadRequestException('Invalid date. Please enter a valid birth date.');
              }
              updateData[key] = date;
            }
          } else if (key === 'primaryPhone') {
            // Always include primaryPhone if provided, and also update legacy phone field
            if (userData[key] && userData[key] !== '') {
              const normalizedPhone = this.normalizePhoneNumber(userData[key]);
              updateData.primaryPhone = normalizedPhone;
              updateData.phone = normalizedPhone; // Also update legacy field
            }
          } else if (key === 'alternativePhone') {
            // Allow empty alternative phone (set to null if empty)
            updateData[key] = userData[key] && userData[key] !== '' ? this.normalizePhoneNumber(userData[key]) : null;
          } else {
            // Include all other fields (allow empty strings for some fields)
            updateData[key] = userData[key];
          }
        }
      });

      console.log('Filtered update data:', updateData);
      
      // Ensure we have data to update
      if (Object.keys(updateData).length === 0) {
        console.warn('No data to update for user:', userId);
        // Return current user if no updates
        return await this.prisma.user.findUnique({
          where: { id: userId },
        });
      }

      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });

      console.log('✅ User profile updated successfully with fields:', Object.keys(updateData));
      console.log('Updated user data:', {
        dateOfBirth: updatedUser.dateOfBirth,
        completeAddress: updatedUser.completeAddress,
        city: updatedUser.city,
        zipcode: updatedUser.zipcode,
        primaryPhone: updatedUser.primaryPhone,
      });
      return updatedUser;
    } catch (error) {
      console.error('Error updating user profile:', error);
      
      // Handle specific error types with user-friendly messages
      if (error instanceof BadRequestException) {
        throw error; // Re-throw our custom validation errors
      }
      
      // Handle Prisma errors
      if (error.code === 'P2002') {
        throw new BadRequestException('This information is already in use. Please check your details.');
      }
      
      if (error.code === 'P2025') {
        throw new BadRequestException('User not found. Please try logging in again.');
      }
      
      // Handle date validation errors
      if (error.message && error.message.includes('Invalid value for argument')) {
        if (error.message.includes('dateOfBirth')) {
          throw new BadRequestException('Invalid date format. Please use MM-DD-YYYY format.');
        }
        throw new BadRequestException('Invalid data format. Please check your information.');
      }
      
      // Generic error for unexpected issues
      throw new BadRequestException('Unable to update profile. Please check your information and try again.');
    }
  }

  // Save BMI data to Medical Form table (like the old BMI flow)
  async saveBMIData(userId: string, bmiData: { height: string; weight: string; waist: string; bmi: string }) {
    try {
      console.log('Saving BMI data to medical form for user:', userId, 'with data:', bmiData);

      // Check if user exists
      const user = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // Check if medical form already exists for this user
      let medicalForm = await this.prisma.medicalForm.findFirst({
        where: { 
          patientId: userId,
          appointmentId: null // New signup forms don't have appointmentId yet
        }
      });

      if (medicalForm) {
        // Update existing medical form with BMI data
        medicalForm = await this.prisma.medicalForm.update({
          where: { id: medicalForm.id },
          data: {
            height: bmiData.height,
            weight: bmiData.weight,
            waist: bmiData.waist,
            bmi: bmiData.bmi,
          }
        });
        console.log('Updated existing medical form with BMI data:', medicalForm);
      } else {
        // Create new medical form with BMI data
        medicalForm = await this.prisma.medicalForm.create({
          data: {
            patientId: userId,
            height: bmiData.height,
            weight: bmiData.weight,
            waist: bmiData.waist,
            bmi: bmiData.bmi,
            // Set labSchedulingNeeded to true by default
            labSchedulingNeeded: true,
            // Set some default values for legacy fields
            chiefComplaint: 'New patient registration',
            historyOfPresentIllness: 'Initial consultation',
            pastMedicalHistory: 'To be completed',
            pastSurgicalHistory: 'To be completed',
            allergies: 'To be completed',
            tobaccoUse: 'To be completed',
            alcoholUse: 'To be completed',
            familyHistory: 'To be completed',
            workHistory: 'To be completed',
            medications: 'To be completed',
          }
        });
        console.log('Created new medical form with BMI data:', medicalForm);
      }

      return {
        success: true,
        message: 'BMI data saved successfully',
        data: medicalForm
      };
    } catch (error) {
      console.error('Error saving BMI data to medical form:', error);
      
      if (error instanceof NotFoundException) {
        throw error;
      }
      
      throw new BadRequestException('Failed to save BMI data: ' + error.message);
    }
  }

  // Save Medical Intake Form data to Medical Form table
  async saveMedicalIntake(userId: string, medicalData: any) {
    try {
      console.log('Saving medical intake data for user:', userId, 'with data:', medicalData);

      // Check if user exists
      const user = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // Find existing medical form for this user
      let medicalForm = await this.prisma.medicalForm.findFirst({
        where: { 
          patientId: userId,
          appointmentId: null // New signup forms don't have appointmentId yet
        }
      });

      // Process the medical data to handle date fields properly
      const processedMedicalData: any = { ...medicalData };
      
      // Convert consentDate string to Date object if provided
      if (processedMedicalData.consentDate && typeof processedMedicalData.consentDate === 'string') {
        processedMedicalData.consentDate = new Date(processedMedicalData.consentDate);
      }

      // Set labSchedulingNeeded to true by default if not provided
      if (processedMedicalData.labSchedulingNeeded === undefined || processedMedicalData.labSchedulingNeeded === null) {
        processedMedicalData.labSchedulingNeeded = true;
      }

      if (medicalForm) {
        // Update existing medical form with intake data
        medicalForm = await this.prisma.medicalForm.update({
          where: { id: medicalForm.id },
          data: processedMedicalData
        });
        console.log('Updated existing medical form with intake data:', medicalForm);
      } else {
        // Create new medical form with intake data
        medicalForm = await this.prisma.medicalForm.create({
          data: {
            patientId: userId,
            ...processedMedicalData,
            // Set labSchedulingNeeded to true by default if not provided
            labSchedulingNeeded: processedMedicalData.labSchedulingNeeded !== undefined ? processedMedicalData.labSchedulingNeeded : true,
            // Set some default values for required fields
            chiefComplaint: 'New patient registration',
            historyOfPresentIllness: 'Initial consultation',
            pastMedicalHistory: 'To be completed',
            pastSurgicalHistory: 'To be completed',
            allergies: 'To be completed',
            tobaccoUse: 'To be completed',
            alcoholUse: 'To be completed',
            familyHistory: 'To be completed',
            workHistory: 'To be completed',
            medications: 'To be completed',
          }
        });
        console.log('Created new medical form with intake data:', medicalForm);
      }

      // Mark that the user has completed the full medical form (like old flow)
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          hasCompletedMedicalForm: true,
          medicalFormCompletedAt: new Date(),
        },
      });

      console.log('User marked as having completed medical form');

      return {
        success: true,
        message: 'Medical intake data saved successfully',
        data: medicalForm
      };
    } catch (error) {
      console.error('Error saving medical intake data:', error);
      
      if (error instanceof NotFoundException) {
        throw error;
      }
      
      throw new BadRequestException('Failed to save medical intake data: ' + error.message);
    }
  }

  // Save Consent data to User table and send emails
  async saveConsentAndComplete(userId: string, consentData: any) {
    try {
      console.log('Saving consent data and completing signup for user:', userId, 'with data:', consentData);

      // Check if user exists
      const user = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // Find welcome order for this user to get all signup step data
      const welcomeOrder = await this.prisma.welcomeOrder.findFirst({
        where: { userId: userId },
        include: {
          signupSteps: {
            orderBy: [
              { stepNumber: 'asc' },
              { subStepNumber: 'asc' },
            ],
          },
        },
      });

      // Collect all data from signup steps
      let mergedData: any = {};
      
      if (welcomeOrder && welcomeOrder.signupSteps) {
        welcomeOrder.signupSteps.forEach(step => {
          if (step.stepData && typeof step.stepData === 'object') {
            const stepData = step.stepData as any;
            
            // Merge all step data, prioritizing step 4 (details) which has dateOfBirth, address, phone
            Object.keys(stepData).forEach(key => {
              if (stepData[key] !== undefined && stepData[key] !== null && stepData[key] !== '') {
                mergedData[key] = stepData[key];
              }
            });
          }
        });
      }

      // Prepare update data with all collected fields
      const updateData: any = {
          consentForTreatment: consentData.consentForTreatment ? 'Y' : 'N',
          hipaaPrivacyNoticeAcknowledgment: consentData.hipaaPrivacyNoticeAcknowledgment ? 'Y' : 'N',
          releaseOfMedicalRecordsConsent: consentData.releaseOfMedicalRecordsConsent ? 'Y' : 'N',
          isEmailVerified: false, // Will be verified when they click email link
          hasCompletedIntakeForm: true,
          intakeFormCompletedAt: new Date(),
      };

      // Add data from signup steps
      if (mergedData.dateOfBirth) {
        const dateValue = mergedData.dateOfBirth;
        if (typeof dateValue === 'string') {
          const date = new Date(dateValue);
          if (!isNaN(date.getTime())) {
            updateData.dateOfBirth = date;
          }
        } else if (dateValue instanceof Date) {
          updateData.dateOfBirth = dateValue;
        }
      }
      
      if (mergedData.completeAddress !== undefined) updateData.completeAddress = mergedData.completeAddress;
      if (mergedData.city !== undefined) updateData.city = mergedData.city;
      if (mergedData.zipcode !== undefined) updateData.zipcode = mergedData.zipcode;
      if (mergedData.primaryPhone !== undefined) {
        const normalizedPhone = this.normalizePhoneNumber(mergedData.primaryPhone);
        updateData.primaryPhone = normalizedPhone;
        updateData.phone = normalizedPhone; // Also update legacy field
      }
      if (mergedData.alternativePhone) updateData.alternativePhone = this.normalizePhoneNumber(mergedData.alternativePhone);
      if (mergedData.emergencyContactName) updateData.emergencyContactName = mergedData.emergencyContactName;
      if (mergedData.emergencyContactRelationship) updateData.emergencyContactRelationship = mergedData.emergencyContactRelationship;
      if (mergedData.emergencyContactPhone) updateData.emergencyContactPhone = this.normalizePhoneNumber(mergedData.emergencyContactPhone);
      if (mergedData.referringSource) updateData.referringSource = mergedData.referringSource;
      if (mergedData.preferredMethodOfCommunication) updateData.preferredMethodOfCommunication = mergedData.preferredMethodOfCommunication;
      if (mergedData.disabilityAccessibilityNeeds) updateData.disabilityAccessibilityNeeds = mergedData.disabilityAccessibilityNeeds;

      console.log('Updating user with merged data from signup steps:', updateData);

      // Update user with all collected data
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });

      // Mark welcome order as completed if it exists
      if (welcomeOrder) {
        await this.prisma.welcomeOrder.update({
          where: { id: welcomeOrder.id },
          data: {
            status: WelcomeOrderStatus.IN_PROGRESS,
            isCompleted: false,
            completedAt: new Date(),
          },
        });
      }

      console.log('Updated user with all collected data including dateOfBirth, address, phone:', updatedUser);

      // Generate email verification token
      const emailVerificationToken = crypto.randomBytes(32).toString('hex');
      const emailVerificationTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Update user with email verification token
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          emailVerificationToken,
          emailVerificationTokenExpiry,
        }
      });

      // Send welcome email
      try {
        if (user.primaryEmail) {
          await this.mailerService.sendWelcomeEmail(
            user.primaryEmail,
            user.firstName || 'User'
          );
          console.log('Welcome email sent successfully');
        } else {
          console.error('No primary email found for user');
        }
      } catch (error) {
        console.error('Failed to send welcome email:', error);
        // Don't fail the process if email fails
      }

      // Send email verification email
      try {
        if (user.primaryEmail) {
          const verificationLink = `https://formamd.com/verify-email?token=${emailVerificationToken}`;
          console.log('Generated verification link:', verificationLink);
          
          await this.mailerService.sendEmailVerificationEmail(
            user.primaryEmail,
            user.firstName || 'User',
            verificationLink
          );
          console.log('Email verification email sent successfully');
        } else {
          console.error('No primary email found for user');
        }
      } catch (error) {
        console.error('Failed to send email verification email:', error);
        // Don't fail the process if email fails
      }

      return {
        success: true,
        message: 'Consent data saved and signup completed successfully',
        data: {
          user: updatedUser,
          emailsSent: {
            welcome: true,
            verification: true
          }
        }
      };
    } catch (error) {
      console.error('Error saving consent data and completing signup:', error);
      
      if (error instanceof NotFoundException) {
        throw error;
      }
      
      throw new BadRequestException('Failed to save consent data: ' + error.message);
    }
  }
}