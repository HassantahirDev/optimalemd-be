import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentsPortalService } from './payments-portal.service';
import { PaymentSyncService } from './payment-sync.service';
import { InvoicingService } from './invoicing.service';
import { MedicationsCombinedService } from './medications-combined.service';
import { PaymentFlowsCombinedService } from './payment-flows-combined.service';
import { PaymentsController } from './payments.controller';
import { MedicationsController } from './medications.controller';
import { MeBillingController } from './me-billing.controller';

// Part A foundation + Part F portal reads. Exports the dual-write helper so
// existing success points (Stripe premium/medication, signup, appointments) and
// the future POS/invoice flows can mirror payments into the unified ledger.
// The PaymentsController is gated to payment-portal users only.
@Module({
  imports: [PrismaModule],
  controllers: [PaymentsController, MedicationsController, MeBillingController],
  providers: [
    PaymentLedgerService,
    PaymentsPortalService,
    PaymentSyncService,
    InvoicingService,
    MedicationsCombinedService,
    PaymentFlowsCombinedService,
  ],
  exports: [PaymentLedgerService],
})
export class PaymentsModule {}
