import { Controller, Get, Post, Body, Param, UseGuards, Request, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { AppointmentQuestionnaireService, QuestionnaireAnswers } from './appointment-questionnaire.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BaseApiResponse } from '../common/dto/api-response.dto';

@ApiTags('Appointment Questionnaire')
@Controller('appointment-questionnaire')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AppointmentQuestionnaireController {
  constructor(private readonly service: AppointmentQuestionnaireService) {}

  /** Which questionnaires the current patient answers (qADAM + IIEF only for male patients). */
  @Get('context')
  @ApiOperation({ summary: 'Questionnaires the current patient answers before booking' })
  async getContext(@Request() req): Promise<BaseApiResponse<any>> {
    const data = await this.service.getContext(req.user.id || req.user.sub);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Questionnaire context retrieved',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointment-questionnaire/context',
    };
  }

  /** The current patient's answers for an appointment, or null if not answered yet. */
  @Get('appointment/:appointmentId')
  @ApiOperation({ summary: 'Get the questionnaire answers for an appointment' })
  @ApiParam({ name: 'appointmentId', description: 'Appointment ID' })
  async getForAppointment(@Request() req, @Param('appointmentId') appointmentId: string): Promise<BaseApiResponse<any>> {
    const data = await this.service.getForAppointment(appointmentId, req.user.id || req.user.sub);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Questionnaire retrieved',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointment-questionnaire/appointment/${appointmentId}`,
    };
  }

  /** Submit (or resubmit) the questionnaires for an appointment before confirming / paying. */
  @Post(':appointmentId')
  @ApiOperation({ summary: 'Submit qADAM / IIEF / PHQ-9 answers for an appointment' })
  @ApiParam({ name: 'appointmentId', description: 'Appointment ID' })
  async submit(
    @Request() req,
    @Param('appointmentId') appointmentId: string,
    @Body() body: QuestionnaireAnswers,
  ): Promise<BaseApiResponse<any>> {
    const data = await this.service.submit(req.user.id || req.user.sub, appointmentId, body);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Questionnaire submitted',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointment-questionnaire/${appointmentId}`,
    };
  }
}
