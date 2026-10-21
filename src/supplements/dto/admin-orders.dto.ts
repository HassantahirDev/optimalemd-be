import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const FULFILLMENT_STATUSES = ['PENDING', 'SHIPPED', 'DELIVERED'] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

/** Payment-side filter: paid orders are the ones to fulfil, so that's the default. */
export const PAYMENT_FILTERS = ['PAID', 'REFUNDED', 'UNPAID', 'ALL'] as const;

export class ListSupplementOrdersQueryDto {
  @ApiPropertyOptional({ enum: [...FULFILLMENT_STATUSES, 'ALL'] })
  @IsOptional()
  @IsIn([...FULFILLMENT_STATUSES, 'ALL'])
  fulfillment?: FulfillmentStatus | 'ALL';

  @ApiPropertyOptional({ enum: PAYMENT_FILTERS, default: 'PAID' })
  @IsOptional()
  @IsIn(PAYMENT_FILTERS as unknown as string[])
  payment?: (typeof PAYMENT_FILTERS)[number];

  @ApiPropertyOptional({ description: 'Order number, name or email' })
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

export class UpdateFulfillmentDto {
  @ApiProperty({ enum: FULFILLMENT_STATUSES })
  @IsIn(FULFILLMENT_STATUSES as unknown as string[])
  status: FulfillmentStatus;

  @ApiPropertyOptional({ example: 'USPS' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  carrier?: string;

  @ApiPropertyOptional({ example: '9400111202555842761234' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  trackingNumber?: string;
}
