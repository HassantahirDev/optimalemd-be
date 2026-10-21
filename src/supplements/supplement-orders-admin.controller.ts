import { Body, Controller, ForbiddenException, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SupplementOrdersAdminService } from './supplement-orders-admin.service';
import { ListSupplementOrdersQueryDto, UpdateFulfillmentDto } from './dto/admin-orders.dto';

/** Admin panel → Orders. Any admin can view and fulfil supplements orders. */
@ApiTags('Supplements Store (Admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('supplements/admin/orders')
export class SupplementOrdersAdminController {
  constructor(private readonly ordersService: SupplementOrdersAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List supplements orders with shipping-status counts' })
  async list(@Query() query: ListSupplementOrdersQueryDto, @Req() req: any) {
    assertAdmin(req);
    return { success: true, data: await this.ordersService.list(query) };
  }

  @Patch(':id/fulfillment')
  @ApiOperation({ summary: 'Set shipping status; marking SHIPPED emails the customer once' })
  async updateFulfillment(@Param('id') id: string, @Body() dto: UpdateFulfillmentDto, @Req() req: any) {
    assertAdmin(req);
    return { success: true, data: await this.ordersService.updateFulfillment(id, dto, req.user.id) };
  }
}

const assertAdmin = (req: any) => {
  if (req.user?.userType !== 'admin') throw new ForbiddenException('Admin access required');
};
