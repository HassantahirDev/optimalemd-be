import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AddressService } from './address.service';
import {
  AddressSuggestion,
  AddressValidationResult,
  ValidateAddressDto,
} from './dto/address.dto';

// NOTE: intentionally public (no JwtAuthGuard) so the address flow works on
// the signup pages and the standalone test page before a user is authenticated.
@Controller('address')
export class AddressController {
  constructor(private readonly addressService: AddressService) {}

  @Get('autocomplete')
  async autocomplete(
    @Query('q') q: string,
  ): Promise<{ suggestions: AddressSuggestion[] }> {
    const suggestions = await this.addressService.autocomplete(q || '');
    return { suggestions };
  }

  @Post('validate')
  async validate(
    @Body() dto: ValidateAddressDto,
  ): Promise<AddressValidationResult> {
    return this.addressService.validate(dto);
  }
}
