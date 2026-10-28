import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_QTY_PER_ITEM } from '../supplements.catalog';

export class CheckoutItemDto {
  @ApiProperty({ example: 'intramax' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  slug: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_QTY_PER_ITEM)
  quantity: number;
}

export class ShippingAddressDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) line1: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) city: string;

  @ApiProperty({ example: 'TX', description: 'Two-letter US state code' })
  @Matches(/^[A-Z]{2}$/, { message: 'state must be a two-letter US state code' })
  state: string;

  @ApiProperty({ example: '75201' })
  @Matches(/^\d{5}(-\d{4})?$/, { message: 'postalCode must be a valid US ZIP code' })
  postalCode: string;
}

export class CreateSupplementCheckoutDto {
  @ApiProperty({ type: [CheckoutItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items: CheckoutItemDto[];

  @ApiProperty() @IsEmail() @MaxLength(200) email: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) firstName: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) lastName: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;

  @ApiProperty({ type: ShippingAddressDto })
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shipping: ShippingAddressDto;
}

export class ConfirmSupplementCheckoutDto {
  @ApiProperty({ example: 'pi_123' })
  @IsString()
  @Matches(/^pi_[A-Za-z0-9]+$/)
  paymentIntentId: string;
}
