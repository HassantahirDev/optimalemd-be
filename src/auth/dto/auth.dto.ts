import { IsEmail, IsString, MinLength, IsOptional, IsDateString, IsIn, Matches, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseApiResponse } from '../../common/dto/api-response.dto';
import { DoctorResponseDto } from '../../doctors/dto/doctor.dto';

export class LoginDto {
  @ApiProperty({
    description: 'User type (user for patients, doctor for healthcare providers, admin for administrators)',
    example: 'user',
    enum: ['user', 'doctor', 'admin'],
  })
  @IsString()
  @IsIn(['user', 'doctor', 'admin', 'assistant'])
  userType: 'user' | 'doctor' | 'admin' | 'assistant';

  @ApiProperty({
    description: 'Email address (primary email for users, email for doctors)',
    example: 'john.doe@example.com',
    type: String,
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Password (minimum 6 characters)',
    example: 'securepassword123',
    minLength: 6,
    type: String,
  })
  @IsString()
  @MinLength(6)
  password: string;
}

export class RegisterDto {
  // Mandatory Fields (Green in image)
  @ApiProperty({
    description: 'Title (Mr, Mrs, Ms, Dr, Other)',
    example: 'Mr',
    enum: ['Mr', 'Mrs', 'Ms', 'Dr', 'Other'],
  })
  @IsString()
  @IsOptional()
  @IsIn(['Mr', 'Mrs', 'Ms', 'Dr', 'Other'])
  title: string;

  @ApiProperty({
    description: 'User first name',
    example: 'John',
    type: String,
  })
  @IsString()
  firstName: string;

  @ApiProperty({
    description: 'User middle name',
    example: 'Michael',
    type: String,
    required: false,
  })
  @IsOptional()
  @IsString()
  middleName?: string;

  @ApiProperty({
    description: 'User last name',
    example: 'Doe',
    type: String,
  })
  @IsString()
  lastName: string;

  @ApiProperty({
    description: 'User date of birth (YYYY-MM-DD format)',
    example: '1990-01-01',
    type: String,
  })
  @IsDateString()
  dateOfBirth: string;

  @ApiProperty({
    description: 'Gender (Male/Female)',
    example: 'Male',
    enum: ['Male', 'Female'],
  })
  @IsString()
  @IsIn(['Male', 'Female'])
  gender: string;

  @ApiProperty({
    description: 'Complete address (House/Apt, Street)',
    example: '123 Main St, Apt 4B',
    type: String,
  })
  @IsString()
  completeAddress: string;

  @ApiProperty({
    description: 'City',
    example: 'New York',
    type: String,
  })
  @IsString()
  city: string;

  @ApiProperty({
    description: 'State',
    example: 'NY',
    type: String,
  })
  @IsString()
  state: string;

  @ApiProperty({
    description: 'Zipcode',
    example: '10001',
    type: String,
  })
  @IsString()
  zipcode: string;

  @ApiProperty({
    description: 'Primary email address (must be unique)',
    example: 'john.doe@example.com',
    type: String,
  })
  @IsEmail()
  primaryEmail: string;

  @ApiProperty({
    description: 'Alternative email address',
    example: 'john.doe.alternative@example.com',
    type: String,
    required: false,
  })
  @IsOptional()
  alternativeEmail?: string;

  @ApiProperty({
    description: 'Primary phone number',
    example: '+1234567890',
    type: String,
  })
  @IsString()
  primaryPhone: string;

  @ApiProperty({
    description: 'Alternative phone number',
    example: '+1987654321',
    type: String,
    required: false,
  })
  @IsOptional()
  @IsString()
  alternativePhone?: string;

  @ApiPropertyOptional({
    description: 'Emergency contact name',
    example: 'Jane Doe',
    type: String,
  })
  @IsOptional()
  emergencyContactName?: string;

  @ApiProperty({
    description: 'Emergency contact relationship',
    example: 'Spouse',
    type: String,
    required: false,
  })
  @IsOptional()
  emergencyContactRelationship?: string;

  @ApiPropertyOptional({
    description: 'Emergency contact phone number',
    example: '+1234567890',
    type: String,
  })
  @IsOptional()
  emergencyContactPhone?: string;

  @ApiPropertyOptional({
    description: 'Referring source (Online/Friend/Employee)',
    example: 'Online',
    enum: ['Online', 'Friend', 'Employee'],
  })
  @IsOptional()
  referringSource?: string;

