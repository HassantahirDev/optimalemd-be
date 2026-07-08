import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { LabOrdersService } from './lab-orders.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/user.decorator';
import { CreateLabOrderDto, LabTestTypeDto, LabOrderDto } from './dto/lab-orders.dto';
import { BaseApiResponse } from '../common/dto/api-response.dto';

@ApiTags('lab-orders')
@Controller('lab-orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class LabOrdersController {
  constructor(private readonly labOrdersService: LabOrdersService) {}

  @Get('test-types')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get available lab test types',
    description: 'Retrieves all active lab test types that can be ordered.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lab test types retrieved successfully',
    type: [LabTestTypeDto],
  })
  async getLabTestTypes(): Promise<BaseApiResponse<LabTestTypeDto[]>> {
    const testTypes = await this.labOrdersService.getLabTestTypes();
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab test types retrieved successfully',
      data: testTypes,
      timestamp: new Date().toISOString(),
      path: '/api/lab-orders/test-types',
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Request a lab order',
    description: 'Requests a new lab order with selected test types and scheduled time.',
  })
  @ApiResponse({
    status: 201,
    description: 'Lab order created successfully',
    type: LabOrderDto,
  })
  async createLabOrder(
    @CurrentUser() user: any,
    @Body() createOrderDto: CreateLabOrderDto,
  ): Promise<BaseApiResponse<LabOrderDto>> {
    const order = await this.labOrdersService.createLabOrder(user.id, createOrderDto);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Lab order created successfully',
      data: order,
      timestamp: new Date().toISOString(),
      path: '/api/lab-orders',
    };
  }

  @Post('self-upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload existing bloodwork results',
    description:
      'Patient uploads an existing comprehensive bloodwork panel (taken within the last 3 months) for the team to review. Stored in the same tables as clinic labs. Results older than 3 months are rejected.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        testDate: { type: 'string', example: '2026-05-01', description: 'Date the bloodwork was taken (YYYY-MM-DD)' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Results uploaded for review', type: LabOrderDto })
  @ApiResponse({ status: 400, description: 'Results older than 3 months, or invalid file/date' })
  async selfUploadLab(
    @CurrentUser() user: any,
    @UploadedFile() file: any,
    @Body('testDate') testDate: string,
  ): Promise<BaseApiResponse<LabOrderDto>> {
    const order = await this.labOrdersService.createSelfUploadOrder(user.id, testDate, file);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Your results were uploaded. Our team will review and reach out.',
      data: order,
      timestamp: new Date().toISOString(),
      path: '/api/lab-orders/self-upload',
    };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get patient lab orders',
    description: 'Retrieves all lab orders for the authenticated patient.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lab orders retrieved successfully',
    type: [LabOrderDto],
  })
  async getPatientLabOrders(@CurrentUser() user: any): Promise<BaseApiResponse<LabOrderDto[]>> {
    const orders = await this.labOrdersService.getPatientLabOrders(user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab orders retrieved successfully',
      data: orders,
      timestamp: new Date().toISOString(),
      path: '/api/lab-orders',
    };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a specific lab order',
    description: 'Retrieves a specific lab order by ID for the authenticated patient.',
  })
  @ApiParam({
    name: 'id',
    description: 'Lab order ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Lab order retrieved successfully',
    type: LabOrderDto,
  })
  async getLabOrder(
    @CurrentUser() user: any,
    @Param('id') orderId: string,
  ): Promise<BaseApiResponse<LabOrderDto>> {
    const order = await this.labOrdersService.getLabOrderById(orderId, user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab order retrieved successfully',
      data: order,
      timestamp: new Date().toISOString(),
      path: `/api/lab-orders/${orderId}`,
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a lab order',
    description: 'Cancels a lab order (only if not completed).',
  })
  @ApiParam({
    name: 'id',
    description: 'Lab order ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Lab order cancelled successfully',
    type: LabOrderDto,
  })
  async cancelLabOrder(
    @CurrentUser() user: any,
    @Param('id') orderId: string,
  ): Promise<BaseApiResponse<LabOrderDto>> {
    const order = await this.labOrdersService.cancelLabOrder(orderId, user.id);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab order cancelled successfully',
      data: order,
      timestamp: new Date().toISOString(),
      path: `/api/lab-orders/${orderId}`,
    };
  }

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get all lab orders paginated by patient (Admin)',
    description: 'Returns patients ordered by most recent lab order, 10 patients per page.',
  })
  async getAllLabOrdersAdmin(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    const pageNum = Math.max(1, parseInt(page || '1', 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit || '10', 10) || 10));
    const result = await this.labOrdersService.getAllLabOrdersAdmin(pageNum, limitNum, search?.trim() || undefined, status?.trim() || undefined);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab orders retrieved successfully',
      data: result,
      timestamp: new Date().toISOString(),
      path: '/api/lab-orders/admin/all',
    };
  }

  @Patch('admin/:orderId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update lab order status (Admin)',
    description: 'Sets the status of a lab order (pending, scheduled, pending_review, completed, cancelled).',
  })
  @ApiParam({ name: 'orderId', description: 'Lab order ID' })
  async updateLabOrderStatusAdmin(
    @Param('orderId') orderId: string,
    @Body('status') status: string,
  ): Promise<BaseApiResponse<LabOrderDto>> {
    const order = await this.labOrdersService.updateStatusAdmin(orderId, status);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab order status updated successfully',
      data: order,
      timestamp: new Date().toISOString(),
      path: `/api/lab-orders/admin/${orderId}/status`,
    };
  }

  @Get('admin/patient/:patientId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get patient lab orders (Admin)',
    description: 'Retrieves all lab orders for a specific patient (admin access).',
  })
  @ApiParam({
    name: 'patientId',
    description: 'Patient ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Lab orders retrieved successfully',
    type: [LabOrderDto],
  })
  async getPatientLabOrdersAdmin(
    @Param('patientId') patientId: string,
  ): Promise<BaseApiResponse<LabOrderDto[]>> {
    const orders = await this.labOrdersService.getPatientLabOrdersAdmin(patientId);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Lab orders retrieved successfully',
      data: orders,
      timestamp: new Date().toISOString(),
      path: `/api/lab-orders/admin/patient/${patientId}`,
    };
  }

  @Post('admin/patient/:patientId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create lab order for patient (Admin)',
    description: 'Creates a new lab order for a specific patient (admin access - bypasses restrictions).',
  })
  @ApiParam({
    name: 'patientId',
    description: 'Patient ID',
  })
  @ApiResponse({
    status: 201,
    description: 'Lab order created successfully',
    type: LabOrderDto,
  })
  async createLabOrderAdmin(
    @Param('patientId') patientId: string,
    @Body() createOrderDto: CreateLabOrderDto,
  ): Promise<BaseApiResponse<LabOrderDto>> {
    const order = await this.labOrdersService.createLabOrderAdmin(patientId, createOrderDto);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'Lab order created successfully',
      data: order,
      timestamp: new Date().toISOString(),
      path: `/api/lab-orders/admin/patient/${patientId}`,
    };
  }
}

