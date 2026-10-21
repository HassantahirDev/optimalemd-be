/**
 * Supplements sold through the public /supplements storefront.
 *
 * This is the authoritative price list: checkout totals are always computed
 * here from the slug + quantity the client sends, never from a client-supplied
 * price. The frontend keeps its own copy for display (src/data/supplements.ts) —
 * change a price in both places.
 */
export interface SupplementProduct {
  slug: string;
  name: string;
  /** USD, whole dollars or cents as a decimal. */
  price: number;
  size: string;
}

export const SUPPLEMENT_CATALOG: SupplementProduct[] = [
  { slug: 'intramax', name: 'intraMAX — Performance Multivitamin', price: 70, size: '32 fl oz (946 mL)' },
  { slug: 'intramin', name: 'intraMIN — Performance Mineral Complex', price: 40, size: '32 fl oz (946 mL)' },
];

export const MAX_QTY_PER_ITEM = 10;

/** Patients with an active membership (User.isSubscribed) pay this much less. */
export const MEMBER_DISCOUNT_PERCENT = 20;

export const memberPrice = (price: number) =>
  Math.round(price * (100 - MEMBER_DISCOUNT_PERCENT)) / 100;

/** Marks a PaymentIntent as belonging to the supplements store (webhook routing). */
export const SUPPLEMENT_PI_KIND = 'supplement_order';

/**
 * DI token for SupplementsService. StripeService resolves it lazily (ModuleRef)
 * for the webhook, so SupplementsModule can import StripeModule — needed to check
 * membership the same way the rest of the app does — without a module cycle.
 */
export const SUPPLEMENTS_SERVICE = 'SUPPLEMENTS_SERVICE';

export const findSupplement = (slug: string) => SUPPLEMENT_CATALOG.find((p) => p.slug === slug);