  @ApiProperty({
    description: 'Consent for treatment (Y/N)',
    example: 'Y',
    enum: ['Y', 'N'],
  })
  @IsString()
  @IsIn(['Y', 'N'])
  consentForTreatment: string;

  @ApiProperty({
    description: 'HIPAA Privacy Notice Acknowledgment (Y/N)',
    example: 'Y',
    enum: ['Y', 'N'],
  })
  @IsString()
  @IsIn(['Y', 'N'])
  hipaaPrivacyNoticeAcknowledgment: string;

  @ApiProperty({
    description: 'Release of Medical Records Consent (Y/N)',
    example: 'Y',
    enum: ['Y', 'N'],
  })
  @IsString()
  @IsIn(['Y', 'N'])
  releaseOfMedicalRecordsConsent: string;

  @ApiProperty({
    description: 'Preferred method of communication (Phone/Email/Mail)',
    example: 'Email',
    enum: ['Phone', 'Email', 'Mail'],
  })
  @IsString()
  @IsIn(['Phone', 'Email', 'Mail'])
  preferredMethodOfCommunication: string;

  @ApiProperty({
    description: 'Disability/Accessibility needs',
    example: 'None',
    type: String,
    required: false,
  })
  @IsOptional()
  @IsString()
  disabilityAccessibilityNeeds?: string;

  // Optional Fields (Yellow in image)
  @ApiPropertyOptional({
    description: 'Care provider phone number',
    example: '+1234567890',
    type: String,
  })
  @IsOptional()
  @IsString()
  careProviderPhone?: string;

