import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsDateString, IsBoolean, ValidateIf } from 'class-validator';

export class AdminCreatePatientDto {
  // Mandatory Fields
  @ApiProperty({ description: 'Patient title', example: 'Mr' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({ description: 'First name', example: 'John' })
  @IsString()
  firstName: string;

  @ApiProperty({ description: 'Middle name', example: 'Michael', required: false })
  @IsString()
  @IsOptional()
  middleName?: string;

  @ApiProperty({ description: 'Last name', example: 'Doe' })
  @IsString()
  lastName: string;

  @ApiProperty({ description: 'Date of birth', example: '1990-01-01' })
  @IsDateString()
  dateOfBirth: string;

  @ApiProperty({ description: 'Gender', example: 'Male' })
  @IsString()
  gender: string;

  @ApiProperty({ description: 'Complete address', example: '123 Main St, Apt 4B' })
  @IsString()
  completeAddress: string;

  @ApiProperty({ description: 'City', example: 'New York' })
  @IsString()
  city: string;

  @ApiProperty({ description: 'State', example: 'NY' })
  @IsString()
  state: string;

  @ApiProperty({ description: 'Zipcode', example: '10001' })
  @IsString()
  zipcode: string;

  @ApiProperty({ description: 'Primary email', example: 'john.doe@example.com' })
  @IsEmail()
  primaryEmail: string;

  @ApiProperty({ description: 'Alternative email', example: 'john.alt@example.com', required: false })
  @IsEmail()
  @IsOptional()
  alternativeEmail?: string;

  @ApiProperty({ description: 'Primary phone', example: '+1-555-123-4567' })
  @IsString()
  primaryPhone: string;

  @ApiProperty({ description: 'Alternative phone', example: '+1-555-987-6543', required: false })
  @IsString()
  @IsOptional()
  alternativePhone?: string;

  @ApiProperty({ description: 'Emergency contact name', example: 'Jane Doe', required: false })
  @IsOptional()
  emergencyContactName?: string;

  @ApiProperty({ description: 'Emergency contact relationship', example: 'Spouse', required: false })
  @IsString()
  @IsOptional()
  emergencyContactRelationship?: string;

  @ApiProperty({ description: 'Emergency contact phone', example: '+1-555-456-7890', required: false })

  @IsOptional()
  emergencyContactPhone?: string;

  @IsOptional()
  referringSource?: string;

  @ApiProperty({ description: 'Consent for treatment', example: 'Y' })
  @IsString()
  consentForTreatment: string;

  @ApiProperty({ description: 'HIPAA privacy notice acknowledgment', example: 'Y' })
  @IsString()
  hipaaPrivacyNoticeAcknowledgment: string;

  @ApiProperty({ description: 'Release of medical records consent', example: 'Y' })
  @IsString()
  releaseOfMedicalRecordsConsent: string;

  @ApiProperty({ description: 'Preferred method of communication', example: 'Email' })
  @IsString()
  preferredMethodOfCommunication: string;

  @ApiProperty({ description: 'Disability accessibility needs', example: 'None', required: false })
  @IsString()
  @IsOptional()
  disabilityAccessibilityNeeds?: string;

  // Optional Fields
  @ApiProperty({ description: 'Care provider phone', example: '+1-555-111-2222', required: false })
  @IsString()
  @IsOptional()
  careProviderPhone?: string;

  @ApiProperty({ description: 'Last four digits of SSN', example: '1234', required: false })
  @IsString()
  @IsOptional()
  lastFourDigitsSSN?: string;

  @ApiProperty({ description: 'Language preference', example: 'English', required: false })
  @IsString()
  @IsOptional()
  languagePreference?: string;

  @ApiProperty({ description: 'Ethnicity/Race', example: 'Caucasian', required: false })
  @IsString()
  @IsOptional()
  ethnicityRace?: string;

  @ApiProperty({ description: 'Primary care physician', example: 'Dr. Smith', required: false })
  @IsString()
  @IsOptional()
  primaryCarePhysician?: string;

  @ApiProperty({ description: 'Insurance provider name', example: 'Blue Cross', required: false })
  @IsString()
  @IsOptional()
  insuranceProviderName?: string;

  @ApiProperty({ description: 'Insurance policy number', example: 'BC123456', required: false })
  @IsString()
  @IsOptional()
  insurancePolicyNumber?: string;

  @ApiProperty({ description: 'Insurance group number', example: 'GRP789', required: false })
  @IsString()
  @IsOptional()
  insuranceGroupNumber?: string;

  @ApiProperty({ description: 'Insurance phone number', example: '+1-555-333-4444', required: false })
  @IsString()
  @IsOptional()
  insurancePhoneNumber?: string;

  @ApiProperty({ description: 'Guarantor responsible party', example: 'Self', required: false })
  @IsString()
  @IsOptional()
  guarantorResponsibleParty?: string;

  @ApiProperty({ description: 'Date of first visit planned', example: '2024-01-15', required: false })
  @ValidateIf((o) => o.dateOfFirstVisitPlanned !== '' && o.dateOfFirstVisitPlanned !== null && o.dateOfFirstVisitPlanned !== undefined)
  @IsDateString()
  @IsOptional()
  dateOfFirstVisitPlanned?: string;

  @ApiProperty({ description: 'Interpreter required', example: 'N', required: false })
  @IsString()
  @IsOptional()
  interpreterRequired?: string;

  @ApiProperty({ description: 'Advance directives', example: 'N', required: false })
  @IsString()
  @IsOptional()
  advanceDirectives?: string;

  // Admin-specific fields
  @ApiProperty({ description: 'Send welcome email with credentials', example: true, default: true })
  @IsBoolean()
  @IsOptional()
  sendWelcomeEmail?: boolean;

  @ApiProperty({ description: 'Make patient a premium member', example: false, default: false })
  @IsBoolean()
  @IsOptional()
  makePremiumMember?: boolean;
}

export class AdminUpdatePatientDto {
  // Same fields as create but all optional
  @ApiProperty({ description: 'Patient title', example: 'Mr', required: false })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({ description: 'First name', example: 'John', required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ description: 'Middle name', example: 'Michael', required: false })
  @IsString()
  @IsOptional()
  middleName?: string;

  @ApiProperty({ description: 'Last name', example: 'Doe', required: false })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({ description: 'Date of birth', example: '1990-01-01', required: false })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: string;

  @ApiProperty({ description: 'Gender', example: 'Male', required: false })
  @IsString()
  @IsOptional()
  gender?: string;

  @ApiProperty({ description: 'Complete address', example: '123 Main St, Apt 4B', required: false })
  @IsString()
  @IsOptional()
  completeAddress?: string;

  @ApiProperty({ description: 'City', example: 'New York', required: false })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiProperty({ description: 'State', example: 'NY', required: false })
  @IsString()
  @IsOptional()
  state?: string;

  @ApiProperty({ description: 'Zipcode', example: '10001', required: false })
  @IsString()
  @IsOptional()
  zipcode?: string;

  @ApiProperty({ description: 'Primary email', example: 'john.doe@example.com', required: false })
  @IsEmail()
  @IsOptional()
  primaryEmail?: string;

  @ApiProperty({ description: 'Alternative email', example: 'john.alt@example.com', required: false })
  @IsEmail()
  @IsOptional()
  alternativeEmail?: string;

  @ApiProperty({ description: 'Primary phone', example: '+1-555-123-4567', required: false })
  @IsString()
  @IsOptional()
  primaryPhone?: string;

  @ApiProperty({ description: 'Alternative phone', example: '+1-555-987-6543', required: false })
  @IsString()
  @IsOptional()
  alternativePhone?: string;

  @ApiProperty({ description: 'Emergency contact name', example: 'Jane Doe', required: false })
  @IsString()
  @IsOptional()
  emergencyContactName?: string;

  @ApiProperty({ description: 'Emergency contact relationship', example: 'Spouse', required: false })
  @IsString()
  @IsOptional()
  emergencyContactRelationship?: string;

  @ApiProperty({ description: 'Emergency contact phone', example: '+1-555-456-7890', required: false })
  @IsString()
  @IsOptional()
  emergencyContactPhone?: string;

  @ApiProperty({ description: 'Referring source', example: 'Online', required: false })
  @IsString()
  @IsOptional()
  referringSource?: string;

  @ApiProperty({ description: 'Consent for treatment', example: 'Y', required: false })
  @IsString()
  @IsOptional()
  consentForTreatment?: string;

  @ApiProperty({ description: 'HIPAA privacy notice acknowledgment', example: 'Y', required: false })
  @IsString()
  @IsOptional()
  hipaaPrivacyNoticeAcknowledgment?: string;

  @ApiProperty({ description: 'Release of medical records consent', example: 'Y', required: false })
  @IsString()
  @IsOptional()
  releaseOfMedicalRecordsConsent?: string;

  @ApiProperty({ description: 'Preferred method of communication', example: 'Email', required: false })
  @IsString()
  @IsOptional()
  preferredMethodOfCommunication?: string;

  @ApiProperty({ description: 'Disability accessibility needs', example: 'None', required: false })
  @IsString()
  @IsOptional()
  disabilityAccessibilityNeeds?: string;

  @ApiProperty({ description: 'Care provider phone', example: '+1-555-111-2222', required: false })
  @IsString()
  @IsOptional()
  careProviderPhone?: string;

  @ApiProperty({ description: 'Last four digits of SSN', example: '1234', required: false })
  @IsString()
  @IsOptional()
  lastFourDigitsSSN?: string;

  @ApiProperty({ description: 'Language preference', example: 'English', required: false })
  @IsString()
  @IsOptional()
  languagePreference?: string;

  @ApiProperty({ description: 'Ethnicity/Race', example: 'Caucasian', required: false })
  @IsString()
  @IsOptional()
  ethnicityRace?: string;

  @ApiProperty({ description: 'Primary care physician', example: 'Dr. Smith', required: false })
  @IsString()
  @IsOptional()
  primaryCarePhysician?: string;

  @ApiProperty({ description: 'Insurance provider name', example: 'Blue Cross', required: false })
  @IsString()
  @IsOptional()
  insuranceProviderName?: string;

  @ApiProperty({ description: 'Insurance policy number', example: 'BC123456', required: false })
  @IsString()
  @IsOptional()
  insurancePolicyNumber?: string;

  @ApiProperty({ description: 'Insurance group number', example: 'GRP789', required: false })
  @IsString()
  @IsOptional()
  insuranceGroupNumber?: string;

  @ApiProperty({ description: 'Insurance phone number', example: '+1-555-333-4444', required: false })
  @IsString()
  @IsOptional()
  insurancePhoneNumber?: string;

  @ApiProperty({ description: 'Guarantor responsible party', example: 'Self', required: false })
  @IsString()
  @IsOptional()
  guarantorResponsibleParty?: string;

  @ApiProperty({ description: 'Date of first visit planned', example: '2024-01-15', required: false })
  @ValidateIf((o) => o.dateOfFirstVisitPlanned !== '' && o.dateOfFirstVisitPlanned !== null && o.dateOfFirstVisitPlanned !== undefined)
  @IsDateString()
  @IsOptional()
  dateOfFirstVisitPlanned?: string;

  @ApiProperty({ description: 'Interpreter required', example: 'N', required: false })
  @IsString()
  @IsOptional()
  interpreterRequired?: string;

  @ApiProperty({ description: 'Advance directives', example: 'N', required: false })
  @IsString()
  @IsOptional()
  advanceDirectives?: string;

  @ApiProperty({ description: 'Active status', example: true, required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class AdminCreateMedicalFormDto {
  // Patient Goals
  @ApiProperty({ description: 'Goal: More Energy', required: false })
  @IsBoolean()
  @IsOptional()
  goalMoreEnergy?: boolean;

  @ApiProperty({ description: 'Goal: Better Sexual Performance', required: false })
  @IsBoolean()
  @IsOptional()
  goalBetterSexualPerformance?: boolean;

  @ApiProperty({ description: 'Goal: Lose Weight', required: false })
  @IsBoolean()
  @IsOptional()
  goalLoseWeight?: boolean;

  @ApiProperty({ description: 'Goal: Hair Restoration', required: false })
  @IsBoolean()
  @IsOptional()
  goalHairRestoration?: boolean;

  @ApiProperty({ description: 'Goal: Improve Mood', required: false })
  @IsBoolean()
  @IsOptional()
  goalImproveMood?: boolean;

  @ApiProperty({ description: 'Goal: Longevity', required: false })
  @IsBoolean()
  @IsOptional()
  goalLongevity?: boolean;

  @ApiProperty({ description: 'Goal: Other', required: false })
  @IsBoolean()
  @IsOptional()
  goalOther?: boolean;

  @ApiProperty({ description: 'Other goal description', required: false })
  @IsString()
  @IsOptional()
  goalOtherDescription?: string;

  // Physical measurements
  @ApiProperty({ description: 'Height', example: '6\'0"', required: false })
  @IsString()
  @IsOptional()
  height?: string;

  @ApiProperty({ description: 'Weight', example: '180 lbs', required: false })
  @IsString()
  @IsOptional()
  weight?: string;

  @ApiProperty({ description: 'Waist measurement', example: '34 inches', required: false })
  @IsString()
  @IsOptional()
  waist?: string;

  @ApiProperty({ description: 'BMI', example: '24.5', required: false })
  @IsString()
  @IsOptional()
  bmi?: string;

  // Medical History
  @ApiProperty({ description: 'Chronic conditions', required: false })
  @IsString()
  @IsOptional()
  chronicConditions?: string;

  @ApiProperty({ description: 'Past surgeries and hospitalizations', required: false })
  @IsString()
  @IsOptional()
  pastSurgeriesHospitalizations?: string;

  @ApiProperty({ description: 'Current medications', required: false })
  @IsString()
  @IsOptional()
  currentMedications?: string;

  @ApiProperty({ description: 'Family history', required: false })
  @IsString()
  @IsOptional()
  familyHistory?: string;

  @ApiProperty({ description: 'Allergies', required: false })
  @IsString()
  @IsOptional()
  allergies?: string;

  // Lifestyle
  @ApiProperty({ description: 'Sleep hours per night', example: '7-8', required: false })
  @IsString()
  @IsOptional()
  sleepHoursPerNight?: string;

  @ApiProperty({ description: 'Sleep quality', example: 'Good', required: false })
  @IsString()
  @IsOptional()
  sleepQuality?: string;

  @ApiProperty({ description: 'Exercise frequency', example: '3-4 times per week', required: false })
  @IsString()
  @IsOptional()
  exerciseFrequency?: string;

  @ApiProperty({ description: 'Diet type', example: 'Mediterranean', required: false })
  @IsString()
  @IsOptional()
  dietType?: string;

  @ApiProperty({ description: 'Alcohol use', example: 'Occasional', required: false })
  @IsString()
  @IsOptional()
  alcoholUse?: string;

  @ApiProperty({ description: 'Alcohol days per week', required: false })
  @IsString()
  @IsOptional()
  alcoholDaysPerWeek?: string;

  @ApiProperty({ description: 'Alcohol drinks per typical day', required: false })
  @IsString()
  @IsOptional()
  alcoholDrinksPerDay?: string;

  @ApiProperty({ description: 'Tobacco use', example: 'No', required: false })
  @IsString()
  @IsOptional()
  tobaccoUse?: string;

  @ApiProperty({ description: 'Tobacco product types', required: false })
  @IsString()
  @IsOptional()
  tobaccoProductTypes?: string;

  @ApiProperty({ description: 'Cigarette smoking frequency', required: false })
  @IsString()
  @IsOptional()
  tobaccoCigaretteFrequency?: string;

  @ApiProperty({ description: 'Non-cigarette tobacco frequency', required: false })
  @IsString()
  @IsOptional()
  tobaccoNonCigaretteFrequency?: string;

  @ApiProperty({ description: 'Cannabis/other substances', example: 'None', required: false })
  @IsString()
  @IsOptional()
  cannabisOtherSubstances?: string;

  @ApiProperty({ description: 'Substances list', required: false })
  @IsString()
  @IsOptional()
  cannabisOtherSubstancesList?: string;

  @ApiProperty({ description: 'Stress level', example: 'Moderate', required: false })
  @IsString()
  @IsOptional()
  stressLevel?: string;

  // Personal & Family
  @ApiProperty({ description: 'Marital status', required: false })
  @IsString()
  @IsOptional()
  maritalStatus?: string;

  @ApiProperty({ description: 'Has children', required: false })
  @IsOptional()
  hasChildren?: boolean;

  @ApiProperty({ description: 'Children count and ages', required: false })
  @IsString()
  @IsOptional()
  childrenCountAndAges?: string;

  @ApiProperty({ description: 'Wants future children', required: false })
  @IsString()
  @IsOptional()
  wantsFutureChildren?: string;

  // Work Info
  @ApiProperty({ description: 'Job/Occupation', required: false })
  @IsString()
  @IsOptional()
  jobOccupation?: string;

  @ApiProperty({ description: 'Work hours per week', required: false })
  @IsString()
  @IsOptional()
  workHoursPerWeek?: string;

  // Symptoms
  @ApiProperty({ description: 'Symptom: Fatigue', required: false })
  @IsBoolean()
  @IsOptional()
  symptomFatigue?: boolean;

  @ApiProperty({ description: 'Symptom: Low Libido', required: false })
  @IsBoolean()
  @IsOptional()
  symptomLowLibido?: boolean;

  @ApiProperty({ description: 'Symptom: Muscle Loss', required: false })
  @IsBoolean()
  @IsOptional()
  symptomMuscleLoss?: boolean;

  @ApiProperty({ description: 'Symptom: Weight Gain', required: false })
  @IsBoolean()
  @IsOptional()
  symptomWeightGain?: boolean;

  @ApiProperty({ description: 'Symptom: Gynecomastia', required: false })
  @IsBoolean()
  @IsOptional()
  symptomGynecomastia?: boolean;

  @ApiProperty({ description: 'Symptom: Brain Fog', required: false })
  @IsBoolean()
  @IsOptional()
  symptomBrainFog?: boolean;

  @ApiProperty({ description: 'Symptom: Mood Swings', required: false })
  @IsBoolean()
  @IsOptional()
  symptomMoodSwings?: boolean;

  @ApiProperty({ description: 'Symptom: Poor Sleep', required: false })
  @IsBoolean()
  @IsOptional()
  symptomPoorSleep?: boolean;

  @ApiProperty({ description: 'Symptom: Hair Thinning', required: false })
  @IsBoolean()
  @IsOptional()
  symptomHairThinning?: boolean;

  // Safety Check
  @ApiProperty({ description: 'History of prostate/breast cancer', required: false })
  @IsBoolean()
  @IsOptional()
  historyProstateBreastCancer?: boolean;

  @ApiProperty({ description: 'Prostate/breast cancer explanation', required: false })
  @IsString()
  @IsOptional()
  historyProstateBreastCancerExplanation?: string;

  @ApiProperty({ description: 'History of blood clots/MI/stroke', required: false })
  @IsBoolean()
  @IsOptional()
  historyBloodClotsMIStroke?: boolean;

  @ApiProperty({ description: 'Blood clots/MI/stroke explanation', required: false })
  @IsString()
  @IsOptional()
  historyBloodClotsMIStrokeExplanation?: string;

  @ApiProperty({ description: 'Currently using hormones/peptides', required: false })
  @IsBoolean()
  @IsOptional()
  currentlyUsingHormonesPeptides?: boolean;

  @ApiProperty({ description: 'Hormones/peptides explanation', required: false })
  @IsString()
  @IsOptional()
  currentlyUsingHormonesPeptidesExplanation?: string;

  @ApiProperty({ description: 'Planning children next 12 months', required: false })
  @IsBoolean()
  @IsOptional()
  planningChildrenNext12Months?: boolean;

  @ApiProperty({ description: 'Planning children explanation', required: false })
  @IsString()
  @IsOptional()
  planningChildrenNext12MonthsExplanation?: string;

  // Labs & Uploads
  @ApiProperty({ description: 'Lab scheduling needed', required: false })
  @IsBoolean()
  @IsOptional()
  labSchedulingNeeded?: boolean;

  @ApiProperty({ description: 'Lab uploads', required: false })
  @IsString()
  @IsOptional()
  labUploads?: string;

  // Consent
  @ApiProperty({ description: 'Consent to telemedicine care', required: false })
  @IsBoolean()
  @IsOptional()
  consentTelemedicineCare?: boolean;

  @ApiProperty({ description: 'Consent to elective optimization treatment', required: false })
  @IsBoolean()
  @IsOptional()
  consentElectiveOptimizationTreatment?: boolean;

  @ApiProperty({ description: 'Consent to required lab monitoring', required: false })
  @IsBoolean()
  @IsOptional()
  consentRequiredLabMonitoring?: boolean;

  @ApiProperty({ description: 'Digital signature', required: false })
  @IsString()
  @IsOptional()
  digitalSignature?: string;

  @ApiProperty({ description: 'Consent date', required: false })
  @IsDateString()
  @IsOptional()
  consentDate?: string;
}

export class PatientWithMedicalFormResponseDto {
  @ApiProperty({ description: 'Patient ID' })
  id: string;

  @ApiProperty({ description: 'Patient ID (OPT-XXXX format)', required: false })
  patientId?: string | null;

  @ApiProperty({ description: 'Patient title' })
  title?: string;

  @ApiProperty({ description: 'First name' })
  firstName: string;

  @ApiProperty({ description: 'Middle name' })
  middleName?: string;

  @ApiProperty({ description: 'Last name' })
  lastName: string;

  @ApiProperty({ description: 'Date of birth' })
  dateOfBirth: Date;

  @ApiProperty({ description: 'Gender' })
  gender: string;

  @ApiProperty({ description: 'Complete address' })
  completeAddress: string;

  @ApiProperty({ description: 'City' })
  city: string;

  @ApiProperty({ description: 'State' })
  state: string;

  @ApiProperty({ description: 'Zipcode' })
  zipcode: string;

  @ApiProperty({ description: 'Primary email' })
  primaryEmail: string;

  @ApiProperty({ description: 'Alternative email' })
  alternativeEmail?: string;

  @ApiProperty({ description: 'Primary phone' })
  primaryPhone: string;

  @ApiProperty({ description: 'Alternative phone' })
  alternativePhone?: string;

  @ApiProperty({ description: 'Emergency contact name' })
  emergencyContactName: string;

  @ApiProperty({ description: 'Emergency contact relationship' })
  emergencyContactRelationship?: string;

  @ApiProperty({ description: 'Emergency contact phone' })
  emergencyContactPhone: string;

  @ApiProperty({ description: 'Is active' })
  isActive: boolean;

  @ApiProperty({ description: 'Is email verified' })
  isEmailVerified: boolean;

  @ApiProperty({ description: 'Subscription status', required: false })
  isSubscribed?: boolean;

  @ApiProperty({ description: 'Subscription status', required: false })
  subscriptionStatus?: string | null;

  @ApiProperty({ description: 'Subscription start date', required: false })
  subscriptionStartDate?: Date | null;

  @ApiProperty({ description: 'One-time admin booking override — grants admin-equivalent booking powers on the patient\'s own booking page for their next appointment', required: false })
  adminBookingOverrideEnabled?: boolean;

  @ApiProperty({ description: 'Driving license file path', required: false })
  drivingLicensePath?: string | null;

  @ApiProperty({ description: 'Photo file path', required: false })
  photoPath?: string | null;

  @ApiProperty({ description: 'Welcome order Stripe payment intent ID', required: false })
  welcomeOrderPaymentIntentId?: string | null;

  @ApiProperty({ description: 'DoseSpot patient ID if synced', required: false })
  doseSpotPatientId?: string | null;

  @ApiProperty({ description: 'Creation date' })
  createdAt: Date;

  @ApiProperty({ description: 'Medical form data', required: false })
  medicalForm?: any;
}
