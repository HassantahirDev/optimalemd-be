import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MedicationsCombinedService } from './medications-combined.service';

/**
 * Combined active/past medications (old per-appointment flow + new set flow).
 * Used by the patient care view and the doctor chart. A patient can only view
 * their own; doctors/admins may view any patient.
 */
@UseGuards(JwtAuthGuard)
@Controller('medications')
export class MedicationsController {
  constructor(private readonly combined: MedicationsCombinedService) {}

  @Get('combined/:userId')
  getCombined(@Param('userId') userId: string, @Req() req: any) {
    // Patients are locked to their own record; doctors/admins may pass any id.
    const targetUserId = req.user?.userType === 'user' ? req.user.id : userId;
    return this.combined.getCombined(targetUserId);
  }
}
