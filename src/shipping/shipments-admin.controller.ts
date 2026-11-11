import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ShipmentsService } from './shipments.service';
import { CreateShipmentDto, ListShipmentsQueryDto, QuoteShipmentDto } from './dto/shipments.dto';

/** Admin panel → Shipments. Any admin can ship medications and track them. */
@ApiTags('Shipments (Admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin/shipments')
export class ShipmentsAdminController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get()
  @ApiOperation({ summary: 'List shipments with status counts and USPS setup state' })
  async list(@Query() query: ListShipmentsQueryDto, @Req() req: any) {
    assertAdmin(req);
    return { success: true, data: await this.shipments.list(query) };
  }

  @Get('patients')
  @ApiOperation({ summary: 'Find a patient to ship to (name or email), with their address' })
  async patients(@Query('search') search: string, @Req() req: any) {
    assertAdmin(req);
    return { success: true, data: await this.shipments.searchPatients(search) };
  }

  @Post('quote')
  @ApiOperation({ summary: 'USPS commercial postage for a package' })
  async quote(@Body() dto: QuoteShipmentDto, @Req() req: any) {
    assertAdmin(req);
    return { success: true, data: await this.shipments.quote(dto) };
  }

  @Post()
  @ApiOperation({ summary: 'Record a shipment: buy a USPS label, or add a tracking number from USPS.com' })
  async create(@Body() dto: CreateShipmentDto, @Req() req: any) {
    assertAdmin(req);
    return { success: true, data: await this.shipments.create(dto, req.user.id) };
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh tracking for every undelivered shipment' })
  async refreshAll(@Req() req: any) {
    assertAdmin(req);
    return { success: true, data: await this.shipments.refreshActive() };
  }

  @Post(':id/refresh')
  @ApiOperation({ summary: 'Refresh tracking for one shipment' })
  async refreshOne(@Param('id') id: string, @Req() req: any) {
    assertAdmin(req);
    await this.shipments.refreshMany([id]);
    return { success: true, data: await this.shipments.get(id) };
  }

  @Post(':id/send-email')
  @ApiOperation({ summary: 'Send (or re-send) the "on its way" email to the patient' })
  async sendEmail(@Param('id') id: string, @Req() req: any) {
    assertAdmin(req);
    const sent = await this.shipments.sendOnItsWay(id, 'MANUAL');
    return { success: sent, data: await this.shipments.get(id) };
  }

  @Get(':id/label')
  @ApiOperation({ summary: 'Download the USPS label PDF (labels bought through FormaMD only)' })
  async label(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    assertAdmin(req);
    const { pdf, filename } = await this.shipments.labelPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(pdf);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a shipment entered by mistake (tracking-number entries only)' })
  async remove(@Param('id') id: string, @Req() req: any) {
    assertAdmin(req);
    return { success: true, data: await this.shipments.remove(id) };
  }
}

const assertAdmin = (req: any) => {
  if (req.user?.userType !== 'admin') throw new ForbiddenException('Admin access required');
};
