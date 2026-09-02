import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
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
import { AppointmentsService } from './appointments.service';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/user.decorator';
import {
  CreateAppointmentDto,
  UpdateAppointmentDto,
  UpdateVisitStatusDto,
  CheckInDto,
  QueryAppointmentsDto,
  CancelAppointmentDto,
  RescheduleAppointmentDto,
  AppointmentResponseDto,
  AppointmentWithRelationsResponseDto,
  AdminCreateAppointmentDto,
  PatientOverrideBookingDto,
} from './dto';
import {
  CreateBookingDto,
  RespondToBookingDto,
  BookingResponseDto,
  BookingWithRelationsResponseDto,
} from './dto';
import { BaseApiResponse, PaginatedApiResponse, SuccessApiResponseWithData } from '../common/dto/api-response.dto';

function omitDrAssessmentNotesForPatientUser<T extends Record<string, unknown>>(
  entity: T,
  user: { userType?: string } | undefined,
): T {
  if (!entity || user?.userType !== 'user') {
    return entity;
  }
  const {
    drAssessmentNotes: _omitDrAssessmentNotes,
    labTrendAnalysisHash: _omitLabTrendAnalysisHash,
    labTrendAnalysisNote: _omitLabTrendAnalysisNote,
    labTrendAnalysisAt: _omitLabTrendAnalysisAt,
    ...rest
  } = entity;
  return rest as T;
}

function omitDrAssessmentNotesForPatientUserList<T extends Record<string, unknown>>(
  items: T[],
  user: { userType?: string } | undefined,
): T[] {
  if (user?.userType !== 'user') {
    return items;
  }
  return items.map((row) => omitDrAssessmentNotesForPatientUser(row, user));
}

