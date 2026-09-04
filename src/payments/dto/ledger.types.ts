// Shared input types for the unified payment ledger (Part A) and the
// set-based medication-order lifecycle (Part B, PDF/set-based variant).
//
// String literals are used for enum-ish fields so callers don't need to import
// Prisma enums; the service maps them to the generated Prisma enums.

export type LedgerChannel = 'PLATFORM' | 'POS' | 'INVOICE';
export type LedgerCategory =
  | 'MEDICATION'
  | 'MEMBERSHIP'
  | 'APPOINTMENT'
  | 'SIGNUP'
  | 'OTHER';
export type LedgerBilling = 'ONE_TIME' | 'SUBSCRIPTION';
export type LedgerStatus =
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export interface LedgerLineItemInput {
  description: string;
  stripePriceId?: string | null;
  medicationId?: string | null;
  quantity?: number;
  unitAmount: number; // dollars
  isSubscription?: boolean;
  /** Per-line classification (Monthly subscription / Medication / Other). */
  category?: LedgerCategory;
  /** Snapshot of dose/strength text for the medication-order item, if known. */
  dosageSnapshot?: string | null;
}

export interface UpsertPaymentInput {
  // --- Idempotency: at least ONE of these unique Stripe ids must be present ---
  stripePaymentIntentId?: string | null;
  stripeInvoiceId?: string | null;
  stripeChargeId?: string | null;

  // --- Non-unique Stripe refs ---
  stripeSubscriptionId?: string | null;
  stripeCustomerId?: string | null;

  // --- Soft links back to origin rows (all optional) ---
  userId?: string | null;
  appointmentId?: string | null;
  medicationPaymentId?: string | null;
  welcomeOrderId?: string | null;
  subscriptionTransactionId?: string | null;

  // --- Classification ---
  channel: LedgerChannel;
  category: LedgerCategory;
  billing?: LedgerBilling; // default ONE_TIME

  // --- Money ---
  amount: number; // dollars
  currency?: string; // default usd
  status: LedgerStatus;
  refundedAmount?: number | null;

  // --- Presentation ---
  receiptUrl?: string | null;
  hostedInvoiceUrl?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  /**
   * Payer email at the time of payment. This is the ONLY way `getPatientHistory`
   * can find a record when `userId` isn't set yet — e.g. a signup payment made
   * before the User account exists (payment happens at Checkout, the account is
   * created a step later at Password). Always pass this for guest/pre-account
   * charges, not just true guest checkouts, or the record becomes permanently
   * invisible to the patient's billing history.
   */
  billingEmail?: string | null;

  // --- Audit ---
  createdByType?: 'patient' | 'admin' | 'payment_user' | 'system' | null;
  createdById?: string | null;
  note?: string | null;
  paidAt?: Date | null;

  // --- Cart ---
  lineItems?: LedgerLineItemInput[];
}
