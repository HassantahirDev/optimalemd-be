import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { StoreViewer, SupplementsService } from './supplements.service';
import { ConfirmSupplementCheckoutDto, CreateSupplementCheckoutDto } from './dto/checkout.dto';

/**
 * Public storefront API: supplements need no prescription, so guests can check
 * out. The optional JWT only identifies a signed-in patient so members get their
 * discount and the order lands in their billing history. Prices are always taken
 * from the server catalogue.
 */
@ApiTags('Supplements Store')
@Controller('supplements')
export class SupplementsController {
  constructor(private readonly supplementsService: SupplementsService) {}

  @Get('products')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'List supplements, their prices and whether the viewer gets member pricing' })
  async listProducts(@Req() req: any) {
    return { success: true, data: await this.supplementsService.listProducts(viewerOf(req)) };
  }

  @Post('checkout')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Create a supplements order and its card PaymentIntent' })
  @ApiResponse({ status: 201, description: 'Order created; returns the PaymentIntent client secret' })
  async createCheckout(@Body() dto: CreateSupplementCheckoutDto, @Req() req: any) {
    return { success: true, data: await this.supplementsService.createCheckout(dto, viewerOf(req)) };
  }

  @Post('checkout/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm a supplements order after the card payment succeeds' })
  async confirmCheckout(@Body() dto: ConfirmSupplementCheckoutDto) {
    return { success: true, data: await this.supplementsService.confirmCheckout(dto.paymentIntentId) };
  }
}

const viewerOf = (req: any): StoreViewer =>
  req.user?.id && req.user?.userType ? { id: req.user.id, userType: req.user.userType } : null;
