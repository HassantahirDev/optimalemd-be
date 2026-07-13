import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsDateString, IsEnum, IsNumber, IsBoolean, IsDecimal, Min, MaxLength, IsArray } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { AppointmentStatus, UrgencyLevel, VisitStatus } from '@prisma/client';

export class CreateAppointmentDto {
  @ApiProperty({ description: 'Patient ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsString()
  @IsNotEmpty()
  patientId: string;

  @ApiProperty({ description: 'Doctor ID', example: '123e4567-e89b-12d3-a456-426614174000', required: false })
  @IsOptional()
  @IsString()
  doctorId?: string;

  @ApiProperty({ description: 'Service ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsString()
  @IsNotEmpty()
  serviceId: string;

  @ApiProperty({ description: 'Slot ID', example: '123e4567-e89b-12d3-a456-426614174000', required: false })
  @IsOptional()
  @IsString()
  slotId?: string;

  @ApiProperty({ description: 'Primary Service ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsString()
  @IsNotEmpty()
  primaryServiceId: string;

  @ApiProperty({ description: 'Appointment date (YYYY-MM-DD)', example: '2024-12-25' })
  @IsDateString()
  appointmentDate: string;

  @ApiProperty({ description: 'Appointment time (HH:MM)', example: '09:00' })
  @IsString()
  @IsNotEmpty()
  appointmentTime: string;

  @ApiProperty({ description: 'Selected slot time (HH:MM)', example: '09:00', required: false })
  @IsOptional()
  @IsString()
  selectedSlotTime?: string;

  @ApiProperty({ description: 'Duration in minutes', example: 30, minimum: 15, maximum: 480 })
  @IsNumber()
  @Min(15)
  duration: number;

  @ApiProperty({ description: 'Patient notes', example: 'Experiencing chest pain for the last 2 days', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  patientNotes?: string;

  @ApiProperty({ description: 'Patient symptoms', example: 'Chest pain, shortness of breath', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  symptoms?: string;


  @ApiProperty({ description: 'Appointment amount', example: '150.00' })
  @IsDecimal()
  @IsNotEmpty()
  amount: string;

  @ApiProperty({ description: 'Patient timezone (IANA format, e.g., "America/New_York", "Europe/London")', example: 'America/New_York', required: false })
  @IsOptional()
  @IsString()
  patientTimezone?: string;

  @ApiProperty({
    description: 'Additional medical service IDs selected by the patient (beyond the primary service)',
    example: ['service-id-1', 'service-id-2'],
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  additionalServiceIds?: string[];
}

export class UpdateAppointmentDto {
  @ApiProperty({ description: 'Appointment status', enum: AppointmentStatus, required: false })
  @IsOptional()
  @IsEnum(AppointmentStatus)
  status?: AppointmentStatus;

  @ApiProperty({ description: 'Patient notes', example: 'Updated notes', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  patientNotes?: string;

  @ApiProperty({ description: 'Patient symptoms', example: 'Updated symptoms', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  symptoms?: string;


  @ApiProperty({ description: 'Appointment amount', example: '150.00', required: false })
  @IsOptional()
  @IsDecimal()
  amount?: string;

  @ApiProperty({ description: 'Payment status', example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isPaid?: boolean;

  @ApiProperty({ description: 'Payment method', example: 'Credit Card', required: false })
  @IsOptional()
  @IsString()
  paymentMethod?: string;
}

export class UpdateVisitStatusDto {
  @ApiProperty({ description: 'Clinical visit outcome (null to clear)', enum: VisitStatus, nullable: true, required: false })
  @IsOptional()
  @IsEnum(VisitStatus)
  visitStatus?: VisitStatus | null;

  @ApiProperty({ description: 'Optional note (e.g. reason for no-show)', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  visitStatusNote?: string;
}

export class CheckInDto {
  @ApiProperty({ description: 'true to check in, false to undo', required: false, default: true })
  @IsOptional()
  @IsBoolean()
  checkedIn?: boolean;
}

export class QueryAppointmentsDto {
  @ApiProperty({ description: 'Patient ID filter', required: false })
  @IsOptional()
  @IsString()
  patientId?: string;

  @ApiProperty({ description: 'Doctor ID filter', required: false })
  @IsOptional()
  @IsString()
  doctorId?: string;

  @ApiProperty({ description: 'Service ID filter', required: false })
  @IsOptional()
  @IsString()
  serviceId?: string;

  @ApiProperty({ description: 'Status filter', enum: AppointmentStatus, required: false })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.toUpperCase() : value)
  @IsEnum(AppointmentStatus)
  status?: AppointmentStatus;

  @ApiProperty({ description: 'Start date filter (YYYY-MM-DD)', required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ description: 'End date filter (YYYY-MM-DD)', required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ description: 'Page number', example: 1, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @ApiProperty({ description: 'Items per page', example: 10, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @ApiProperty({ description: "Sort order by date/time: 'asc' (soonest first) or 'desc' (default)", required: false })
  @IsOptional()
  @IsString()
  order?: 'asc' | 'desc';

  @ApiProperty({ description: 'Search term for patient name, doctor name, or service', required: false })
  @IsOptional()
  @IsString()
  search?: string;
}

export class CancelAppointmentDto {
  @ApiProperty({ description: 'Cancellation reason', example: 'Patient requested cancellation', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancellationReason?: string;
}

export class RescheduleAppointmentDto {
  @ApiProperty({ description: 'New slot ID (omit for a custom out-of-slot time)', required: false })
  @IsOptional()
  @IsString()
  newSlotId?: string;

  @ApiProperty({ description: 'Custom new date (YYYY-MM-DD) — required when no newSlotId', required: false })
  @IsOptional()
  @IsDateString()
  newDate?: string;

  @ApiProperty({ description: 'Custom new time (HH:MM, UTC) — required when no newSlotId', required: false })
  @IsOptional()
  @IsString()
  newTime?: string;

  @ApiProperty({ description: 'Custom duration in minutes (out-of-slot reschedule)', required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  duration?: number;

  @ApiProperty({ description: 'Rescheduling reason', example: 'Doctor unavailable', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ description: 'Patient timezone (IANA format, e.g., "America/New_York", "Europe/London")', example: 'America/New_York', required: false })
  @IsOptional()
  @IsString()
  patientTimezone?: string;
}

export class AdminCreateAppointmentDto {
  @ApiProperty({ description: 'Patient ID' })
  @IsString()
  @IsNotEmpty()
  patientId: string;

  @ApiProperty({ description: 'Doctor ID' })
  @IsString()
  @IsNotEmpty()
  doctorId: string;

  @ApiProperty({ description: 'Service ID' })
  @IsString()
  @IsNotEmpty()
  serviceId: string;

  @ApiProperty({ description: 'Primary Service ID (billing/main)' })
  @IsString()
  @IsNotEmpty()
  primaryServiceId: string;

  @ApiProperty({ description: 'Slot ID', required: false })
  @IsOptional()
  @IsString()
  slotId?: string;

  @ApiProperty({ description: 'Appointment date (YYYY-MM-DD)' })
  @IsDateString()
  appointmentDate: string;

  @ApiProperty({ description: 'Appointment time (HH:MM)' })
  @IsString()
  @IsNotEmpty()
  appointmentTime: string;

  @ApiProperty({ description: 'Duration in minutes', example: 30 })
  @Type(() => Number)
  @IsNumber()
  duration: number;

  @ApiProperty({ description: 'Patient notes', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  patientNotes?: string;

  @ApiProperty({ 
    description: 'Patient timezone (IANA format, e.g., "America/New_York")', 
    required: false,
    example: 'America/New_York'
  })
  @IsOptional()
  @IsString()
  patientTimezone?: string;
}

// Response DTOs
export class AppointmentResponseDto {
  @ApiProperty({ description: 'Appointment ID' })
  id: string;

  @ApiProperty({ description: 'Patient ID' })
  patientId: string;

  @ApiProperty({ description: 'Doctor ID', required: false })
  doctorId: string | null;

  @ApiProperty({ description: 'Service ID' })
  serviceId: string;

  @ApiProperty({ description: 'Slot ID', required: false })
  slotId: string | null;

  @ApiProperty({ description: 'Appointment date' })
  appointmentDate: Date;

  @ApiProperty({ description: 'Appointment time' })
  appointmentTime: string;

  @ApiProperty({ description: 'Selected slot time', required: false })
  selectedSlotTime: string | null;

  @ApiProperty({ description: 'Duration in minutes' })
  duration: number;

  @ApiProperty({ description: 'Appointment status', enum: AppointmentStatus })
  status: AppointmentStatus;

  @ApiProperty({ description: 'Patient notes', required: false })
  patientNotes: string | null;

  @ApiProperty({ description: 'Patient symptoms', required: false })
  symptoms: string | null;


  @ApiProperty({ description: 'Appointment amount' })
  amount: string | any; // Allow both string and Decimal

  @ApiProperty({ description: 'Payment status' })
  isPaid: boolean;

  @ApiProperty({ description: 'Payment method', required: false })
  paymentMethod: string | null;

  @ApiProperty({ description: 'Google Meet link for video consultation', required: false })
  googleMeetLink: string | null;

  @ApiProperty({ description: 'Cancellation reason', required: false })
  cancellationReason: string | null;

  @ApiProperty({ description: 'Rescheduled from appointment ID', required: false })
  rescheduledFrom: string | null;

  @ApiProperty({ description: 'Scheduled at timestamp' })
  scheduledAt: Date;

  @ApiProperty({ description: 'Confirmed at timestamp', required: false })
  confirmedAt: Date | null;

  @ApiProperty({ description: 'Cancelled at timestamp', required: false })
  cancelledAt: Date | null;

  @ApiProperty({ description: 'Completed at timestamp', required: false })
  completedAt: Date | null;

  @ApiProperty({ description: 'Created at timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Updated at timestamp' })
  updatedAt: Date;

  @ApiProperty({ description: 'Doctor internal notes', required: false })
  internalNotes?: string | null;

  @ApiProperty({ description: 'Doctor-only assessment notes (not exposed to patients)', required: false })
  drAssessmentNotes?: string | null;

  @ApiProperty({ description: 'Last analyzed lab trend fingerprint', required: false })
  labTrendAnalysisHash?: string | null;

  @ApiProperty({ description: 'Last AI-generated lab trend note block', required: false })
  labTrendAnalysisNote?: string | null;

  @ApiProperty({ description: 'Last lab trend analysis timestamp', required: false })
  labTrendAnalysisAt?: Date | null;

  @ApiProperty({ description: 'Prescribed medications', required: false })
  medications?: any;

  @ApiProperty({ description: 'Generated PDF report path', required: false })
  reportPdfPath?: string | null;

  @ApiProperty({ description: 'Clinical visit outcome', enum: VisitStatus, required: false })
  visitStatus?: VisitStatus | null;

  @ApiProperty({ description: 'Visit status note', required: false })
  visitStatusNote?: string | null;

  @ApiProperty({ description: 'Front-desk check-in timestamp', required: false })
  checkedInAt?: Date | null;

  @ApiProperty({ description: 'User who checked the patient in', required: false })
  checkedInBy?: string | null;

  @ApiProperty({ description: 'Reschedule audit history', required: false })
  rescheduleLogs?: Array<{
    id: string;
    fromDate: Date;
    fromTime: string;
    toDate: Date;
    toTime: string;
    reason?: string | null;
    rescheduledBy?: string | null;
    createdAt: Date;
  }>;
}

export class AppointmentWithRelationsResponseDto extends AppointmentResponseDto {
  @ApiProperty({
    description: 'Patient information',
    additionalProperties: true
  })
  patient: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    primaryEmail: string | null;
    primaryPhone: string | null;
  };

  @ApiProperty({
    description: 'Doctor information',
    additionalProperties: true,
    required: false
  })
  doctor: {
    id: string;
    licenseNumber: string;
    specialization: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;

  @ApiProperty({
    description: 'Service information',
    additionalProperties: true
  })
  service: {
    id: string;
    name: string;
    duration: number;
    category: string;
  };

  @ApiProperty({
    description: 'Slot information',
    additionalProperties: true,
    required: false
  })
  slot: {
    id: string;
    startTime: string;
    endTime: string;
    schedule: {
      date: Date;
    };
  } | null;
}

export class GetAvailableDoctorsDto {
  @ApiProperty({ description: 'Appointment ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsString()
  @IsNotEmpty()
  appointmentId: string;
}

export class AssignDoctorDto {
  @ApiProperty({ description: 'Appointment ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsString()
  @IsNotEmpty()
  appointmentId: string;

  @ApiProperty({ description: 'Doctor ID to assign', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsString()
  @IsNotEmpty()
  doctorId: string;

  @ApiProperty({ description: 'Slot ID to assign', example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsString()
  @IsNotEmpty()
  slotId: string;
}

export class AvailableDoctorDto {
  @ApiProperty({ description: 'Doctor ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ description: 'Doctor first name', example: 'John' })
  firstName: string;

  @ApiProperty({ description: 'Doctor last name', example: 'Doe' })
  lastName: string;

  @ApiProperty({ description: 'Doctor specialization', example: 'Cardiology' })
  specialization: string;

  @ApiProperty({ description: 'Doctor license number', example: 'MD123456' })
  licenseNumber: string;

  @ApiProperty({ description: 'Available slot ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  slotId: string;

  @ApiProperty({ description: 'Slot start time', example: '09:00' })
  slotStartTime: string;

  @ApiProperty({ description: 'Slot end time', example: '09:20' })
  slotEndTime: string;
}
