import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateLabOrderDto, LabTestTypeDto, LabOrderDto } from './dto/lab-orders.dto';

@Injectable()
export class LabOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
  ) {}

  /**
   * Patient self-uploads an EXISTING comprehensive bloodwork panel (taken elsewhere)
   * to potentially skip the clinic lab process. Stored in the SAME tables as clinic labs
   * (LabOrder + LabResultFile), flagged source="self_upload" and status="pending_review"
   * so the team can review and reach out. No "results ready" email is sent to the patient.
   *
   * Rule: results older than 3 months are rejected — the patient must request a new lab.
   */
  async createSelfUploadOrder(userId: string, testDateStr: string, file: any) {
    if (!file) {
      throw new BadRequestException('Please attach your lab results file.');
    }
    if (!testDateStr) {
      throw new BadRequestException('Please provide the date the bloodwork was taken.');
    }

    const testDate = new Date(testDateStr);
    if (isNaN(testDate.getTime())) {
      throw new BadRequestException('Invalid test date.');
    }

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (testDate.getTime() > today.getTime()) {
      throw new BadRequestException('The test date cannot be in the future.');
    }

    // Must be within the last 3 months
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    threeMonthsAgo.setHours(0, 0, 0, 0);
    if (testDate.getTime() < threeMonthsAgo.getTime()) {
      throw new BadRequestException(
        'These results are more than 3 months old. Please request a new lab panel below.',
      );
    }

    // Create the lab order record (same table as clinic-ordered labs)
    const order = await this.prisma.labOrder.create({
      data: {
        patientId: userId,
        scheduledDate: testDate,
        testDate,
        source: 'self_upload',
        status: 'pending_review',
        notes: 'Patient-uploaded existing bloodwork panel — pending team review to determine if additional labs are needed.',
      },
    });

    // Store the file as a LabResultFile using the SAME storage logic, but do NOT
    // email the patient (they uploaded their own results).
    try {
      await this.uploadsService.uploadLabResults(order.id, file, false);
    } catch (err) {
      // Roll back the order if the file failed to store, so we don't leave an empty record.
      await this.prisma.labOrder.delete({ where: { id: order.id } }).catch(() => {});
      throw err;
    }

    return this.getLabOrderById(order.id, userId);
  }

  /**
   * Get all active lab test types
   */
  async getLabTestTypes(): Promise<LabTestTypeDto[]> {
    const testTypes = await this.prisma.labTestType.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    return testTypes.map((type) => ({
      id: type.id,
      name: type.name,
      description: type.description || undefined,
      code: type.code || undefined,
      price: type.price ? Number(type.price) : undefined,
      isActive: type.isActive,
    }));
  }

  /**
   * Request a lab order
   */
  async createLabOrder(
    userId: string,
    createOrderDto: CreateLabOrderDto,
  ): Promise<LabOrderDto> {
    // Check if patient has uploaded identity documents (driving license and photo)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        drivingLicensePath: true,
        photoPath: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.drivingLicensePath || !user.photoPath) {
      const missingDocs: string[] = [];
      if (!user.drivingLicensePath) missingDocs.push('driving license');
      if (!user.photoPath) missingDocs.push('profile photo');
      throw new BadRequestException(
        `You must upload your ${missingDocs.join(' and ')} before booking a lab. Please upload them from your profile settings.`
      );
    }

    // Check if patient has any lab orders in the last 3 months
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const recentOrders = await this.prisma.labOrder.findMany({
      where: {
        patientId: userId,
        createdAt: {
          gte: threeMonthsAgo,
        },
        status: {
          not: 'cancelled', // Don't count cancelled orders
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 1,
    });

    if (recentOrders.length > 0) {
      const lastOrderDate = new Date(recentOrders[0].createdAt);
      const nextAllowedDate = new Date(lastOrderDate);
      nextAllowedDate.setMonth(nextAllowedDate.getMonth() + 3);
      
      const daysRemaining = Math.ceil((nextAllowedDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
      
      throw new BadRequestException(
        `You can only book a lab once every 3 months. Your last lab order was on ${lastOrderDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. You can book your next lab on ${nextAllowedDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} (${daysRemaining} days remaining).`
      );
    }

    // Validate that all test types exist and are active
    const testTypes = await this.prisma.labTestType.findMany({
      where: {
        id: { in: createOrderDto.testTypeIds },
        isActive: true,
      },
    });

    if (testTypes.length !== createOrderDto.testTypeIds.length) {
      throw new BadRequestException('One or more selected test types are invalid or inactive');
    }

    // Check for duplicates
    const uniqueIds = new Set(createOrderDto.testTypeIds);
    if (uniqueIds.size !== createOrderDto.testTypeIds.length) {
      throw new BadRequestException('Duplicate test types are not allowed');
    }

    // Request the lab order with items
    const labOrder = await this.prisma.labOrder.create({
      data: {
        patientId: userId,
        scheduledDate: new Date(createOrderDto.scheduledDate),
        status: 'pending',
        notes: createOrderDto.notes || undefined,
        items: {
          create: createOrderDto.testTypeIds.map((testTypeId) => ({
            labTestTypeId: testTypeId,
          })),
        },
      },
      include: {
        items: {
          include: {
            labTestType: true,
          },
        },
      },
    });

    return this.mapToLabOrderDto(labOrder);
  }

  /**
   * Get all lab orders for a patient
   */
  async getPatientLabOrders(userId: string): Promise<LabOrderDto[]> {
    const orders = await this.prisma.labOrder.findMany({
      where: {
        patientId: userId,
      },
      include: {
        items: {
          include: {
            labTestType: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return orders.map((order) => this.mapToLabOrderDto(order));
  }

  /**
   * Get a single lab order by ID
   */
  async getLabOrderById(orderId: string, userId: string): Promise<LabOrderDto> {
    const order = await this.prisma.labOrder.findFirst({
      where: {
        id: orderId,
        patientId: userId,
      },
      include: {
        items: {
          include: {
            labTestType: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Lab order not found');
    }

    return this.mapToLabOrderDto(order);
  }

  /**
   * Cancel a lab order
   */
  async cancelLabOrder(orderId: string, userId: string): Promise<LabOrderDto> {
    const order = await this.prisma.labOrder.findFirst({
      where: {
        id: orderId,
        patientId: userId,
      },
    });

    if (!order) {
      throw new NotFoundException('Lab order not found');
    }

    if (order.status === 'cancelled') {
      throw new BadRequestException('Lab order is already cancelled');
    }

    if (order.status === 'completed') {
      throw new BadRequestException('Cannot cancel a completed lab order');
    }

    const updatedOrder = await this.prisma.labOrder.update({
      where: { id: orderId },
      data: { status: 'cancelled' },
      include: {
        items: {
          include: {
            labTestType: true,
          },
        },
      },
    });

    return this.mapToLabOrderDto(updatedOrder);
  }

  /**
   * Admin updates the status of a lab order.
   */
  private static readonly ALLOWED_STATUSES = [
    'pending', 'scheduled', 'pending_review', 'confirmed', 'completed', 'cancelled',
  ];

  async updateStatusAdmin(orderId: string, status: string): Promise<LabOrderDto> {
    const normalized = (status || '').toLowerCase().trim();
    if (!LabOrdersService.ALLOWED_STATUSES.includes(normalized)) {
      throw new BadRequestException(
        `Invalid status. Must be one of: ${LabOrdersService.ALLOWED_STATUSES.join(', ')}`,
      );
    }

    const order = await this.prisma.labOrder.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('Lab order not found');
    }

    const updated = await this.prisma.labOrder.update({
      where: { id: orderId },
      data: { status: normalized },
      include: { items: { include: { labTestType: true } } },
    });

    return this.mapToLabOrderDto(updated);
  }

  /**
   * Create a lab order for a patient (admin access - bypasses restrictions)
   */
  async createLabOrderAdmin(
    patientId: string,
    createOrderDto: CreateLabOrderDto,
  ): Promise<LabOrderDto> {
    // Verify patient exists
    const user = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('Patient not found');
    }

    // Validate that all test types exist and are active
    const testTypes = await this.prisma.labTestType.findMany({
      where: {
        id: { in: createOrderDto.testTypeIds },
        isActive: true,
      },
    });

    if (testTypes.length !== createOrderDto.testTypeIds.length) {
      throw new BadRequestException('One or more selected test types are invalid or inactive');
    }

    // Check for duplicates
    const uniqueIds = new Set(createOrderDto.testTypeIds);
    if (uniqueIds.size !== createOrderDto.testTypeIds.length) {
      throw new BadRequestException('Duplicate test types are not allowed');
    }

    // Create the lab order with items (admin bypasses all restrictions)
    const labOrder = await this.prisma.labOrder.create({
      data: {
        patientId: patientId,
        scheduledDate: new Date(createOrderDto.scheduledDate),
        status: 'pending',
        notes: createOrderDto.notes || undefined,
        items: {
          create: createOrderDto.testTypeIds.map((testTypeId) => ({
            labTestTypeId: testTypeId,
          })),
        },
      },
      include: {
        items: {
          include: {
            labTestType: true,
          },
        },
      },
    });

    return this.mapToLabOrderDto(labOrder);
  }

  /**
   * Get all lab orders paginated by patient (admin access)
   * Returns patients ordered by their most recent order, 10 patients per page.
   */
  async getAllLabOrdersAdmin(page: number, limit: number, search?: string, status?: string): Promise<{
    orders: LabOrderDto[];
    totalPatients: number;
    page: number;
    totalPages: number;
  }> {
    const whereFilter: any = {};
    if (search) {
      whereFilter.patient = {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ],
      };
    }
    if (status && status !== 'all') {
      whereFilter.status = status;
    }

    // Step 1: get distinct patient IDs ordered by their most recent matching order
    const allPatientRows = await this.prisma.labOrder.findMany({
      where: whereFilter,
      select: { patientId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      distinct: ['patientId'],
    });

    const totalPatients = allPatientRows.length;
    const totalPages = Math.max(1, Math.ceil(totalPatients / limit));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const paginatedIds = allPatientRows
      .slice((safePage - 1) * limit, safePage * limit)
      .map((r) => r.patientId);

    if (paginatedIds.length === 0) {
      return { orders: [], totalPatients, page: safePage, totalPages };
    }

    // Step 2: fetch only matching orders for those patients
    const orderWhere: any = { patientId: { in: paginatedIds } };
    if (status && status !== 'all') orderWhere.status = status;

    const orders = await this.prisma.labOrder.findMany({
      where: orderWhere,
      include: {
        items: { include: { labTestType: true } },
        resultFiles: { orderBy: { createdAt: 'desc' } },
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            drivingLicensePath: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Preserve the patient order from Step 1
    const idOrder = new Map(paginatedIds.map((id, i) => [id, i]));
    orders.sort((a, b) => (idOrder.get(a.patientId) ?? 0) - (idOrder.get(b.patientId) ?? 0));

    return {
      orders: orders.map((o) => this.mapToLabOrderDto(o)),
      totalPatients,
      page: safePage,
      totalPages,
    };
  }

  /**
   * Get all lab orders for a patient (admin access)
   */
  async getPatientLabOrdersAdmin(patientId: string): Promise<LabOrderDto[]> {
    const orders = await this.prisma.labOrder.findMany({
      where: {
        patientId: patientId,
      },
      include: {
        items: {
          include: {
            labTestType: true,
          },
        },
        resultFiles: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            drivingLicensePath: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return orders.map((order) => this.mapToLabOrderDto(order));
  }

  /**
   * Upload lab order for an order
   */
  async uploadLabOrder(orderId: string, filePath: string): Promise<LabOrderDto> {
    const order = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Lab order not found');
    }

    // Delete old receipt if exists
    if (order.receiptPath && require('fs').existsSync(order.receiptPath)) {
      try {
        require('fs').unlinkSync(order.receiptPath);
      } catch (error) {
        console.error('Error deleting old receipt:', error);
      }
    }

    const updatedOrder = await this.prisma.labOrder.update({
      where: { id: orderId },
      data: { receiptPath: filePath },
      include: {
        items: {
          include: {
            labTestType: true,
          },
        },
      },
    });

    return this.mapToLabOrderDto(updatedOrder);
  }

  /**
   * Upload lab results for an order
   */
  async uploadLabResults(orderId: string, filePath: string): Promise<LabOrderDto> {
    const order = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Lab order not found');
    }

    // Delete old results if exists
    if (order.resultsPath && require('fs').existsSync(order.resultsPath)) {
      try {
        require('fs').unlinkSync(order.resultsPath);
      } catch (error) {
        console.error('Error deleting old results:', error);
      }
    }

    const updatedOrder = await this.prisma.labOrder.update({
      where: { id: orderId },
      data: { resultsPath: filePath, status: 'completed' },
      include: {
        items: {
          include: {
            labTestType: true,
          },
        },
      },
    });

    return this.mapToLabOrderDto(updatedOrder);
  }

  /**
   * Map Prisma model to DTO
   */
  private mapToLabOrderDto(order: any): LabOrderDto {
    return {
      id: order.id,
      patientId: order.patientId,
      doctorId: order.doctorId || undefined,
      scheduledDate: order.scheduledDate,
      status: order.status,
      source: order.source || undefined,
      testDate: order.testDate || undefined,
      notes: order.notes || undefined,
      receiptPath: order.receiptPath || undefined,
      receiptFileName: order.receiptFileName || undefined,
      resultsPath: order.resultsPath || undefined,
      items: order.items.map((item: any) => ({
        id: item.id,
        labTestType: {
          id: item.labTestType.id,
          name: item.labTestType.name,
          description: item.labTestType.description || undefined,
          code: item.labTestType.code || undefined,
          price: item.labTestType.price ? Number(item.labTestType.price) : undefined,
          isActive: item.labTestType.isActive,
        },
      })),
      resultFiles: order.resultFiles ? order.resultFiles.map((file: any) => ({
        id: file.id,
        fileName: file.fileName,
        fileSize: file.fileSize || undefined,
        mimeType: file.mimeType || undefined,
        createdAt: file.createdAt,
      })) : undefined,
      patient: order.patient ? {
        id: order.patient.id,
        firstName: order.patient.firstName,
        lastName: order.patient.lastName,
        email: order.patient.email,
        drivingLicensePath: order.patient.drivingLicensePath ?? null,
      } : undefined,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}

