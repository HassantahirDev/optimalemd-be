import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { AiService } from './ai.service';

@ApiTags('AI')
@Controller('ai/gemini')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Check Gemini Vertex configuration',
    description:
      'Returns the backend Vertex AI config status. Authentication still depends on ADC/service account setup.',
  })
  getStatus() {
    return {
      success: true,
      data: this.aiService.getConfigStatus(),
    };
  }

  @Post('sample')
  @ApiOperation({
    summary: 'Run a sample Gemini prompt through Vertex AI',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          example: 'Write a short welcome message for a telehealth patient.',
        },
      },
      required: ['prompt'],
    },
  })
  async generateSample(@Body() body: { prompt: string }) {
    return {
      success: true,
      data: await this.aiService.generateSample(body.prompt),
    };
  }

  @Get('lab-trends/stored')
  @ApiOperation({
    summary: 'Get stored AI lab-trend analyses (read-only). Patients get their own; clinicians pass ?patientId=',
  })
  async getStoredLabTrends(
    @CurrentUser() user: any,
    @Query('patientId') patientId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    // Patients can only ever see their own trends.
    const targetPatientId = user.userType === 'user' ? user.id : patientId;
    if (!targetPatientId) {
      throw new ForbiddenException('patientId is required');
    }

    let data = await this.aiService.getStoredLabTrendsForPatient(targetPatientId);

    // A patient can't trigger the clinician-only analysis endpoint themselves —
    // if they have real uploaded results but nothing's been analyzed yet, run it
    // for them once here so their dashboard doesn't wait on a doctor to click
    // "Analyze" first. Best-effort: never blocks the response on failure.
    if (user.userType === 'user' && data.length === 0) {
      const triggered = await this.aiService.ensureLabTrendsAnalyzedForPatient(targetPatientId, authorization);
      if (triggered) {
        data = await this.aiService.getStoredLabTrendsForPatient(targetPatientId);
      }
    }

    return {
      success: true,
      data,
    };
  }

  // TEMPORARY (dev/testing): lets a patient force a fresh analysis of their own
  // labs from the dashboard, so changes to the analysis pipeline can be seen
  // without waiting for a clinician to re-run it. Scoped to the caller's own
  // record only — a patient can never target another patient here. Remove
  // along with the "Re-analyze" button on the patient homepage.
  @Post('lab-trends/refresh')
  @ApiOperation({ summary: 'Re-run the calling patient\'s own lab analysis (temporary)' })
  async refreshOwnLabTrends(
    @CurrentUser() user: any,
    @Headers('authorization') authorization?: string,
  ) {
    if (user.userType !== 'user') {
      throw new ForbiddenException('Clinicians should use POST /ai/gemini/lab-trends');
    }
    await this.aiService.ensureLabTrendsAnalyzedForPatient(user.id, authorization, true);
    return {
      success: true,
      data: await this.aiService.getStoredLabTrendsForPatient(user.id),
    };
  }

  @Post('lab-trends')
  @ApiOperation({
    summary: 'Analyze patient lab result trends and insert into doctor assessment note',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        patientId: {
          type: 'string',
          example: 'patient-uuid',
        },
        appointmentId: {
          type: 'string',
          example: 'appointment-uuid',
        },
        force: {
          type: 'boolean',
          example: false,
          description: 'Set true only when a clinician manually requests a fresh Gemini analysis.',
        },
      },
      required: ['patientId', 'appointmentId'],
    },
  })
  async analyzeLabTrends(
    @CurrentUser() user: any,
    @Body() body: { patientId: string; appointmentId: string; force?: boolean },
    @Headers('authorization') authorization?: string,
  ) {
    if (user.userType === 'user') {
      throw new ForbiddenException('Only clinicians can analyze lab trends');
    }

    return {
      success: true,
      data: await this.aiService.analyzeLabTrendsForAppointment(
        body.patientId,
        body.appointmentId,
        authorization,
        Boolean(body.force),
      ),
    };
  }
}
