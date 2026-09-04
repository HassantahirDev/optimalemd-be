import { IsEmail, IsString, IsOptional, IsBoolean, IsNumber, IsEnum, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum WelcomeOrderStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED'
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED'
}

// Step 0 - Gender
export class GenderStepDto {
  @IsString()
  gender: string;
}

// Step 1 - Basic Info
export class BasicInfoStepDto {
  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsEmail()
  email: string;

  @IsString()
  state: string;
}

// Step 2 - Checkout
export class CheckoutStepDto {
  @IsOptional()
  @IsString()
  paymentIntentId?: string;

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;
}

// Step 3 - Password
export class PasswordStepDto {
  @IsString()
  password: string;

  @IsString()
  confirmPassword: string;
}

// Step 4 - Details (BMI + Medical + Consent)
export class DetailsStepDto {
  // BMI/Physical measurements
  @IsString()
  height: string;

  @IsString()
  weight: string;

  @IsString()
  waist: string;

  @IsString()
  bmi: string;

  // Medical intake data
  @IsOptional()
  @IsObject()
  medicalData?: any; // Flexible JSON for medical form data

  // Consent data
  @IsBoolean()
  consentForTreatment: boolean;

  @IsBoolean()
  hipaaPrivacyNoticeAcknowledgment: boolean;

  @IsBoolean()
  releaseOfMedicalRecordsConsent: boolean;
}

// Create Welcome Order DTO
export class CreateWelcomeOrderDto {
  @IsEmail()
  email: string;

  @IsNumber()
  totalAmount: number;

  @IsNumber()
  discountAmount: number;

  @IsNumber()
  finalAmount: number;

  @IsOptional()
  @IsString()
  userId?: string;
}

// Update Step DTO
export class UpdateSignupStepDto {
  @IsNumber()
  stepNumber: number;

  @IsString()
  stepName: string;

  @IsOptional()
  @IsNumber()
  subStepNumber?: number;

  @IsOptional()
  @IsString()
  subStepName?: string;

  @IsOptional()
  @IsObject()
  stepData?: any;

  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;

  @IsOptional()
  @IsBoolean()
  isValid?: boolean;

  @IsOptional()
  @IsObject()
  validationErrors?: any;
}

// Get signup progress response
export class SignupProgressResponseDto {
  welcomeOrderId: string;
  email: string;
  currentStep: number;
  currentSubStep: number;
  isCompleted: boolean;
  paymentStatus?: PaymentStatus; // Include payment status to skip payment step if already paid
  paymentIntentId?: string; // Include payment intent ID
  userId?: string; // Include userId to check if user already exists (skip password step if exists)
  steps: {
    stepNumber: number;
    stepName: string;
    subStepNumber?: number;
    subStepName?: string;
    isCompleted: boolean;
    isValid: boolean;
    completedAt?: Date;
  }[];
}

// Resume signup response
export class ResumeSignupResponseDto {
  welcomeOrderId: string;
  email: string;
  currentStep: number;
  currentSubStep: number;
  stepData: any;
  canResume: boolean;
}

// Step-by-step user creation DTO (all fields optional)
export class CreateUserStepByStepDto {
  // Basic required fields for first step
  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsEmail()
  primaryEmail: string;

  @IsString()
  gender: string;

  // All other fields are optional for step-by-step flow
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  middleName?: string;

  @IsOptional()
  @IsString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  completeAddress?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  zipcode?: string;

  @IsOptional()
  @IsString()
  alternativeEmail?: string;

  @IsOptional()
  @IsString()
  primaryPhone?: string;

  @IsOptional()
  @IsString()
  alternativePhone?: string;

  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  emergencyContactRelationship?: string;

  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  @IsOptional()
  @IsString()
  referringSource?: string;

  @IsOptional()
  @IsString()
  consentForTreatment?: string;

  @IsOptional()
  @IsString()
  hipaaPrivacyNoticeAcknowledgment?: string;

  @IsOptional()
  @IsString()
  releaseOfMedicalRecordsConsent?: string;

  @IsOptional()
  @IsString()
  preferredMethodOfCommunication?: string;

  @IsOptional()
  @IsString()
  disabilityAccessibilityNeeds?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  referralCode?: string;

  // Partner-program attribution id set by the tracking snippet (cookie/localStorage).
  // Separate from referralCode (patient-to-patient program) — see ReferralPartner.
  @IsOptional()
  @IsString()
  visitorId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isEmailVerified?: boolean;

  @IsOptional()
  @IsBoolean()
  hasCompletedMedicalForm?: boolean;

  @IsOptional()
  @IsBoolean()
  hasCompletedIntakeForm?: boolean;
}