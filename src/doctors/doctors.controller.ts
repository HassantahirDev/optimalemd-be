import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiNotFoundResponse,
  ApiInternalServerErrorResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { DoctorsService } from './doctors.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/user.decorator';
import {
  CreateDoctorDto,
  UpdateDoctorDto,
  QueryDoctorsDto,
  DoctorResponseDto,
  DoctorWithUserResponseDto,
  DoctorWithServicesResponseDto,
  DoctorAvailabilityDto,
  DoctorScheduleDto,
} from './dto';
import { BaseApiResponse, PaginatedApiResponse, SuccessApiResponse } from '../common/dto/api-response.dto';

@ApiTags('doctors')
@Controller('doctors')
// @ApiBearerAuth('JWT-auth')
// @UseGuards(JwtAuthGuard)
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create Doctor Profile',
    description: 'Create a new doctor profile with comprehensive validation.',
  })
  @ApiBody({
    type: CreateDoctorDto,
    description: 'Doctor profile creation data',
    examples: {
      cardiologist: {
        summary: 'Cardiologist Profile',
        description: 'Create a cardiologist profile',
        value: {
          email: 'dr.smith@example.com',
          password: 'securePassword123',
          title: 'Dr',
          firstName: 'John',
          middleName: 'Michael',
          lastName: 'Smith',
          dateOfBirth: '1980-01-01',
          gender: 'Male',
          completeAddress: '123 Main St, Apt 4B',
          city: 'New York',
          state: 'NY',
          zipcode: '10001',
          alternativeEmail: 'john.smith@example.com',
          primaryPhone: '+1-555-123-4567',
          alternativePhone: '+1-555-987-6543',
          licenseNumber: 'MD12345678',
          specialization: 'Cardiology',
          qualifications: ['MBBS', 'MD Cardiology', 'FACC'],
          experience: 15,
          bio: 'Dr. Smith is a board-certified cardiologist with over 15 years of experience...',
          consultationFee: '150.00',
          workingHours: JSON.stringify({
            monday: { start: '09:00', end: '17:00' },
            tuesday: { start: '09:00', end: '17:00' },
            wednesday: { start: '09:00', end: '17:00' },
            thursday: { start: '09:00', end: '17:00' },
            friday: { start: '09:00', end: '17:00' },
            saturday: { start: '09:00', end: '13:00' },
            sunday: { start: '00:00', end: '00:00' }
          })
        } as CreateDoctorDto,
      },
    },
  })
  @ApiOkResponse({
    description: 'Doctor profile created successfully',
    type: BaseApiResponse<DoctorResponseDto>,
    examples: {
      success: {
        summary: 'Doctor Profile Created',
        value: {
          success: true,
          statusCode: 201,
          message: 'Doctor profile created successfully',
          data: {
            id: '123e4567-e89b-12d3-a456-426614174000',
            email: 'dr.smith@example.com',
            title: 'Dr',
            firstName: 'John',
            middleName: 'Michael',
            lastName: 'Smith',
            dateOfBirth: '1980-01-01T00:00:00.000Z',
            gender: 'Male',
            completeAddress: '123 Main St, Apt 4B',
            city: 'New York',
            state: 'NY',
            zipcode: '10001',
            alternativeEmail: 'john.smith@example.com',
            primaryPhone: '+1-555-123-4567',
            alternativePhone: '+1-555-987-6543',
            licenseNumber: 'MD12345678',
            specialization: 'Cardiology',
            qualifications: ['MBBS', 'MD Cardiology', 'FACC'],
            experience: 15,
            bio: 'Dr. Smith is a board-certified cardiologist with over 15 years of experience...',
            isAvailable: true,
            consultationFee: '150.00',
            workingHours: {
              monday: { start: '09:00', end: '17:00' },
              tuesday: { start: '09:00', end: '17:00' },
              wednesday: { start: '09:00', end: '17:00' },
              thursday: { start: '09:00', end: '17:00' },
              friday: { start: '09:00', end: '17:00' },
              saturday: { start: '09:00', end: '13:00' },
              sunday: { start: '00:00', end: '00:00' }
            },
            isActive: true,
            isVerified: false,
            createdAt: '2024-12-20T10:00:00.000Z',
            updatedAt: '2024-12-20T10:00:00.000Z',
          },
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/doctors',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error or business rule violation',
    examples: {
      duplicateLicense: {
        summary: 'Duplicate License',
        value: {
          success: false,
          statusCode: 400,
          message: 'License number is already registered',
          error: 'ConflictError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/doctors',
        },
      },
      invalidWorkingHours: {
        summary: 'Invalid Working Hours',
        value: {
          success: false,
          statusCode: 400,
          message: 'Invalid working hours structure',
          error: 'BadRequestError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/doctors',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error',
  })
  async createDoctor(
    @Body() createDoctorDto: CreateDoctorDto,
  ): Promise<BaseApiResponse<DoctorResponseDto>> {
    const data = await this.doctorsService.createDoctor(createDoctorDto);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Doctor profile created successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/doctors',
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Get Doctors',
    description: 'Retrieve doctors with filtering, pagination, and comprehensive data.',
  })
  @ApiQuery({
    name: 'specialization',
    required: false,
    description: 'Filter by specialization',
    example: 'Cardiology',
  })
  @ApiQuery({
    name: 'city',
    required: false,
    description: 'Filter by city',
    example: 'New York',
  })
  @ApiQuery({
    name: 'state',
    required: false,
    description: 'Filter by state',
    example: 'NY',
  })
  @ApiQuery({
    name: 'isAvailable',
    required: false,
    description: 'Filter by availability',
    type: 'boolean',
  })
  @ApiQuery({
    name: 'isVerified',
    required: false,
    description: 'Filter by verification status',
    type: 'boolean',
  })
  @ApiQuery({
    name: 'serviceId',
    required: false,
    description: 'Filter by service ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page',
    example: 10,
  })
  @ApiOkResponse({
    description: 'Doctors retrieved successfully',
    type: PaginatedApiResponse<DoctorWithUserResponseDto>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error',
  })
  async getDoctors(
    @Query() query: QueryDoctorsDto,
  ): Promise<PaginatedApiResponse<DoctorWithUserResponseDto>> {
    const { doctors, total } = await this.doctorsService.findAll(query);
    const page = query.page || 1;
    const limit = query.limit || 10;
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctors retrieved successfully',
      data: doctors,
      timestamp: new Date().toISOString(),
      path: '/api/doctors',
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search Doctors',
    description: 'Search doctors by specialization, name, or location.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    description: 'Search term',
    example: 'Cardiology',
  })
  @ApiQuery({
    name: 'specialization',
    required: false,
    description: 'Filter by specialization',
    example: 'Cardiology',
  })
  @ApiQuery({
    name: 'city',
    required: false,
    description: 'Filter by city',
    example: 'New York',
  })
  @ApiQuery({
    name: 'serviceId',
    required: false,
    description: 'Filter by service ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Doctors found successfully',
    type: BaseApiResponse<DoctorWithUserResponseDto[]>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async searchDoctors(
    @Query('q') searchTerm: string,
    @Query('specialization') specialization?: string,
    @Query('city') city?: string,
    @Query('serviceId') serviceId?: string,
  ): Promise<BaseApiResponse<DoctorWithUserResponseDto[]>> {
    const filters = { specialization, city, serviceId };
    const data = await this.doctorsService.searchDoctors(searchTerm, filters);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctors found successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/doctors/search',
    };
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get Doctor Statistics',
    description: 'Retrieve comprehensive doctor statistics.',
  })
  @ApiQuery({
    name: 'doctorId',
    required: false,
    description: 'Filter by specific doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Doctor statistics retrieved successfully',
    type: BaseApiResponse<any>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctorStats(
    @Query('doctorId') doctorId?: string,
  ): Promise<BaseApiResponse<any>> {
    const data = await this.doctorsService.getDoctorStats(doctorId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor statistics retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/doctors/stats',
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get Doctor by ID',
    description: 'Retrieve a specific doctor by ID with user information.',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Doctor retrieved successfully',
    type: BaseApiResponse<DoctorWithUserResponseDto>,
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctor(@Param('id') id: string): Promise<BaseApiResponse<DoctorWithUserResponseDto>> {
    const data = await this.doctorsService.findById(id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}`,
    };
  }

  @Get(':id/services')
  @ApiOperation({
    summary: 'Get Doctor with Services',
    description: 'Retrieve a specific doctor with all offered services.',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Doctor with services retrieved successfully',
    type: BaseApiResponse<DoctorWithServicesResponseDto>,
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctorWithServices(@Param('id') id: string): Promise<BaseApiResponse<DoctorWithServicesResponseDto>> {
    const data = await this.doctorsService.findByIdWithServices(id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor with services retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}/services`,
    };
  }

  @Get(':id/availability')
  @ApiOperation({
    summary: 'Get Doctor Availability',
    description: 'Get doctor availability for a specific date.',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'date',
    required: true,
    description: 'Date to check (YYYY-MM-DD)',
    example: '2024-12-25',
  })
  @ApiQuery({
    name: 'serviceId',
    required: false,
    description: 'Service ID for availability check',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Doctor availability retrieved successfully',
    type: BaseApiResponse<any>,
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiBadRequestResponse({
    description: 'Doctor is not available',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctorAvailability(
    @Param('id') id: string,
    @Query('date') date: string,
    @Query('serviceId') serviceId?: string,
  ): Promise<BaseApiResponse<any>> {
    const data = await this.doctorsService.getDoctorAvailability(id, date, serviceId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor availability retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}/availability`,
    };
  }

  @Get(':id/schedule')
  @ApiOperation({
    summary: 'Get Doctor Schedule',
    description: 'Get doctor schedule for a date range.',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'startDate',
    required: true,
    description: 'Start date (YYYY-MM-DD)',
    example: '2024-12-25',
  })
  @ApiQuery({
    name: 'endDate',
    required: true,
    description: 'End date (YYYY-MM-DD)',
    example: '2024-12-31',
  })
  @ApiOkResponse({
    description: 'Doctor schedule retrieved successfully',
    type: BaseApiResponse<any>,
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctorSchedule(
    @Param('id') id: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ): Promise<BaseApiResponse<any>> {
    const data = await this.doctorsService.getDoctorSchedule(id, startDate, endDate);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor schedule retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}/schedule`,
    };
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update Doctor Profile',
    description: 'Update an existing doctor profile with validation.',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    type: UpdateDoctorDto,
    description: 'Doctor profile update data',
  })
  @ApiOkResponse({
    description: 'Doctor profile updated successfully',
    type: BaseApiResponse<DoctorResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Validation error or business rule violation',
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async updateDoctor(
    @Param('id') id: string,
    @Body() updateDoctorDto: UpdateDoctorDto,
  ): Promise<BaseApiResponse<DoctorResponseDto>> {
    const data = await this.doctorsService.updateDoctor(id, updateDoctorDto);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor profile updated successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}`,
    };
  }

  @Post(':id/verify')
  @ApiOperation({
    summary: 'Verify Doctor Profile',
    description: 'Verify a doctor profile (admin only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Doctor profile verified successfully',
    type: BaseApiResponse<DoctorResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Doctor is already verified',
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async verifyDoctor(@Param('id') id: string): Promise<BaseApiResponse<DoctorResponseDto>> {
    const data = await this.doctorsService.verifyDoctor(id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor profile verified successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}/verify`,
    };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete Doctor Profile',
    description: 'Delete a doctor profile (admin only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiResponse({
    status: 204,
    description: 'Doctor profile deleted successfully',
  })
  @ApiBadRequestResponse({
    description: 'Cannot delete doctor with active appointments',
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async deleteDoctor(@Param('id') id: string): Promise<void> {
    await this.doctorsService.deleteDoctor(id);
  }

  @Get(':id/dashboard-stats')
  @ApiOperation({
    summary: 'Get Doctor Dashboard Statistics',
    description: 'Get dashboard statistics for a doctor including appointments, messages, and urgent tasks.',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Dashboard statistics retrieved successfully',
    type: BaseApiResponse<any>,
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDashboardStats(
    @Param('id') id: string,
  ): Promise<BaseApiResponse<any>> {
    const data = await this.doctorsService.getDashboardStats(id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Dashboard statistics retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}/dashboard-stats`,
    };
  }

  @Get(':id/action-center')
  @ApiOperation({
    summary: 'Get Doctor Action Center',
    description: 'Unified, server-aggregated task queue: visits to document, unassigned completed appointments, pending booking requests, unread messages, today\'s schedule, and in-queue patients.',
  })
  @ApiParam({ name: 'id', description: 'Doctor ID' })
  async getActionCenter(
    @Param('id') id: string,
  ): Promise<BaseApiResponse<any>> {
    const data = await this.doctorsService.getActionCenter(id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Action center retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}/action-center`,
    };
  }

  @Get(':id/patients')
  @ApiOperation({
    summary: 'Get Doctor Patients',
    description: 'Get list of patients for a doctor with search and pagination.',
  })
  @ApiParam({
    name: 'id',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by patient name or MRN',
    example: 'John Doe',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page',
    example: 10,
  })
  @ApiOkResponse({
    description: 'Doctor patients retrieved successfully',
    type: BaseApiResponse<any>,
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctorPatients(
    @Param('id') id: string,
    @Query('search') search?: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ): Promise<BaseApiResponse<any>> {
    const data = await this.doctorsService.getDoctorPatients(id, { search, page, limit });
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor patients retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/doctors/${id}/patients`,
    };
  }

  @Put('profile/change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change own password (doctor)' })
  async changePassword(
    @Body() body: { currentPassword: string; newPassword: string },
    @Req() req: any,
  ) {
    const doctorId = req.user.sub || req.user.id;
    const result = await this.doctorsService.changeOwnPassword(doctorId, body.currentPassword, body.newPassword);
    return { success: true, message: result.message };
  }
}
