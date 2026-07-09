import { IsOptional, IsString } from 'class-validator';

export class ValidateAddressDto {
  @IsString()
  street: string;

  @IsOptional()
  @IsString()
  secondary?: string; // apt / suite / unit

  @IsString()
  city: string;

  @IsString()
  state: string; // 2-letter code preferred (e.g. "CA")

  @IsString()
  zip: string;
}

export interface StandardizedAddress {
  street: string;
  secondary?: string;
  city: string;
  state: string;
  zip: string;
  zipPlus4?: string;
}

export interface AddressValidationResult {
  valid: boolean;
  source: 'usps' | 'census' | 'none';
  standardized?: StandardizedAddress;
  message: string;
  raw?: unknown;
}

export interface AddressSuggestion {
  label: string; // full display string
  street: string;
  city: string;
  state: string;
  zip: string;
  lat?: string;
  lon?: string;
}
