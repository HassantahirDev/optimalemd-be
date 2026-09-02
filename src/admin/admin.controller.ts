import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { 
  AdminCreatePatientDto, 
  AdminUpdatePatientDto, 
  AdminCreateMedicalFormDto, 
  PatientWithMedicalFormResponseDto 
} from './dto/admin.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Admin - Dashboard')
@Controller('admin/dashboard')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AdminDashboardController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get admin dashboard statistics' })
  @ApiResponse({ status: 200, description: 'Stats retrieved successfully' })
  async getDashboardStats(): Promise<{ success: boolean; statusCode: number; message: string; data: any }> {
    const data = await this.adminService.getDashboardStats();
    return { success: true, statusCode: 200, message: 'Stats retrieved successfully', data };
  }
}

@ApiTags('Admin - Patient Management')
@Controller('admin/patients')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post()
  @ApiOperation({ 
    summary: 'Create Patient (Admin)', 
    description: 'Create a new patient with auto-generated password and optional welcome email' 
  })
  @ApiResponse({ 
    status: 201, 
    description: 'Patient created successfully', 
    type: PatientWithMedicalFormResponseDto 
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 409, description: 'Patient with email already exists' })
  async createPatient(
    @Body() createPatientDto: AdminCreatePatientDto
  ): Promise<{ success: boolean; message: string; data: PatientWithMedicalFormResponseDto }> {
    const patient = await this.adminService.createPatient(createPatientDto);
    
    return {
      success: true,
      message: 'Patient created successfully',
      data: patient
    };
  }

  @Get()
  @ApiOperation({ 
    summary: 'Get All Patients (Admin)', 
    description: 'Retrieve all patients with pagination, search, and filtering' 
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number', example: 1 })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page', example: 50 })
  @ApiQuery({ name: 'search', required: false, description: 'Search by name, email, or phone' })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status', enum: ['active', 'inactive', 'all'] })
  @ApiResponse({ 
    status: 200, 
    description: 'Patients retrieved successfully'
  })
  async getAllPatients(
    @Query() query: any
  ): Promise<{ 
    success: boolean; 
    message: string; 
    data: PatientWithMedicalFormResponseDto[];
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }
  }> {
    const result = await this.adminService.getAllPatients(query);
    
    return {
      success: true,
      message: 'Patients retrieved successfully',
      data: result.data,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: Math.ceil(result.total / result.limit)
      }
    };
  }

  @Get(':id')
  @ApiOperation({ 
    summary: 'Get Patient by ID (Admin)', 
    description: 'Retrieve a specific patient with medical form data' 
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Patient retrieved successfully', 
    type: PatientWithMedicalFormResponseDto 
  })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async getPatientById(
    @Param('id') patientId: string
  ): Promise<{ success: boolean; message: string; data: PatientWithMedicalFormResponseDto }> {
    const patient = await this.adminService.getPatientWithMedicalForm(patientId);
    
    return {
      success: true,
      message: 'Patient retrieved successfully',
      data: patient
    };
  }

  @Put(':id')
  @ApiOperation({ 
    summary: 'Update Patient (Admin)', 
    description: 'Update patient data (excluding medical form data)' 
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ 
    status: 200, 
    description: 'Patient updated successfully', 
    type: PatientWithMedicalFormResponseDto 
  })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async updatePatient(
    @Param('id') patientId: string,
    @Body() updatePatientDto: AdminUpdatePatientDto
  ): Promise<{ success: boolean; message: string; data: PatientWithMedicalFormResponseDto }> {
    const patient = await this.adminService.updatePatient(patientId, updatePatientDto);
    
    return {
      success: true,
      message: 'Patient updated successfully',
      data: patient
    };
  }

  @Patch(':id/premium')
  @ApiOperation({ 
    summary: 'Toggle Premium Status',
    description: 'Update patient premium/subscription status'
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ status: 200, description: 'Premium status updated successfully' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async togglePremiumStatus(
    @Param('id') patientId: string,
    @Body() body: { isPremium: boolean }
  ): Promise<{ success: boolean; message: string; data: PatientWithMedicalFormResponseDto }> {
    const patient = await this.adminService.togglePremiumStatus(patientId, body.isPremium);
    
    return {
      success: true,
      message: `Patient ${body.isPremium ? 'upgraded to' : 'removed from'} premium successfully`,
      data: patient
    };
  }

  @Patch(':id/booking-override')
  @ApiOperation({
    summary: 'Toggle admin booking override',
    description: 'While enabled, this patient\'s own booking page gets admin-equivalent booking powers (any doctor, custom time, no payment) for their next appointment — auto-disables after that one booking.',
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ status: 200, description: 'Booking override updated successfully' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async toggleAdminBookingOverride(
    @Param('id') patientId: string,
    @Body() body: { enabled: boolean },
  ): Promise<{ success: boolean; message: string; data: PatientWithMedicalFormResponseDto }> {
    const patient = await this.adminService.toggleAdminBookingOverride(patientId, body.enabled);

    return {
      success: true,
      message: body.enabled
        ? 'Admin booking override enabled — patient can now book one appointment with admin controls'
        : 'Admin booking override disabled',
      data: patient,
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete Patient (Admin)',
    description: 'Soft delete patient by deactivating account'
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ status: 204, description: 'Patient deleted successfully' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async deletePatient(
    @Param('id') patientId: string
  ): Promise<void> {
    await this.adminService.deletePatient(patientId);
  }

  @Post(':id/resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend Verification Email (Admin)',
    description: 'Resend email verification link to a patient who has not yet verified their email',
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ status: 200, description: 'Verification email sent successfully' })
  @ApiResponse({ status: 400, description: 'Email already verified or no email on record' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async resendPatientVerification(
    @Param('id') patientId: string,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.adminService.resendPatientVerification(patientId);
    return { success: true, message: result.message };
  }

  @Post(':id/reset-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset Patient Credentials (Admin)',
    description: 'Generate a new temporary password for the patient and send a welcome email with verify + login link',
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ status: 200, description: 'New credentials sent successfully' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async resetPatientCredentials(
    @Param('id') patientId: string,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.adminService.resetPatientCredentials(patientId);
    return { success: true, message: result.message };
  }

  @Post(':id/medical-form')
  @ApiOperation({
    summary: 'Create Medical Form (Admin)',
    description: 'Create medical form for a patient'
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ status: 201, description: 'Medical form created successfully' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  @ApiResponse({ status: 409, description: 'Medical form already exists' })
  async createMedicalForm(
    @Param('id') patientId: string,
    @Body() createMedicalFormDto: AdminCreateMedicalFormDto
  ): Promise<{ success: boolean; message: string; data: any }> {
    const medicalForm = await this.adminService.createMedicalForm(patientId, createMedicalFormDto);
    
    return {
      success: true,
      message: 'Medical form created successfully',
      data: medicalForm
    };
  }

  @Put(':id/medical-form')
  @ApiOperation({ 
    summary: 'Update Medical Form (Admin)', 
    description: 'Update medical form for a patient' 
  })
  @ApiParam({ name: 'id', description: 'Patient ID' })
  @ApiResponse({ status: 200, description: 'Medical form updated successfully' })
  @ApiResponse({ status: 404, description: 'Patient or medical form not found' })
  async updateMedicalForm(
    @Param('id') patientId: string,
    @Body() updateMedicalFormDto: Partial<AdminCreateMedicalFormDto>
  ): Promise<{ success: boolean; message: string; data: any }> {
    const medicalForm = await this.adminService.updateMedicalForm(patientId, updateMedicalFormDto);
    
    return {
      success: true,
      message: 'Medical form updated successfully',
      data: medicalForm
    };
  }
}
