import { IsString, IsNotEmpty, IsArray, IsDateString, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateLabOrderDto {
  @ApiProperty({
    description: 'Array of lab test type IDs to include in the order',
    example: ['uuid1', 'uuid2'],
    type: [String],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsNotEmpty()
  testTypeIds: string[];

  @ApiProperty({
    description: 'Scheduled date and time for the lab appointment',
    example: '2026-01-25T10:00:00Z',
  })
  @IsDateString()
  @IsNotEmpty()
  scheduledDate: string;

  @ApiPropertyOptional({
    description: 'Additional notes for the lab order',
    example: 'Fasting required 8 hours before',
  })
  @IsString()
  @IsOptional()
  notes?: string;
}

export class LabTestTypeDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional()
  code?: string;

  @ApiPropertyOptional()
  price?: number;

  @ApiProperty()
  isActive: boolean;
}

export class LabOrderItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  labTestType: LabTestTypeDto;
}

export class LabResultFileDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  fileName: string;

  @ApiPropertyOptional()
  fileSize?: number;

  @ApiPropertyOptional()
  mimeType?: string;

  @ApiProperty()
  createdAt: Date;
}

export class PatientInfoDto {
  @ApiProperty()
  id: string;
  @ApiProperty()
  firstName: string;
  @ApiProperty()
  lastName: string;
  @ApiProperty()
  email: string;
  @ApiPropertyOptional()
  drivingLicensePath?: string | null;
}

export class LabOrderDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  patientId: string;

  @ApiPropertyOptional()
  doctorId?: string;

  @ApiProperty()
  scheduledDate: Date;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional()
  source?: string;

  @ApiPropertyOptional()
  testDate?: Date;

  @ApiPropertyOptional()
  notes?: string;

  @ApiPropertyOptional()
  receiptPath?: string;

  @ApiPropertyOptional()
  receiptFileName?: string;

  @ApiPropertyOptional()
  resultsPath?: string;

  @ApiProperty({ type: [LabOrderItemDto] })
  items: LabOrderItemDto[];

  @ApiPropertyOptional({ type: [LabResultFileDto] })
  resultFiles?: LabResultFileDto[];

  @ApiPropertyOptional({ type: PatientInfoDto })
  patient?: PatientInfoDto;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