@ApiTags('appointments')
@Controller('appointments')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AppointmentsController {
  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly bookingsService: BookingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create Appointment',
    description: 'Create a new appointment with comprehensive validation and conflict checking.',
  })
  @ApiBody({
    type: CreateAppointmentDto,
    description: 'Appointment creation data',
    examples: {
      generalConsultation: {
        summary: 'General Consultation',
        description: 'Book a general consultation appointment',
        value: {
          patientId: '123e4567-e89b-12d3-a456-426614174000',
          doctorId: '123e4567-e89b-12d3-a456-426614174001',
          serviceId: '123e4567-e89b-12d3-a456-426614174002',
          slotId: '123e4567-e89b-12d3-a456-426614174003',
          appointmentDate: '2024-12-25',
          appointmentTime: '09:00',
          duration: 30,
          amount: '150.00',
          patientNotes: 'Experiencing chest pain for the last 2 days',
          symptoms: 'Chest pain, shortness of breath'
        } as CreateAppointmentDto,
      },
    },
  })
  @ApiOkResponse({
    description: 'Appointment created successfully',
    type: BaseApiResponse<AppointmentResponseDto>,
    examples: {
      success: {
        summary: 'Appointment Created',
        value: {
          success: true,
          statusCode: 201,
          message: 'Appointment created successfully',
          data: {
            id: '123e4567-e89b-12d3-a456-426614174000',
            patientId: '123e4567-e89b-12d3-a456-426614174001',
            doctorId: '123e4567-e89b-12d3-a456-426614174002',
            serviceId: '123e4567-e89b-12d3-a456-426614174003',
            slotId: '123e4567-e89b-12d3-a456-426614174004',
            appointmentDate: '2024-12-25T00:00:00.000Z',
            appointmentTime: '09:00',
            duration: 30,
            status: 'PENDING',
            amount: '150.00',
            isPaid: false,
            scheduledAt: '2024-12-20T10:00:00.000Z',
            createdAt: '2024-12-20T10:00:00.000Z',
            updatedAt: '2024-12-20T10:00:00.000Z',
          },
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/appointments',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error or business rule violation',
    examples: {
      pastDate: {
        summary: 'Past Date',
        value: {
          success: false,
          statusCode: 400,
          message: 'Appointment date and time cannot be in the past',
          error: 'BadRequestError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/appointments',
        },
      },
      doubleBooking: {
        summary: 'Double Booking',
        value: {
          success: false,
          statusCode: 400,
          message: 'Doctor already has an appointment at this time',
          error: 'ConflictError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/appointments',
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
  async createAppointment(
    @Body() createAppointmentDto: CreateAppointmentDto,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.createAppointment(createAppointmentDto);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Appointment created successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments',
    };
  }

  @Get('unassigned')
  @ApiOperation({ summary: 'Get unassigned appointments (no doctor and no slot)' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'] })
  @ApiOkResponse({ description: 'Unassigned appointments retrieved successfully' })
  async getUnassignedAppointments(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
  ): Promise<BaseApiResponse<any[]>> {
    const data = await this.appointmentsService.getUnassignedAppointments({ page, limit, status });
    return {
      success: true,
      statusCode: 200,
      message: 'Unassigned appointments retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/unassigned',
    };
  }

  @Post('temporary')
  @ApiOperation({
    summary: 'Create Temporary Appointment',
    description: 'Create a temporary appointment for payment processing.',
  })
  @ApiBody({
    type: CreateAppointmentDto,
    description: 'Temporary appointment creation data',
  })
  @ApiOkResponse({
    description: 'Temporary appointment created successfully',
    type: BaseApiResponse<AppointmentResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Bad request - validation failed or business rule violation',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async createTemporaryAppointment(
    @Body() createAppointmentDto: CreateAppointmentDto,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.createTemporaryAppointment(createAppointmentDto);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Temporary appointment created successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/temporary',
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Get Appointments',
    description: 'Retrieve appointments with filtering, pagination, and comprehensive data.',
  })
  @ApiQuery({
    name: 'patientId',
    required: false,
    description: 'Filter by patient ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'doctorId',
    required: false,
    description: 'Filter by doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'serviceId',
    required: false,
    description: 'Filter by service ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by appointment status',
    enum: ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'],
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Filter by start date (YYYY-MM-DD)',
    example: '2024-12-01',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'Filter by end date (YYYY-MM-DD)',
    example: '2024-12-31',
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
    description: 'Appointments retrieved successfully',
    type: PaginatedApiResponse<AppointmentWithRelationsResponseDto>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  @ApiInternalServerErrorResponse({
    description: 'Internal server error',
  })
  async getAppointments(
    @Query() query: QueryAppointmentsDto,
  ): Promise<PaginatedApiResponse<AppointmentWithRelationsResponseDto>> {
    const { appointments, total } = await this.appointmentsService.findAll(query);
    const page = query.page || 1;
    const limit = query.limit || 10;
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Appointments retrieved successfully',
      data: appointments,
      timestamp: new Date().toISOString(),
      path: '/api/appointments',
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

  @Get('my-pending-unpaid')
  @ApiOperation({
    summary: 'Get current patient pending unpaid appointment',
    description: 'Returns the most recent PENDING + unpaid appointment created within the last 60 minutes for the authenticated patient, or null if none.',
  })
  async getMyPendingUnpaid(
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<any>> {
    const patientId = user.id || user.sub;
    const data = await this.appointmentsService.getPendingUnpaidAppointment(patientId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: data ? 'Pending unpaid appointment found' : 'No pending unpaid appointment',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/my-pending-unpaid',
    };
  }

  // NOTE: these two routes MUST stay declared before 'patient/:patientId' below —
  // Nest/Express match routes in declaration order, so a param route like
  // 'patient/:patientId' greedily captures literal segments (e.g. 'override-status')
  // registered after it, and this handler would never be reached.
  @Get('patient/override-status')
  @ApiOperation({ summary: 'Patient: check whether admin booking override is currently enabled for me' })
  async getOverrideStatus(@CurrentUser() user: any) {
    return { success: true, data: { enabled: !!user?.adminBookingOverrideEnabled } };
  }

  @Post('patient/create-with-override')
  @ApiOperation({
    summary: 'Patient: book using an admin-granted one-time override',
    description:
      'Same underlying flow as admin/create-confirmed (any doctor, custom out-of-slot time, no payment) — only usable when an admin has enabled adminBookingOverrideEnabled for this patient. Consumed automatically after one successful booking.',
  })
  @ApiOkResponse({ description: 'Appointment created', type: BaseApiResponse<AppointmentResponseDto> })
  async createWithAdminOverride(
    @CurrentUser() user: any,
    @Body() dto: PatientOverrideBookingDto,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    if (user?.userType !== 'user') {
      throw new ForbiddenException('Only patients can use this endpoint.');
    }
    const data = await this.appointmentsService.createWithAdminOverride(user.id, dto);
    return {
      success: true,
      statusCode: 201,
      message: 'Appointment created successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/patient/create-with-override',
    };
  }

  @Get('patient/:patientId')
  @ApiOperation({
    summary: 'Get Patient Appointments',
    description: 'Retrieve appointments for a specific patient.',
  })
  @ApiParam({
    name: 'patientId',
    description: 'Patient ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Patient appointments retrieved successfully',
    type: PaginatedApiResponse<AppointmentWithRelationsResponseDto>,
  })
  @ApiNotFoundResponse({
    description: 'Patient not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getPatientAppointments(
    @Param('patientId') patientId: string,
    @Query() query: QueryAppointmentsDto,
    @CurrentUser() user: any,
  ): Promise<PaginatedApiResponse<AppointmentWithRelationsResponseDto>> {
    const { appointments, total } = await this.appointmentsService.getPatientAppointments(patientId, query);
    const page = query.page || 1;
    const limit = query.limit || 10;
    const totalPages = Math.ceil(total / limit);
    const data = omitDrAssessmentNotesForPatientUserList(appointments as any[], user);

    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Patient appointments retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/patient/${patientId}`,
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

  @Get('doctor/:doctorId')
  @ApiOperation({
    summary: 'Get Doctor Appointments',
    description: 'Retrieve appointments for a specific doctor.',
  })
  @ApiParam({
    name: 'doctorId',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Doctor appointments retrieved successfully',
    type: PaginatedApiResponse<AppointmentWithRelationsResponseDto>,
  })
  @ApiNotFoundResponse({
    description: 'Doctor not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctorAppointments(
    @Param('doctorId') doctorId: string,
    @Query() query: QueryAppointmentsDto,
  ): Promise<PaginatedApiResponse<AppointmentWithRelationsResponseDto>> {
    const { appointments, total } = await this.appointmentsService.getDoctorAppointments(doctorId, query);
    const page = query.page || 1;
    const limit = query.limit || 10;
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor appointments retrieved successfully',
      data: appointments,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/doctor/${doctorId}`,
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

  @Get('upcoming')
  @ApiOperation({
    summary: 'Get Upcoming Appointments',
    description: 'Retrieve upcoming appointments for the current user.',
  })
  @ApiQuery({
    name: 'userType',
    required: true,
    description: 'Type of user (patient or doctor)',
    enum: ['patient', 'doctor'],
  })
  @ApiOkResponse({
    description: 'Upcoming appointments retrieved successfully',
    type: BaseApiResponse<AppointmentWithRelationsResponseDto[]>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getUpcomingAppointments(
    @CurrentUser() user: any,
    @Query('userType') userType: 'patient' | 'doctor',
  ): Promise<BaseApiResponse<AppointmentWithRelationsResponseDto[]>> {
    const data = await this.appointmentsService.getUpcomingAppointments(user.id, userType);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Upcoming appointments retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/upcoming',
    };
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get Appointment Statistics',
    description: 'Retrieve appointment statistics with optional filtering.',
  })
  @ApiQuery({
    name: 'doctorId',
    required: false,
    description: 'Filter by doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'Filter by start date (YYYY-MM-DD)',
    example: '2024-12-01',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'Filter by end date (YYYY-MM-DD)',
    example: '2024-12-31',
  })
  @ApiOkResponse({
    description: 'Appointment statistics retrieved successfully',
    type: BaseApiResponse<any>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getAppointmentStats(
    @Query('doctorId') doctorId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<BaseApiResponse<any>> {
    const data = await this.appointmentsService.getAppointmentStats(
      doctorId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Appointment statistics retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/stats',
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get Appointment by ID',
    description: 'Retrieve a specific appointment by ID with full details.',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Appointment retrieved successfully',
    type: BaseApiResponse<AppointmentWithRelationsResponseDto>,
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getAppointment(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentWithRelationsResponseDto>> {
    const raw = await this.appointmentsService.findById(id);
    const data = omitDrAssessmentNotesForPatientUser(raw as any, user);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Appointment retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}`,
    };
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update Appointment',
    description: 'Update an existing appointment with validation and business rule enforcement.',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    type: UpdateAppointmentDto,
    description: 'Appointment update data',
  })
  @ApiOkResponse({
    description: 'Appointment updated successfully',
    type: BaseApiResponse<AppointmentResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Validation error or business rule violation',
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async updateAppointment(
    @Param('id') id: string,
    @Body() updateAppointmentDto: UpdateAppointmentDto,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.updateAppointment(id, updateAppointmentDto);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Appointment updated successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}`,
    };
  }

  @Patch(':id/visit-status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set clinical visit status', description: 'Record what happened at the visit (completed, no-show, cancelled, rescheduled). Mirrors the booking status so the schedule stays consistent. No time restriction.' })
  @ApiParam({ name: 'id', description: 'Appointment ID' })
  async updateVisitStatus(
    @Param('id') id: string,
    @Body() dto: UpdateVisitStatusDto,
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.updateVisitStatus(id, dto.visitStatus ?? null, dto.visitStatusNote, user.id);
    return { success: true, statusCode: HttpStatus.OK, message: 'Visit status updated', data, timestamp: new Date().toISOString(), path: `/api/appointments/${id}/visit-status` };
  }

  @Patch(':id/check-in')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check in / undo check-in', description: 'Front-desk operational check-in. Sets or clears the checkedInAt timestamp.' })
  @ApiParam({ name: 'id', description: 'Appointment ID' })
  async checkInAppointment(
    @Param('id') id: string,
    @Body() dto: CheckInDto,
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const checkedIn = dto?.checkedIn !== false; // default true
    const data = await this.appointmentsService.checkInAppointment(id, user.id, checkedIn);
    return { success: true, statusCode: HttpStatus.OK, message: checkedIn ? 'Patient checked in' : 'Check-in cleared', data, timestamp: new Date().toISOString(), path: `/api/appointments/${id}/check-in` };
  }

  @Put(':id/internal-notes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update Internal Notes',
    description: 'Update internal notes for a specific appointment (doctor only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        internalNotes: {
          type: 'string',
          description: 'Doctor internal notes for this appointment',
          example: 'Patient showed improvement in symptoms. Recommended follow-up in 2 weeks.',
        },
      },
      required: ['internalNotes'],
    },
  })
  @ApiOkResponse({
    description: 'Internal notes updated successfully',
    type: BaseApiResponse<AppointmentResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Validation error',
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async updateInternalNotes(
    @Param('id') id: string,
    @Body() body: { internalNotes: string },
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.updateInternalNotes(id, body.internalNotes, user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Internal notes updated successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}/internal-notes`,
    };
  }

  @Put(':id/care-plan')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update Care Plan',
    description: 'Update care plan for a specific appointment (doctor only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'Care plan data',
    schema: {
      type: 'object',
      properties: {
        carePlan: {
          type: 'string',
          description: 'Care plan for the appointment',
          example: '1. Continue current treatment\n2. Monitor symptoms\n3. Follow up in 4 weeks\n4. Maintain lifestyle changes',
        },
      },
      required: ['carePlan'],
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Care plan updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Appointment not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Only doctors can update care plan',
  })
  async updateCarePlan(
    @Param('id') id: string,
    @Body() body: { carePlan: string },
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    // Ensure only doctors can update care plan
    if (user.userType !== 'doctor') {
      throw new ForbiddenException('Only doctors can update care plan');
    }
    
    const data = await this.appointmentsService.updateCarePlan(id, body.carePlan, user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Care plan updated successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}/care-plan`,
    };
  }

  @Put(':id/subjective-notes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update Subjective Notes',
    description: 'Update subjective notes for a specific appointment (doctor only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'Subjective notes data',
    schema: {
      type: 'object',
      properties: {
        subjectiveNotes: {
          type: 'string',
          description: 'Doctor subjective notes for this appointment',
          example: 'Patient reports feeling tired and having difficulty sleeping.',
        },
      },
      required: ['subjectiveNotes'],
    },
  })
  @ApiOkResponse({
    description: 'Subjective notes updated successfully',
    type: BaseApiResponse<AppointmentResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Validation error',
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async updateSubjectiveNotes(
    @Param('id') id: string,
    @Body() body: { subjectiveNotes: string },
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    // Ensure only doctors can update subjective notes
    if (user.userType !== 'doctor') {
      throw new ForbiddenException('Only doctors can update subjective notes');
    }
    
    const data = await this.appointmentsService.updateSubjectiveNotes(id, body.subjectiveNotes, user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Subjective notes updated successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}/subjective-notes`,
    };
  }

  @Put(':id/dr-assessment-notes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update Dr assessment notes',
    description: 'Doctor-only assessment notes for this appointment (not shown to patients).',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'Dr assessment notes (HTML from rich text editor)',
    schema: {
      type: 'object',
      properties: {
        drAssessmentNotes: {
          type: 'string',
          description: 'Doctor-only assessment notes',
        },
      },
      required: ['drAssessmentNotes'],
    },
  })
  @ApiOkResponse({
    description: 'Dr assessment notes updated successfully',
    type: BaseApiResponse<AppointmentResponseDto>,
  })
  async updateDrAssessmentNotes(
    @Param('id') id: string,
    @Body() body: { drAssessmentNotes: string },
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    if (user.userType !== 'doctor') {
      throw new ForbiddenException('Only doctors can update Dr assessment notes');
    }
    const data = await this.appointmentsService.updateDrAssessmentNotes(id, body.drAssessmentNotes, user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Dr assessment notes updated successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}/dr-assessment-notes`,
    };
  }

  @Post(':id/sign-notes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sign notes for an appointment',
    description: 'Sign notes for an appointment, which locks editing (doctor only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
  })
  async signNotes(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.signNotes(id, user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Notes signed successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}/sign-notes`,
    };
  }

  @Put(':id/medications')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update medications JSON',
    description: 'Merge or set medications JSON on an appointment (doctor only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        medications: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
          description: 'Key: service name, Value: array of medicine names',
        },
        merge: {
          type: 'boolean',
          description: 'If true, merge with existing; otherwise replace',
          default: true,
        },
      },
      required: ['medications'],
    },
  })
  async updateMedications(
    @Param('id') id: string,
    @Body() body: { medications: Record<string, string[] | any[]>; merge?: boolean }, // Supports both old (string[]) and new (MedicationObject[]) formats
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.updateMedications(
      id,
      body.medications,
      body.merge !== false,
      user.id,
    );
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Medications updated successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}/medications`,
    };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete Appointment',
    description: 'Delete a cancelled appointment (admin only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiResponse({
    status: 204,
    description: 'Appointment deleted successfully',
  })
  @ApiBadRequestResponse({
    description: 'Cannot delete non-cancelled appointments',
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async deleteAppointment(@Param('id') id: string): Promise<void> {
    await this.appointmentsService.deleteAppointment(id);
  }

  // Booking endpoints
  @Post('bookings')
  @ApiOperation({
    summary: 'Create Booking Request',
    description: 'Create a new booking request for an appointment.',
  })
  @ApiBody({
    type: CreateBookingDto,
    description: 'Booking creation data',
  })
  @ApiOkResponse({
    description: 'Booking request created successfully',
    type: BaseApiResponse<BookingResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Validation error or business rule violation',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async createBooking(
    @Body() createBookingDto: CreateBookingDto,
  ): Promise<BaseApiResponse<BookingResponseDto>> {
    const data = await this.bookingsService.createBooking(createBookingDto);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Booking request created successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/bookings',
    };
  }

  @Get('bookings')
  @ApiOperation({
    summary: 'Get All Bookings',
    description: 'Retrieve all booking requests with optional filtering.',
  })
  @ApiQuery({
    name: 'page',
    description: 'Page number',
    example: 1,
    required: false,
  })
  @ApiQuery({
    name: 'limit',
    description: 'Items per page',
    example: 10,
    required: false,
  })
  @ApiQuery({
    name: 'status',
    description: 'Booking status filter',
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'],
    required: false,
  })
  @ApiQuery({
    name: 'patientId',
    description: 'Patient ID filter',
    required: false,
  })
  @ApiQuery({
    name: 'doctorId',
    description: 'Doctor ID filter',
    required: false,
  })
  @ApiQuery({
    name: 'serviceId',
    description: 'Service ID filter',
    required: false,
  })
  @ApiOkResponse({
    description: 'Bookings retrieved successfully',
    type: BaseApiResponse<BookingWithRelationsResponseDto[]>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getAllBookings(
    @Query() query: any,
  ): Promise<BaseApiResponse<BookingWithRelationsResponseDto[]>> {
    const data = await this.bookingsService.getAllBookings(query);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Bookings retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/bookings',
    };
  }

  @Get('bookings/pending/:doctorId')
  @ApiOperation({
    summary: 'Get Pending Bookings',
    description: 'Retrieve pending booking requests for a doctor.',
  })
  @ApiParam({
    name: 'doctorId',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Pending bookings retrieved successfully',
    type: BaseApiResponse<BookingWithRelationsResponseDto[]>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getPendingBookings(
    @Param('doctorId') doctorId: string,
  ): Promise<BaseApiResponse<BookingWithRelationsResponseDto[]>> {
    const data = await this.bookingsService.getPendingBookings(doctorId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Pending bookings retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/bookings/pending/${doctorId}`,
    };
  }

  @Post('bookings/:id/respond')
  @ApiOperation({
    summary: 'Respond to Booking',
    description: 'Doctor responds to a booking request with suggestions.',
  })
  @ApiParam({
    name: 'id',
    description: 'Booking ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    type: RespondToBookingDto,
    description: 'Doctor response data',
  })
  @ApiOkResponse({
    description: 'Booking response submitted successfully',
    type: BaseApiResponse<BookingResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Validation error or business rule violation',
  })
  @ApiNotFoundResponse({
    description: 'Booking not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async respondToBooking(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() respondToBookingDto: RespondToBookingDto,
  ): Promise<BaseApiResponse<BookingResponseDto>> {
    const data = await this.bookingsService.respondToBooking(id, user.id, respondToBookingDto);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Booking response submitted successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/bookings/${id}/respond`,
    };
  }

  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Cancel Appointment',
    description: 'Cancel an appointment with 1-hour advance notice requirement.',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    type: CancelAppointmentDto,
    description: 'Cancellation data',
  })
  @ApiOkResponse({
    description: 'Appointment cancelled successfully',
    type: BaseApiResponse<AppointmentResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Validation error or business rule violation',
    examples: {
      tooLate: {
        summary: 'Too Late to Cancel',
        value: {
          success: false,
          statusCode: 400,
          message: 'Appointments can only be cancelled at least 1 hour in advance',
          error: 'BadRequestError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/appointments/123e4567-e89b-12d3-a456-426614174000/cancel',
        },
      },
      alreadyCancelled: {
        summary: 'Already Cancelled',
        value: {
          success: false,
          statusCode: 400,
          message: 'Appointment is already cancelled',
          error: 'BadRequestError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/appointments/123e4567-e89b-12d3-a456-426614174000/cancel',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async cancelAppointment(
    @Param('id') id: string,
    @Body() cancelAppointmentDto: CancelAppointmentDto,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.cancelAppointment(id, cancelAppointmentDto);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Appointment cancelled successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}/cancel`,
    };
  }

  @Patch(':id/reschedule')
  @ApiOperation({
    summary: 'Reschedule Appointment',
    description: 'Reschedule an appointment to a new date and time slot.',
  })
  @ApiParam({
    name: 'id',
    description: 'Appointment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    type: RescheduleAppointmentDto,
    description: 'Reschedule data',
  })
  @ApiOkResponse({
    description: 'Appointment rescheduled successfully',
    type: BaseApiResponse<AppointmentResponseDto>,
  })
  @ApiBadRequestResponse({
    description: 'Validation error or business rule violation',
    examples: {
      slotUnavailable: {
        summary: 'Slot Not Available',
        value: {
          success: false,
          statusCode: 400,
          message: 'New slot is not available',
          error: 'BadRequestError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/appointments/123e4567-e89b-12d3-a456-426614174000/reschedule',
        },
      },
      insufficientDuration: {
        summary: 'Insufficient Duration',
        value: {
          success: false,
          statusCode: 400,
          message: 'New slot duration is insufficient for this service',
          error: 'BadRequestError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/appointments/123e4567-e89b-12d3-a456-426614174000/reschedule',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Appointment not found',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async rescheduleAppointment(
    @Param('id') id: string,
    @Body() rescheduleAppointmentDto: RescheduleAppointmentDto,
    @CurrentUser() user: any,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.rescheduleAppointment(id, rescheduleAppointmentDto, user?.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Appointment rescheduled successfully',
      data,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/${id}/reschedule`,
    };
  }

  @Get('doctor/:doctorId/schedule')
  @ApiOperation({
    summary: 'Get Doctor Schedule',
    description: 'Get doctor schedule with filtering by date, status, and appointment type.',
  })
  @ApiParam({
    name: 'doctorId',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'Filter by specific date (YYYY-MM-DD)',
    example: '2024-12-25',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by appointment status',
    enum: ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED'],
  })
  @ApiQuery({
    name: 'appointmentType',
    required: false,
    description: 'Filter by appointment type',
    enum: ['TELEMEDICINE', 'IN_PERSON'],
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
    description: 'Doctor schedule retrieved successfully',
    type: PaginatedApiResponse<AppointmentWithRelationsResponseDto>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctorSchedule(
    @Param('doctorId') doctorId: string,
    @Query('date') date?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('status') status?: string,
    @Query('appointmentType') appointmentType?: string,
    @Query('search') search?: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
  ): Promise<PaginatedApiResponse<AppointmentWithRelationsResponseDto>> {
    const query = {
      doctorId,
      startDate: startDate || date,
      endDate: endDate || date,
      status: status as any,
      appointmentType: appointmentType as any,
      search,
      page,
      limit,
    };
    
    const { appointments, total } = await this.appointmentsService.getDoctorAppointments(doctorId, query);
    
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Doctor schedule retrieved successfully',
      data: appointments,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
      timestamp: new Date().toISOString(),
      path: `/api/appointments/doctor/${doctorId}/schedule`,
    };
  }

  @Get('doctor/:doctorId/queue')
  @ApiOperation({
    summary: 'Get Doctor Patient Queue',
    description: 'Get patient queue for a doctor with status filtering.',
  })
  @ApiParam({
    name: 'doctorId',
    description: 'Doctor ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by appointment status',
    enum: ['SCHEDULED', 'WAITING_ROOM', 'IN_VISIT', 'COMPLETED', 'NO_SHOW'],
  })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'Filter by specific date (YYYY-MM-DD), defaults to today',
    example: '2024-12-25',
  })
  @ApiOkResponse({
    description: 'Patient queue retrieved successfully',
    type: BaseApiResponse<any>,
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async getDoctorQueue(
    @Param('doctorId') doctorId: string,
    @Query('status') status?: string,
    @Query('date') date?: string,
  ): Promise<BaseApiResponse<any>> {
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const where: any = {
      doctorId,
      appointmentDate: {
        gte: targetDate,
        lt: nextDay,
      },
    };

    // Map frontend status to database status
    if (status) {
      const statusMap = {
        'SCHEDULED': 'CONFIRMED',
        'WAITING_ROOM': 'CONFIRMED', // Assuming waiting room patients are confirmed
        'IN_VISIT': 'IN_PROGRESS',
        'COMPLETED': 'COMPLETED',
        'NO_SHOW': 'NO_SHOW',
      };
      where.status = statusMap[status] || status;
    }

    const appointments = await this.prisma.appointment.findMany({
      where,
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryEmail: true,
            primaryPhone: true,
            dateOfBirth: true,
          }
        },
        doctor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        service: {
          select: {
            id: true,
            name: true,
            duration: true,
            category: true
          }
        },
        primaryService: {
          select: {
            id: true,
            name: true,
          }
        },
        slot: {
          select: {
            id: true,
            startTime: true,
            endTime: true,
            schedule: {
              select: {
                date: true
              }
            }
          }
        }
      },
      orderBy: [
        { appointmentDate: 'desc' },
        { appointmentTime: 'desc' }
      ]
    });

    // Transform the data to match the frontend expectations
    const queueData = appointments.map(appointment => ({
      id: appointment.id,
      time: appointment.appointmentTime,
      patient: `${appointment.patient.firstName} ${appointment.patient.lastName}`,
      status: this.mapStatusToQueueStatus(appointment.status),
      appointmentType: (appointment as any).primaryService?.name || 'Telemedicine',
      age: this.calculateAge(appointment.patient.dateOfBirth),
      lastVisit: appointment.patient.dateOfBirth ? 'N/A' : 'N/A', // This would need to be calculated from previous appointments
      purpose: appointment.service?.name || 'General Consultation',
      patientId: appointment.patient.id,
      patientEmail: appointment.patient.primaryEmail,
      patientPhone: appointment.patient.primaryPhone,
    }));

    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Patient queue retrieved successfully',
      data: queueData,
      timestamp: new Date().toISOString(),
      path: `/api/appointments/doctor/${doctorId}/queue`,
    };
  }

  private mapStatusToQueueStatus(dbStatus: string): string {
    const statusMap = {
      'PENDING': 'SCHEDULED',
      'CONFIRMED': 'SCHEDULED',
      'IN_PROGRESS': 'IN_VISIT',
      'COMPLETED': 'COMPLETED',
      'CANCELLED': 'SCHEDULED',
      'NO_SHOW': 'NO_SHOW',
      'RESCHEDULED': 'SCHEDULED',
    };
    return statusMap[dbStatus] || 'SCHEDULED';
  }

  private calculateAge(dateOfBirth: Date | null): number {
    if (!dateOfBirth) return 0;
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  }

  @Get('doctor/:doctorId/slots')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get doctor slots for a specific date' })
  @ApiParam({ name: 'doctorId', description: 'Doctor ID' })
  @ApiQuery({ name: 'date', description: 'Date in YYYY-MM-DD format', required: true })
  @ApiOkResponse({ description: 'Doctor slots retrieved successfully' })
  @ApiBadRequestResponse({ description: 'Invalid date format' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async getDoctorSlots(
    @Param('doctorId') doctorId: string,
    @Query('date') date: string,
  ): Promise<BaseApiResponse<any[]>> {
    try {
      // Validate date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        throw new BadRequestException('Invalid date format. Use YYYY-MM-DD');
      }

      const slots = await this.appointmentsService.getDoctorSlots(doctorId, date);
      
      return {
        success: true,
        statusCode: 200,
        message: 'Doctor slots retrieved successfully',
        data: slots,
        timestamp: new Date().toISOString(),
        path: `/api/appointments/doctor/${doctorId}/slots`,
      };
    } catch (error) {
      throw error;
    }
  }

 

  @Post('admin/create-confirmed')
  @ApiOperation({ summary: 'Admin: Create confirmed appointment' })
  @ApiOkResponse({ description: 'Appointment created', type: BaseApiResponse<AppointmentResponseDto> })
  async adminCreateConfirmed(
    @Body() dto: AdminCreateAppointmentDto,
  ): Promise<BaseApiResponse<AppointmentResponseDto>> {
    const data = await this.appointmentsService.adminCreateConfirmed(dto);
    return {
      success: true,
      statusCode: 201,
      message: 'Appointment created successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/appointments/admin/create-confirmed',
    };
  }

  @Get('slots/global')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all available slots from all doctors for a specific date' })
  @ApiQuery({ name: 'date', description: 'Date in YYYY-MM-DD format', required: true })
  @ApiOkResponse({ description: 'Global slots retrieved successfully' })
  @ApiBadRequestResponse({ description: 'Invalid date format' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async getGlobalSlots(
    @Query('date') date: string,
  ): Promise<BaseApiResponse<any[]>> {
    try {
      // Validate date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        throw new BadRequestException('Invalid date format. Use YYYY-MM-DD');
      }

      const slots = await this.appointmentsService.getGlobalSlots(date);
      
      return {
        success: true,
        statusCode: 200,
        message: 'Global slots retrieved successfully',
        data: slots,
        timestamp: new Date().toISOString(),
        path: '/api/appointments/slots/global',
      };
    } catch (error) {
      throw error;
    }
  }

  @Get('available-doctors/:appointmentId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get available doctors for appointment slot time' })
  @ApiResponse({
    status: 200,
    description: 'Available doctors retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        statusCode: { type: 'number' },
        message: { type: 'string' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              specialization: { type: 'string' },
              licenseNumber: { type: 'string' },
              slotId: { type: 'string' },
              slotStartTime: { type: 'string' },
              slotEndTime: { type: 'string' }
            }
          }
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'Appointment not found' })
  @ApiResponse({ status: 400, description: 'Appointment already has doctor or no slot time' })
  async getAvailableDoctorsForAppointment(@Param('appointmentId') appointmentId: string) {
    try {
      const availableDoctors = await this.appointmentsService.getAvailableDoctorsForAppointment(appointmentId);
      return {
        success: true,
        statusCode: 200,
        message: 'Available doctors retrieved successfully',
        data: availableDoctors
      };
    } catch (error) {
      throw error;
    }
  }

  @Post('assign-doctor')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Assign doctor and slot to appointment' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        appointmentId: { type: 'string', example: '123e4567-e89b-12d3-a456-426614174000' },
        doctorId: { type: 'string', example: '123e4567-e89b-12d3-a456-426614174000' },
        slotId: { type: 'string', example: '123e4567-e89b-12d3-a456-426614174000' }
      },
      required: ['appointmentId', 'doctorId', 'slotId']
    }
  })
  @ApiResponse({
    status: 200,
    description: 'Doctor assigned successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        statusCode: { type: 'number' },
        message: { type: 'string' },
        data: { $ref: '#/components/schemas/AppointmentResponseDto' }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'Appointment or slot not found' })
  @ApiResponse({ status: 400, description: 'Appointment already has doctor or slot not available' })
  async assignDoctorToAppointment(@Body() assignDoctorDto: any) {
    try {
      const updatedAppointment = await this.appointmentsService.assignDoctorToAppointment(assignDoctorDto);
      return {
        success: true,
        statusCode: 200,
        message: 'Doctor assigned successfully',
        data: updatedAppointment
      };
    } catch (error) {
      throw error;
    }
  }

  @Post(':id/refresh-meet-link')
  @ApiOperation({
    summary: 'Refresh Meet Link',
    description: 'Generate a new Google Meet link for an existing appointment and persist it.',
  })
  @ApiParam({ name: 'id', description: 'Appointment ID' })
  async refreshMeetLink(@Param('id') id: string) {
    const data = await this.appointmentsService.refreshMeetLink(id);
    return {
      success: true,
      statusCode: 200,
      message: 'Meet link refreshed successfully',
      data,
    };
  }

  @Delete('bookings/:id')
  @ApiOperation({
    summary: 'Delete Booking',
    description: 'Delete a booking request (admin only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Booking ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Booking deleted successfully',
  })
  @ApiNotFoundResponse({
    description: 'Booking not found',
  })
  @ApiBadRequestResponse({
    description: 'Only expired or rejected bookings can be deleted',
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized - invalid or missing JWT token',
  })
  async deleteBooking(@Param('id') id: string): Promise<void> {
    await this.bookingsService.deleteBooking(id);
  }

  // ── Manual appointment reminder (admin) ────────────────────────────────
  @Get(':id/manual-reminder-preview')
  @ApiOperation({
    summary: 'Get default reminder email content for an appointment',
    description: 'Returns a populated subject + HTML body that the admin can edit and then send.',
  })
  @ApiParam({ name: 'id', description: 'Appointment ID' })
  async getManualReminderPreview(@Param('id') id: string) {
    const data = await this.appointmentsService.getManualReminderPreview(id);
    return {
      success: true,
      statusCode: 200,
      message: 'Reminder preview generated',
      data,
    };
  }

  @Post(':id/send-manual-reminder')
  @ApiOperation({
    summary: 'Send a manual reminder email for an appointment',
    description: 'Admin sends an appointment reminder. Optional overrides: recipientEmail, subject, html, text.',
  })
  @ApiParam({ name: 'id', description: 'Appointment ID' })
  async sendManualReminder(
    @Param('id') id: string,
    @Body() body: { recipientEmail?: string; subject?: string; html?: string; text?: string },
  ) {
    const data = await this.appointmentsService.sendManualReminder(id, body || {});
    return {
      success: true,
      statusCode: 200,
      message: 'Reminder email sent successfully',
      data,
    };
  }
}
