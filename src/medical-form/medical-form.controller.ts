import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { MedicalFormService } from './medical-form.service';
import { CreateMedicalFormDto, MedicalFormResponseDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Medical Form')
@Controller('medical-form')
export class MedicalFormController {
  constructor(private readonly medicalFormService: MedicalFormService) {}

  @Post(':appointmentId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create medical consultation form for appointment' })
  @ApiParam({ name: 'appointmentId', description: 'Appointment ID' })
  @ApiResponse({ status: 201, description: 'Medical form created successfully', type: MedicalFormResponseDto })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 404, description: 'Patient or appointment not found' })
  @ApiResponse({ status: 409, description: 'Medical form already exists for this appointment' })
  async createMedicalForm(
    @Request() req: any,
    @Param('appointmentId') appointmentId: string,
    @Body() createMedicalFormDto: CreateMedicalFormDto
  ): Promise<{ success: boolean; message: string; data: MedicalFormResponseDto }> {
    const patientId = req.user.id;
    
    const medicalForm = await this.medicalFormService.createMedicalForm(patientId, appointmentId, createMedicalFormDto);
    
    return {
      success: true,
      message: 'Medical form created successfully',
      data: medicalForm
    };
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get medical form for current patient' })
  @ApiResponse({ status: 200, description: 'Medical form retrieved successfully', type: MedicalFormResponseDto })
  @ApiResponse({ status: 404, description: 'Medical form not found' })
  async getMedicalForm(@Request() req: any): Promise<{ success: boolean; message: string; data: MedicalFormResponseDto }> {
    const patientId = req.user.id;
    
    const medicalForm = await this.medicalFormService.getMedicalFormByPatientId(patientId);
    
    return {
      success: true,
      message: 'Medical form retrieved successfully',
      data: medicalForm
    };
  }

  @Put()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update medical consultation form' })
  @ApiResponse({ status: 200, description: 'Medical form updated successfully', type: MedicalFormResponseDto })
  @ApiResponse({ status: 404, description: 'Medical form not found' })
  async updateMedicalForm(
    @Request() req: any,
    @Body() updateData: Partial<CreateMedicalFormDto>
  ): Promise<{ success: boolean; message: string; data: MedicalFormResponseDto }> {
    const patientId = req.user.id;
    
    const medicalForm = await this.medicalFormService.updateMedicalFormByPatientId(patientId, updateData);
    
    return {
      success: true,
      message: 'Medical form updated successfully',
      data: medicalForm
    };
  }

  @Put(':appointmentId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update medical consultation form by appointment ID' })
  @ApiParam({ name: 'appointmentId', description: 'Appointment ID' })
  @ApiResponse({ status: 200, description: 'Medical form updated successfully', type: MedicalFormResponseDto })
  @ApiResponse({ status: 404, description: 'Medical form not found' })
  async updateMedicalFormByAppointmentId(
    @Param('appointmentId') appointmentId: string,
    @Body() updateData: Partial<CreateMedicalFormDto>
  ): Promise<{ success: boolean; message: string; data: MedicalFormResponseDto }> {
    const medicalForm = await this.medicalFormService.updateMedicalFormByAppointmentId(appointmentId, updateData);
    
    return {
      success: true,
      message: 'Medical form updated successfully',
      data: medicalForm
    };
  }

  @Delete()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete medical consultation form' })
  @ApiResponse({ status: 204, description: 'Medical form deleted successfully' })
  @ApiResponse({ status: 404, description: 'Medical form not found' })
  async deleteMedicalForm(@Request() req: any): Promise<{ success: boolean; message: string }> {
    const patientId = req.user.id;
    
    await this.medicalFormService.deleteMedicalForm(patientId);
    
    return {
      success: true,
      message: 'Medical form deleted successfully'
    };
  }

  @Get('completion-status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Check if patient has completed medical form' })
  @ApiResponse({ status: 200, description: 'Form completion status retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async checkFormCompletion(@Request() req: any): Promise<{ 
    success: boolean; 
    message: string; 
    data: { hasCompletedForm: boolean; completedAt?: Date } 
  }> {
    const patientId = req.user.id;
    
    const status = await this.medicalFormService.checkFormCompletion(patientId);
    
    return {
      success: true,
      message: 'Form completion status retrieved successfully',
      data: status
    };
  }

  @Get('biometrics-history')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: "Weight/BMI history for the signed-in patient, newest visit first" })
  async getMyBiometricsHistory(@Request() req: any) {
    const patientId = req.user?.id || req.user?.sub;
    return {
      success: true,
      message: 'Biometrics history retrieved successfully',
      data: await this.medicalFormService.getBiometricsHistory(patientId),
    };
  }

  @Get('biometrics-history/:patientId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: "Weight/BMI history for a patient (clinician access)" })
  async getBiometricsHistoryForPatient(@Param('patientId') patientId: string) {
    return {
      success: true,
      message: 'Biometrics history retrieved successfully',
      data: await this.medicalFormService.getBiometricsHistory(patientId),
    };
  }

  @Get('patient/:patientId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get medical form for specific patient (Doctor access)' })
  @ApiResponse({ status: 200, description: 'Medical form retrieved successfully', type: MedicalFormResponseDto })
  @ApiResponse({ status: 404, description: 'Medical form not found' })
  async getMedicalFormByPatientId(@Param('patientId') patientId: string): Promise<{ 
    success: boolean; 
    message: string; 
    data: MedicalFormResponseDto 
  }> {
    const medicalForm = await this.medicalFormService.getMedicalFormByPatientId(patientId);
    
    return {
      success: true,
      message: 'Medical form retrieved successfully',
      data: medicalForm
    };
  }

  @Put('patient/:patientId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update medical form for specific patient (Admin access)' })
  @ApiResponse({ status: 200, description: 'Medical form updated successfully', type: MedicalFormResponseDto })
  @ApiResponse({ status: 404, description: 'Medical form not found' })
  async updateMedicalFormByPatientId(
    @Param('patientId') patientId: string,
    @Body() updateData: Partial<CreateMedicalFormDto>
  ): Promise<{ 
    success: boolean; 
    message: string; 
    data: MedicalFormResponseDto 
  }> {
    const medicalForm = await this.medicalFormService.updateMedicalFormByPatientId(patientId, updateData);
    
    return {
      success: true,
      message: 'Medical form updated successfully',
      data: medicalForm
    };
  }

  @Post('resend-email')
  @ApiOperation({ summary: 'Resend medical form email to patient' })
  @ApiResponse({ status: 200, description: 'Medical form email sent successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async resendMedicalFormEmail(@Body() body: { email: string; name: string }): Promise<{ 
    success: boolean; 
    message: string 
  }> {
    await this.medicalFormService.resendMedicalFormEmail(body.email, body.name);
    
    return {
      success: true,
      message: 'Medical form email sent successfully'
    };
  }
}
