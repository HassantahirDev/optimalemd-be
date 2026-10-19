import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaymentsPortalService } from './payments-portal.service';

/**
 * Patient-facing billing history. Returns ONLY the authenticated patient's own
 * records — the same unified ledger read the staff portal uses, but scoped to
 * `req.user.id`, so a patient can never see anyone else's billing.
 */
@ApiExcludeController()
@UseGuards(JwtAuthGuard)
@Controller('billing')
export class MeBillingController {
  constructor(private readonly portal: PaymentsPortalService) {}

  @Get('me')
  async myBilling(@Req() req: any) {
    const userId = req.user?.id || req.user?.sub;
    return this.portal.getPatientHistory(userId);
  }
}
