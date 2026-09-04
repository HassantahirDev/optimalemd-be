import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PartnersService } from './partners.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PartnerGuard } from '../auth/guards/partner.guard';

@ApiTags('Referral Partners')
@Controller('partners')
export class PartnersController {
  constructor(private readonly partnersService: PartnersService) {}

  /**
   * Public — called by the tracking snippet on any page carrying ?ref=CODE.
   * Never throws on a bad/unknown code; the page must never break for a visitor.
   */
  @Post('track-visit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a partner-link click (public, called by the tracking snippet)' })
  async trackVisit(
    @Body()
    body: {
      code: string;
      visitorId: string;
      landingUrl?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
    },
  ) {
    const result = await this.partnersService.trackVisit(body);
    return { success: true, ...result };
  }

  // ─── Partner portal (partners.formamd.com) ──────────────────────────────

  @Get('me')
  @UseGuards(JwtAuthGuard, PartnerGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current partner profile' })
  async getMe(@Req() req: any) {
    const data = await this.partnersService.getMe(req.user.id);
    return { success: true, data };
  }

  @Get('me/stats')
  @UseGuards(JwtAuthGuard, PartnerGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Partner performance summary' })
  async getStats(@Req() req: any) {
    const data = await this.partnersService.getStats(req.user.id);
    return { success: true, data };
  }

  @Get('me/referrals')
  @UseGuards(JwtAuthGuard, PartnerGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Partner referral list (clicks -> signups -> qualified)' })
  async getReferrals(@Req() req: any, @Query('page') page?: string, @Query('limit') limit?: string) {
    const data = await this.partnersService.getReferrals(req.user.id, Number(page) || 1, Number(limit) || 20);
    return { success: true, ...data };
  }

  @Get('me/commissions')
  @UseGuards(JwtAuthGuard, PartnerGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Partner commission list (owed + paid)' })
  async getCommissions(@Req() req: any, @Query('page') page?: string, @Query('limit') limit?: string) {
    const data = await this.partnersService.getCommissions(req.user.id, Number(page) || 1, Number(limit) || 20);
    return { success: true, ...data };
  }

  @Put('me/bank-details')
  @UseGuards(JwtAuthGuard, PartnerGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set/update the partner\'s US bank details (for manual ACH payout)' })
  async updateBankDetails(
    @Req() req: any,
    @Body()
    body: {
      bankAccountHolderName: string;
      bankName: string;
      bankAccountType: 'checking' | 'savings';
      bankRoutingNumber: string;
      bankAccountNumber: string;
    },
  ) {
    const data = await this.partnersService.updateBankDetails(req.user.id, body);
    return { success: true, data };
  }

  @Post('me/payout-requests')
  @UseGuards(JwtAuthGuard, PartnerGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a payout of whatever is currently owed' })
  async requestPayout(@Req() req: any, @Body() body: { note?: string }) {
    const data = await this.partnersService.requestPayout(req.user.id, body?.note);
    return { success: true, data };
  }

  @Get('me/payout-requests')
  @UseGuards(JwtAuthGuard, PartnerGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Partner\'s own payout request history' })
  async getPayoutRequests(@Req() req: any) {
    const data = await this.partnersService.getPayoutRequests(req.user.id);
    return { success: true, data };
  }

  @Post('me/change-password')
  @UseGuards(JwtAuthGuard, PartnerGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Partner changes their own password (forced on first login)' })
  async changePassword(@Req() req: any, @Body() body: { currentPassword: string; newPassword: string }) {
    await this.partnersService.changeOwnPassword(req.user.id, body.currentPassword, body.newPassword);
    return { success: true };
  }
}
