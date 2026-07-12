import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaymentUserGuard } from '../auth/guards/payment-user.guard';
import { PaymentsPortalService } from './payments-portal.service';
import { PaymentSyncService } from './payment-sync.service';
import { CreateInvoiceInput, InvoicingService } from './invoicing.service';
import {
  ChangePriceInput,
  CreateProductInput,
  ProductsService,
  UpdateProductInput,
} from './products.service';

/**
 * Payments portal API (payments.formamd.com). EVERY route is gated by
 * JwtAuthGuard + PaymentUserGuard, so only payment-portal users can reach it —
 * admins, doctors, and patients are rejected even with a valid token.
 */
@UseGuards(JwtAuthGuard, PaymentUserGuard)
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly portal: PaymentsPortalService,
    private readonly invoicing: InvoicingService,
    private readonly sync: PaymentSyncService,
    private readonly products: ProductsService,
  ) {}

  @Post('sync')
  runSync() {
    return this.sync.syncAll();
  }

  @Post('sync/quick')
  runQuickSync() {
    return this.sync.syncAll({ sinceDays: 3 });
  }

  @Get('overview')
  getOverview() {
    return this.portal.getOverview();
  }

  @Get('transactions')
  listTransactions(
    @Query('channel') channel?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.portal.listTransactions({
      channel,
      category,
      status,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('subscriptions')
  listSubscriptions(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.portal.listSubscriptions({
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('invoices')
  listInvoices() {
    return this.portal.listInvoices();
  }

  @Post('subscriptions/:id/cancel')
  cancelSubscription(
    @Param('id') id: string,
    @Body() body: { immediate?: boolean },
  ) {
    return this.portal.cancelSubscription(id, !!body?.immediate);
  }

  @Post('subscriptions/:id/reactivate')
  reactivateSubscription(@Param('id') id: string) {
    return this.portal.reactivateSubscription(id);
  }

  @Get('patients/search')
  searchPatients(@Query('q') q: string) {
    return this.portal.searchPatients(q || '');
  }

  @Get('patients/:userId/history')
  getPatientHistory(@Param('userId') userId: string) {
    return this.portal.getPatientHistory(userId);
  }

  // --- Invoicing: catalog, per-patient billing context, create/send ---
  @Get('catalog')
  getCatalog() {
    return this.invoicing.getCatalog();
  }

  @Get('patients/:userId/billing-context')
  getBillingContext(@Param('userId') userId: string) {
    return this.invoicing.getBillingContext(userId);
  }

  @Post('invoices/send')
  sendInvoice(@Body() body: CreateInvoiceInput) {
    return this.invoicing.createInvoice(body);
  }

  // --- Products: Stripe-backed catalog with ledger-derived sales stats ---
  @Get('products')
  listProducts() {
    return this.products.list();
  }

  @Post('products')
  createProduct(@Body() body: CreateProductInput) {
    return this.products.create(body);
  }

  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() body: UpdateProductInput) {
    return this.products.update(id, body);
  }

  @Post('products/:id/price')
  changeProductPrice(@Param('id') id: string, @Body() body: ChangePriceInput) {
    return this.products.changePrice(id, body);
  }

  @Post('products/:id/archive')
  archiveProduct(@Param('id') id: string) {
    return this.products.setArchived(id, true);
  }

  @Post('products/:id/activate')
  activateProduct(@Param('id') id: string) {
    return this.products.setArchived(id, false);
  }
}
