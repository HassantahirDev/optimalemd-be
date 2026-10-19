import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PartnersService } from './partners.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { CommissionStatus, CommissionType } from '@prisma/client';

/**
 * Admin management of the referral-partner program. Any admin (superadmin or
 * admin) can manage partners, rules and payouts — matches how the rest of the
 * admin surface is gated.
 */
@ApiTags('Admin: Referral Partners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('superadmin', 'admin')
@Controller('admin/partners')
export class PartnersAdminController {
  constructor(private readonly partnersService: PartnersService) {}

  // ─── Partners ────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all referral partners' })
  async list() {
    const data = await this.partnersService.adminListPartners();
    return { success: true, data };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a referral partner (returns a one-time temp password)' })
  async create(@Body() body: { name: string; email: string; companyName?: string; phone?: string }) {
    const data = await this.partnersService.adminCreatePartner(body);
    return { success: true, data };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a partner (activate/deactivate, contact info, payout method)' })
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; isActive?: boolean; companyName?: string; phone?: string; payoutMethod?: string; payoutNotes?: string },
  ) {
    const data = await this.partnersService.adminUpdatePartner(id, body);
    return { success: true, data };
  }

  @Post(':id/reset-password')
  @ApiOperation({ summary: 'Reset a partner\'s password (returns a one-time temp password)' })
  async resetPassword(@Param('id') id: string) {
    const data = await this.partnersService.adminResetPartnerPassword(id);
    return { success: true, data };
  }

  // ─── Commission rules ────────────────────────────────────────────────────

  @Get('commission-rules')
  @ApiOperation({ summary: 'List commission rules (flat and/or percentage, global or per-partner)' })
  async listRules() {
    const data = await this.partnersService.adminListCommissionRules();
    return { success: true, data };
  }

  @Post('commission-rules')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a commission rule' })
  async createRule(
    @Body()
    body: {
      partnerId?: string;
      name: string;
      type: CommissionType;
      flatAmountCents?: number;
      percentBasisPoints?: number;
      serviceKeyword?: string;
    },
  ) {
    const data = await this.partnersService.adminCreateCommissionRule(body);
    return { success: true, data };
  }

  @Put('commission-rules/:id')
  @ApiOperation({ summary: 'Update a commission rule' })
  async updateRule(
    @Param('id') id: string,
    @Body() body: Partial<{ name: string; isActive: boolean; flatAmountCents: number; percentBasisPoints: number; serviceKeyword: string }>,
  ) {
    const data = await this.partnersService.adminUpdateCommissionRule(id, body);
    return { success: true, data };
  }

  // ─── Commissions & payouts ───────────────────────────────────────────────

  @Get('commissions')
  @ApiOperation({ summary: 'List commissions (optionally filter by status/partner)' })
  async listCommissions(@Query('status') status?: CommissionStatus, @Query('partnerId') partnerId?: string) {
    const data = await this.partnersService.adminListCommissions(status, partnerId);
    return { success: true, data };
  }

  @Post('payouts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a manual payout for a batch of OWED commissions' })
  async recordPayout(
    @Body() body: { partnerId: string; commissionIds: string[]; method?: string; reference?: string; note?: string },
  ) {
    const data = await this.partnersService.adminRecordPayout(body.partnerId, body.commissionIds, body);
    return { success: true, data };
  }

  @Get('payouts')
  @ApiOperation({ summary: 'List payout batches' })
  async listPayouts(@Query('partnerId') partnerId?: string) {
    const data = await this.partnersService.adminListPayoutBatches(partnerId);
    return { success: true, data };
  }

  // ─── Payout requests (partner-initiated) ────────────────────────────────

  @Get('payout-requests')
  @ApiOperation({ summary: 'List payout requests, with the partner\'s bank details attached' })
  async listPayoutRequests(@Query('status') status?: 'PENDING' | 'COMPLETED' | 'REJECTED') {
    const data = await this.partnersService.adminListPayoutRequests(status);
    return { success: true, data };
  }

  @Post('payout-requests/:id/fulfill')
  @ApiOperation({ summary: 'Mark a payout request as transferred — pays out everything currently owed for that partner' })
  async fulfillPayoutRequest(
    @Param('id') id: string,
    @Body() body: { method?: string; reference?: string; note?: string },
  ) {
    const data = await this.partnersService.adminFulfillPayoutRequest(id, body || {});
    return { success: true, data };
  }

  @Post('payout-requests/:id/reject')
  @ApiOperation({ summary: 'Reject a payout request' })
  async rejectPayoutRequest(@Param('id') id: string, @Body() body: { note?: string }) {
    const data = await this.partnersService.adminRejectPayoutRequest(id, body?.note);
    return { success: true, data };
  }
}