  @ApiPropertyOptional({
    description: 'Last 4 digits of SSN',
    example: '1234',
    minLength: 4,
    maxLength: 4,
  })
  @IsOptional()
  @IsString()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'SSN must be exactly 4 digits' })
  lastFourDigitsSSN?: string;

  @ApiPropertyOptional({
    description: 'Language preference',
    example: 'English',
    type: String,
  })
  @IsOptional()
  @IsString()
  languagePreference?: string;

  @ApiPropertyOptional({
    description: 'Ethnicity/Race',
    example: 'Caucasian',
    type: String,
  })
  @IsOptional()
  @IsString()
  ethnicityRace?: string;

  @ApiPropertyOptional({
    description: 'Primary care physician',
    example: 'Dr. Smith',
    type: String,
  })
  @IsOptional()
  @IsString()
  primaryCarePhysician?: string;

  @ApiPropertyOptional({
    description: 'Insurance provider name',
    example: 'Blue Cross Blue Shield',
    type: String,
  })
  @IsOptional()
  @IsString()
  insuranceProviderName?: string;

  @ApiPropertyOptional({
    description: 'Insurance policy number',
    example: 'POL123456789',
    type: String,
  })
  @IsOptional()
  @IsString()
  insurancePolicyNumber?: string;

  @ApiPropertyOptional({
    description: 'Insurance group number',
    example: 'GRP987654321',
    type: String,
  })
  @IsOptional()
  @IsString()
  insuranceGroupNumber?: string;

  @ApiPropertyOptional({
    description: 'Insurance phone number',
    example: '+18005551234',
    type: String,
  })
  @IsOptional()
  @IsString()
  insurancePhoneNumber?: string;

  @ApiPropertyOptional({
    description: 'Guarantor/Responsible party',
    example: 'John Doe',
    type: String,
  })
  @IsOptional()
  @IsString()
  guarantorResponsibleParty?: string;

  @ApiPropertyOptional({
    description: 'Date of first visit planned (YYYY-MM-DD format)',
    example: '2024-02-15',
    type: String,
  })
  @IsOptional()
  @IsDateString()
  dateOfFirstVisitPlanned?: string;

  @ApiPropertyOptional({
    description: 'Interpreter required (Y/N)',
    example: 'N',
    enum: ['Y', 'N'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['Y', 'N'])
  interpreterRequired?: string;

  @ApiPropertyOptional({
    description: 'Advance directives (Y/N)',
    example: 'N',
    enum: ['Y', 'N'],
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsIn(['Y', 'N'])
  advanceDirectives?: string;

  @ApiProperty({
    description: 'User password (minimum 6 characters)',
    example: 'securepassword123',
    minLength: 6,
    type: String,
  })
  @IsString()
  @MinLength(6)
  password: string;
}

// Forgot Password DTO
export class ForgotPasswordDto {
  @ApiProperty({
    description: 'Email address (primary email for users, email for doctors)',
    example: 'john.doe@example.com',
    type: String,
  })
  @IsEmail()
  email: string;
}

// Reset Password DTO
export class ResetPasswordDto {
  @ApiProperty({
    description: 'Reset token received via email',
    example: 'reset_token_1234567890abcdef',
    type: String,
  })
  @IsString()
  token: string;

  @ApiProperty({
    description: 'Account type (user for patients, doctor for healthcare providers)',
    example: 'user',
    enum: ['user', 'doctor'],
  })
  @IsString()
  @IsIn(['user', 'doctor'])
  accountType: 'user' | 'doctor';

  @ApiProperty({
    description: 'New password (minimum 6 characters)',
    example: 'newpassword123',
    minLength: 6,
    type: String,
  })
  @IsString()
  @MinLength(6)
  newPassword: string;
}

// Update Password DTO
export class UpdatePasswordDto {
  @ApiProperty({
    description: 'Current password for verification',
    example: 'currentpassword123',
    type: String,
  })
  @IsString()
  currentPassword: string;

  @ApiProperty({
    description: 'New password (minimum 6 characters)',
    example: 'newpassword123',
    minLength: 6,
    type: String,
  })
  @IsString()
  @MinLength(6)
  newPassword: string;
}

// Profile Update DTO
export class ProfileUpdateDto {
  @ApiPropertyOptional({
    description: 'Title (Mr, Mrs, Ms, Dr, Other)',
    example: 'Mr',
    enum: ['Mr', 'Mrs', 'Ms', 'Dr', 'Other'],
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsIn(['Mr', 'Mrs', 'Ms', 'Dr', 'Other'])
  title?: string;

  @ApiPropertyOptional({
    description: 'User first name',
    example: 'John',
    type: String,
  })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({
    description: 'User middle name',
    example: 'Michael',
    type: String,
  })
  @IsOptional()
  @IsString()
  middleName?: string;

  @ApiPropertyOptional({
    description: 'User last name',
    example: 'Doe',
    type: String,
  })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({
    description: 'User date of birth (YYYY-MM-DD format)',
    example: '1990-01-01',
    type: String,
  })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    description: 'Gender (Male/Female)',
    example: 'Male',
    enum: ['Male', 'Female'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['Male', 'Female'])
  gender?: string;

  @ApiPropertyOptional({
    description: 'Complete address (House/Apt, Street)',
    example: '123 Main St, Apt 4B',
    type: String,
  })
  @IsOptional()
  @IsString()
  completeAddress?: string;

  @ApiPropertyOptional({
    description: 'City',
    example: 'New York',
    type: String,
  })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({
    description: 'State',
    example: 'NY',
    type: String,
  })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({
    description: 'Zipcode',
    example: '10001',
    type: String,
  })
  @IsOptional()
  @IsString()
  zipcode?: string;

  @ApiPropertyOptional({
    description: 'Alternative email address',
    example: 'john.doe.alternative@example.com',
    type: String,
  })
  @IsOptional()
  @IsEmail()
  alternativeEmail?: string;

  @ApiPropertyOptional({
    description: 'Alternative phone number',
    example: '+1987654321',
    type: String,
  })
  @IsOptional()
  @IsString()
  alternativePhone?: string;

  @ApiPropertyOptional({
    description: 'Emergency contact name',
    example: 'Jane Doe',
    type: String,
  })
  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @ApiPropertyOptional({
    description: 'Emergency contact relationship',
    example: 'Spouse',
    type: String,
  })
  @IsOptional()
  @IsString()
  emergencyContactRelationship?: string;

  @ApiPropertyOptional({
    description: 'Emergency contact phone number',
    example: '+1234567890',
    type: String,
  })
  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  @ApiPropertyOptional({
    description: 'Referring source (Online/Friend/Employee)',
    example: 'Online',
    enum: ['Online', 'Friend', 'Employee'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['Online', 'Friend', 'Employee'])
  referringSource?: string;

  @ApiPropertyOptional({
    description: 'Consent for treatment (Y/N)',
    example: 'Y',
    enum: ['Y', 'N'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['Y', 'N'])
  consentForTreatment?: string;

  @ApiPropertyOptional({
    description: 'HIPAA Privacy Notice Acknowledgment (Y/N)',
    example: 'Y',
    enum: ['Y', 'N'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['Y', 'N'])
  hipaaPrivacyNoticeAcknowledgment?: string;

  @ApiPropertyOptional({
    description: 'Release of Medical Records Consent (Y/N)',
    example: 'Y',
    enum: ['Y', 'N'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['Y', 'N'])
  releaseOfMedicalRecordsConsent?: string;

  @ApiPropertyOptional({
    description: 'Preferred method of communication (Phone/Email/Mail)',
    example: 'Email',
    enum: ['Phone', 'Email', 'Mail'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['Phone', 'Email', 'Mail'])
  preferredMethodOfCommunication?: string;

  @ApiPropertyOptional({
    description: 'Disability/Accessibility needs',
    example: 'None',
    type: String,
  })
  @IsOptional()
  @IsString()
  disabilityAccessibilityNeeds?: string;

  // Optional Fields (Yellow in image)
  @ApiPropertyOptional({
    description: 'Care provider phone number',
    example: '+1234567890',
    type: String,
  })
  @IsOptional()
  @IsString()
  careProviderPhone?: string;

  @ApiPropertyOptional({
    description: 'Last 4 digits of SSN',
    example: '1234',
    minLength: 4,
    maxLength: 4,
  })
  @IsOptional()
  @IsString()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'SSN must be exactly 4 digits' })
  lastFourDigitsSSN?: string;

  @ApiPropertyOptional({
    description: 'Language preference',
    example: 'English',
    type: String,
  })
  @IsOptional()
  @IsString()
  languagePreference?: string;

  @ApiPropertyOptional({
    description: 'Ethnicity/Race',
    example: 'Caucasian',
    type: String,
  })
  @IsOptional()
  @IsString()
  ethnicityRace?: string;

  @ApiPropertyOptional({
    description: 'Primary care physician',
    example: 'Dr. Smith',
    type: String,
  })
  @IsOptional()
  @IsString()
  primaryCarePhysician?: string;

  @ApiPropertyOptional({
    description: 'Insurance provider name',
    example: 'Blue Cross Blue Shield',
    type: String,
  })
  @IsOptional()
  @IsString()
  insuranceProviderName?: string;

  @ApiPropertyOptional({
    description: 'Insurance policy number',
    example: 'POL123456789',
    type: String,
  })
  @IsOptional()
  @IsString()
  insurancePolicyNumber?: string;

  @ApiPropertyOptional({
    description: 'Insurance group number',
    example: 'GRP987654321',
    type: String,
  })
  @IsOptional()
  @IsString()
  insuranceGroupNumber?: string;

  @ApiPropertyOptional({
    description: 'Insurance phone number',
    example: '+18005551234',
    type: String,
  })
  @IsOptional()
  @IsString()
  insurancePhoneNumber?: string;

  @ApiPropertyOptional({
    description: 'Guarantor/Responsible party',
    example: 'John Doe',
    type: String,
  })
  @IsOptional()
  @IsString()
  guarantorResponsibleParty?: string;

  @ApiPropertyOptional({
    description: 'Date of first visit planned (YYYY-MM-DD format)',
    example: '2024-02-15',
    type: String,
  })
  @IsOptional()
  @IsDateString()
  dateOfFirstVisitPlanned?: string;

  @ApiPropertyOptional({
    description: 'Interpreter required (Y/N)',
    example: 'N',
    enum: ['Y', 'N'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['Y', 'N'])
  interpreterRequired?: string;

  @ApiPropertyOptional({
    description: 'Advance directives (Y/N)',
    example: 'N',
    enum: ['Y', 'N'],
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsIn(['Y', 'N'])
  advanceDirectives?: string;
}

// User data structure for responses
export class UserResponseDto {
  @ApiProperty({
    description: 'User unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;



  @ApiProperty({
    description: 'Title',
    example: 'Mr',
    required: false,
  })
  title: string | null;

  @ApiProperty({
    description: 'User first name',
    example: 'John',
    nullable: true,
  })
  firstName: string | null;

  @ApiProperty({
    description: 'User middle name',
    example: 'Michael',
    required: false,
  })
  middleName: string | null;

  @ApiProperty({
    description: 'User last name',
    example: 'Doe',
    nullable: true,
  })
  lastName: string | null;

  @ApiProperty({
    description: 'User date of birth',
    example: '1990-01-01T00:00:00.000Z',
    nullable: true,
  })
  dateOfBirth: Date | null;

  @ApiProperty({
    description: 'Gender',
    example: 'Male',
    nullable: true,
  })
  gender: string | null;

  @ApiProperty({
    description: 'Complete address',
    example: '123 Main St, Apt 4B',
    nullable: true,
  })
  completeAddress: string | null;

  @ApiProperty({
    description: 'City',
    example: 'New York',
    nullable: true,
  })
  city: string | null;

  @ApiProperty({
    description: 'State',
    example: 'NY',
    nullable: true,
  })
  state: string | null;

  @ApiProperty({
    description: 'Zipcode',
    example: '10001',
    nullable: true,
  })
  zipcode: string | null;

  @ApiProperty({
    description: 'Primary email address',
    example: 'john.doe@example.com',
    nullable: true,
  })
  primaryEmail: string | null;

  @ApiProperty({
    description: 'Alternative email address',
    example: 'john.doe.alternative@example.com',
    required: false,
  })
  alternativeEmail: string | null;

  @ApiProperty({
    description: 'Primary phone number',
    example: '+1234567890',
    nullable: true,
  })
  primaryPhone: string | null;

  @ApiProperty({
    description: 'Alternative phone number',
    example: '+1987654321',
    required: false,
  })
  alternativePhone: string | null;

  @ApiProperty({
    description: 'Emergency contact name',
    example: 'Jane Doe',
    required: false,
  })
  emergencyContactName: string | null;

  @ApiProperty({
    description: 'Emergency contact relationship',
    example: 'Spouse',
    required: false,
  })
  emergencyContactRelationship: string | null;

  @ApiProperty({
    description: 'Emergency contact phone number',
    example: '+1234567890',
    required: false,
  })
  emergencyContactPhone: string | null;

  @ApiProperty({
    description: 'Referring source',
    example: 'Online',
    required: false,
  })
  referringSource: string | null;

  @ApiProperty({
    description: 'Consent for treatment',
    example: 'Y',
    nullable: true,
  })
  consentForTreatment: string | null;

  @ApiProperty({
    description: 'HIPAA Privacy Notice Acknowledgment',
    example: 'Y',
    nullable: true,
  })
  hipaaPrivacyNoticeAcknowledgment: string | null;

  @ApiProperty({
    description: 'Release of Medical Records Consent',
    example: 'Y',
    nullable: true,
  })
  releaseOfMedicalRecordsConsent: string | null;

  @ApiProperty({
    description: 'Preferred method of communication',
    example: 'Email',
    nullable: true,
  })
  preferredMethodOfCommunication: string | null;

  @ApiProperty({
    description: 'Disability/Accessibility needs',
    example: 'None',
    required: false,
  })
  disabilityAccessibilityNeeds: string | null;

  @ApiProperty({
    description: 'Care provider phone number',
    example: '+1234567890',
    nullable: true,
  })
  careProviderPhone: string | null;

  @ApiProperty({
    description: 'Last 4 digits of SSN',
    example: '1234',
    nullable: true,
  })
  lastFourDigitsSSN: string | null;

  @ApiProperty({
    description: 'Language preference',
    example: 'English',
    nullable: true,
  })
  languagePreference: string | null;

  @ApiProperty({
    description: 'Ethnicity/Race',
    example: 'Caucasian',
    nullable: true,
  })
  ethnicityRace: string | null;

  @ApiProperty({
    description: 'Primary care physician',
    example: 'Dr. Smith',
    nullable: true,
  })
  primaryCarePhysician: string | null;

  @ApiProperty({
    description: 'Insurance provider name',
    example: 'Blue Cross Blue Shield',
    nullable: true,
  })
  insuranceProviderName: string | null;

  @ApiProperty({
    description: 'Insurance policy number',
    example: 'POL123456789',
    nullable: true,
  })
  insurancePolicyNumber: string | null;

  @ApiProperty({
    description: 'Insurance group number',
    example: 'GRP987654321',
    nullable: true,
  })
  insuranceGroupNumber: string | null;

  @ApiProperty({
    description: 'Insurance phone number',
    example: '+18005551234',
    nullable: true,
  })
  insurancePhoneNumber: string | null;

  @ApiProperty({
    description: 'Guarantor/Responsible party',
    example: 'John Doe',
    nullable: true,
  })
  guarantorResponsibleParty: string | null;

  @ApiProperty({
    description: 'Date of registration',
    example: '2024-01-01T00:00:00.000Z',
  })
  dateOfRegistration: Date;

  @ApiProperty({
    description: 'Date of first visit planned',
    example: '2024-02-15T00:00:00.000Z',
    nullable: true,
  })
  dateOfFirstVisitPlanned: Date | null;

  @ApiProperty({
    description: 'Interpreter required',
    example: 'N',
    nullable: true,
  })
  interpreterRequired: string | null;

  @ApiProperty({
    description: 'Advance directives',
    example: 'N',
    nullable: true,
  })
  advanceDirectives: string | null;

  @ApiProperty({
    description: 'Whether the user account is active',
    example: true,
  })
  isActive: boolean;

  @ApiProperty({
    description: 'Account creation timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  updatedAt: Date;
}

// Admin Response DTO
export class AdminResponseDto {
  @ApiProperty({ description: 'Admin ID', example: 'uuid-string' })
  id: string;

  @ApiProperty({ description: 'First name', example: 'Admin' })
  firstName: string;

  @ApiProperty({ description: 'Last name', example: 'User' })
  lastName: string;

  @ApiProperty({ description: 'Email', example: 'admin@example.com' })
  email: string;

  @ApiProperty({ description: 'Phone', example: '+1234567890' })
  phone?: string;

  @ApiProperty({ description: 'Profile picture URL', example: 'https://example.com/avatar.jpg' })
  profilePicture?: string;

  @ApiProperty({ description: 'Role', example: 'superadmin' })
  role: string;

  @ApiProperty({ description: 'Permissions array', example: ['manage_users', 'manage_appointments'] })
  permissions: string[];

  @ApiProperty({ description: 'Is active', example: true })
  isActive: boolean;

  @ApiProperty({ description: 'Is email verified', example: true })
  isEmailVerified: boolean;

  @ApiProperty({ description: 'Last login at', example: '2024-01-01T00:00:00.000Z' })
  lastLoginAt?: Date;

  @ApiProperty({ description: 'Created at', example: '2024-01-01T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ description: 'Updated at', example: '2024-01-01T00:00:00.000Z' })
  updatedAt: Date;
}

// Authentication response data
export class AuthResponseDataDto {
  @ApiProperty({
    description: 'JWT access token for authentication',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Patient information (when userType is user)',
    type: UserResponseDto,
    required: false,
  })
  user?: UserResponseDto;

  @ApiProperty({
    description: 'Doctor information (when userType is doctor)',
    type: DoctorResponseDto,
    required: false,
  })
  doctor?: DoctorResponseDto;

  @ApiProperty({
    description: 'Admin information (when userType is admin)',
    type: AdminResponseDto,
    required: false,
  })
  admin?: AdminResponseDto;

  @ApiProperty({
    description: 'Type of authenticated account',
    example: 'user',
    enum: ['user', 'doctor', 'admin'],
  })
  userType: 'user' | 'doctor' | 'admin';
}

// Authentication response wrapper
export class AuthResponseDto extends BaseApiResponse<AuthResponseDataDto> {}

// Password reset response data
export class PasswordResetResponseDataDto {
  @ApiProperty({
    description: 'Success message',
    example: 'Password reset email sent successfully',
  })
  message: string;

  @ApiProperty({
    description: 'Email address where reset link was sent',
    example: 'john.doe@example.com',
  })
  email: string;
}


// Password reset response wrapper
export class PasswordResetResponseDto extends BaseApiResponse<PasswordResetResponseDataDto> {}

// Password update response data
export class PasswordUpdateResponseDataDto {
  @ApiProperty({
    description: 'Success message',
    example: 'Password updated successfully',
  })
  message: string;

  @ApiProperty({
    description: 'User information after password update',
    type: UserResponseDto,
  })
  user: UserResponseDto;
}

// Password update response wrapper
export class PasswordUpdateResponseDto extends BaseApiResponse<PasswordUpdateResponseDataDto> {}
