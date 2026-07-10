import {
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as path from 'path';
import { StripePosService } from './stripe-pos.service';
import { StripePosBasicAuthGuard } from './stripe-pos-basic-auth.guard';

/**
 * Stripe Terminal POS — route paths match the original Express server (no `/api` prefix).
 * Basic Auth on all routes, including `POST /webhook`, as in the original.
 */
@ApiExcludeController()
@Controller()
@UseGuards(StripePosBasicAuthGuard)
export class StripePosController {
  constructor(
    private readonly stripePosService: StripePosService,
    private readonly configService: ConfigService,
  ) {}

  @Get('pos')
  servePosUi(@Res() res: Response) {
    res.sendFile(path.join(process.cwd(), 'public', 'pos.html'));
  }

  @Post('create-payment-intent')
  async createPaymentIntent(@Body() body: { amount?: number }) {
    try {
      const amount = body.amount;
      const result = await this.stripePosService.createPaymentIntent(amount!);
      return result;
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Post('process-payment')
  async processPayment(
    @Body() body: { readerId?: string; paymentIntentId?: string },
  ) {
    try {
      const result = await this.stripePosService.processPayment(
        body.readerId!,
        body.paymentIntentId!,
      );
      return result;
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Post('cancel-payment')
  async cancelPayment(@Body() body: { readerId?: string }) {
    try {
      const result = await this.stripePosService.cancelPayment(body.readerId!);
      return result;
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Post('create-customer')
  async createCustomer(@Body() body: { name?: string; email?: string }) {
    try {
      const result = await this.stripePosService.createCustomer(
        body.name!,
        body.email!,
      );
      return result;
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Post('save-card-on-reader')
  async saveCardOnReader(
    @Body() body: { readerId?: string; customerId?: string },
  ) {
    try {
      const result = await this.stripePosService.saveCardOnReader(
        body.readerId!,
        body.customerId!,
      );
      return result;
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Post('create-membership-subscription')
  async createMembershipSubscription(@Body() body: any) {
    try {
      const result = await this.stripePosService.createMembershipSubscription(
        body,
      );
      if (
        result &&
        typeof result === 'object' &&
        'ok' in result &&
        result.ok === false &&
        'statusCode' in result &&
        (result as any).statusCode === 400
      ) {
        throw new HttpException(
          { ok: false, error: (result as any).error },
          400,
        );
      }
      return result;
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Get('setup-intent-status')
  async setupIntentStatus(@Query('id') id: string) {
    if (!id) {
      throw new HttpException({ ok: false, error: 'Missing id' }, 400);
    }
    try {
      return await this.stripePosService.getSetupIntentStatus(id);
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Get('search-customers')
  async searchCustomers(@Query('q') q: string) {
    try {
      return await this.stripePosService.searchCustomers(q || '');
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  // Search our own patient accounts to attach an in-person sale (Part C).
  @Get('search-patients')
  async searchPatients(@Query('q') q: string) {
    try {
      return { ok: true, patients: await this.stripePosService.searchPatients(q || '') };
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Get('catalog/one-time')
  async catalogOneTime() {
    try {
      return await this.stripePosService.catalogOneTime();
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }

  @Get('catalog/recurring')
  async catalogRecurring() {
    try {
      return await this.stripePosService.catalogRecurring();
    } catch (err: any) {
      throw new HttpException({ ok: false, error: err.message }, 400);
    }
  }
}
