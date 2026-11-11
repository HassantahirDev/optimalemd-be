import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const SHIPMENT_STATUSES = ['LABEL_CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'ALERT', 'UNKNOWN'] as const;
export const MAIL_CLASSES = ['USPS_GROUND_ADVANTAGE', 'PRIORITY_MAIL', 'PRIORITY_MAIL_EXPRESS'] as const;

export class ListShipmentsQueryDto {
  @ApiPropertyOptional({ enum: [...SHIPMENT_STATUSES, 'ALL'] })
  @IsOptional()
  @IsIn([...SHIPMENT_STATUSES, 'ALL'])
  status?: string;

  @ApiPropertyOptional({ description: 'Tracking number, patient name or email' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

class PackageFields {
  @ApiPropertyOptional({ enum: MAIL_CLASSES, default: 'USPS_GROUND_ADVANTAGE' })
  @IsOptional()
  @IsIn(MAIL_CLASSES as unknown as string[])
  mailClass?: string;

  @ApiPropertyOptional({ description: 'Package weight in ounces' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(1120)
  weightOz?: number;

  @ApiPropertyOptional({ default: 9 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(108)
  lengthIn?: number;

  @ApiPropertyOptional({ default: 6 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(108)
  widthIn?: number;

  @ApiPropertyOptional({ default: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.25)
  @Max(108)
  heightIn?: number;
}

export class QuoteShipmentDto extends PackageFields {
  @ApiProperty()
  @IsString()
  @MaxLength(10)
  zipcode!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  declare weightOz: number;
}

export class CreateShipmentDto extends PackageFields {
  @ApiProperty()
  @IsString()
  userId!: string;

  @ApiPropertyOptional({ description: 'Tracking number of a label bought elsewhere (e.g. USPS.com)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  trackingNumber?: string;

  @ApiPropertyOptional({ description: 'Buy the label from USPS through FormaMD instead' })
  @IsOptional()
  @IsBoolean()
  createLabel?: boolean;

  // Address overrides — default to the patient's profile address.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) addressLine1?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) addressLine2?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(10) zipcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() recipientEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
