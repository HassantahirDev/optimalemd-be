import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateProductInput {
  name: string;
  description?: string;
  amount: number; // dollars
  currency?: string;
  recurring?: { interval: 'day' | 'week' | 'month' | 'year' } | null;
  category?: string; // informational tag stored on Stripe product metadata
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  active?: boolean;
  category?: string;
}

export interface ChangePriceInput {
  amount: number; // dollars
  currency?: string;
  recurring?: { interval: 'day' | 'week' | 'month' | 'year' } | null;
  archiveOld?: boolean; // deactivate the previous default price (default true)
}

/**
 * Product catalog for the payments portal. Stripe is the SINGLE source of truth
 * for products/prices — we do NOT store a product table. "Times bought" and
 * revenue are DERIVED live from the unified payment ledger (PaymentLineItem →
 * PaymentRecord), so the tab is always consistent with Transactions with zero
 * extra storage.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const key = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    this.stripe = new Stripe(key, { apiVersion: '2025-10-29.clover' as any });
  }

  // Load every SUCCEEDED ledger line once, so `list()` can attribute each line
  // to a product by price id (exact) or by product-name match (for imported /
  // POS / invoice lines that never captured a price id).
  private async loadSaleLines() {
    return this.prisma.paymentLineItem.findMany({
      where: { paymentRecord: { status: 'SUCCEEDED' as any } },
      select: {
        stripePriceId: true,
        description: true,
        quantity: true,
        unitAmount: true,
        paymentRecord: {
          select: { userId: true, paidAt: true, createdAt: true, stripeSubscriptionId: true },
        },
      },
    });
  }

  private emptyAgg() {
    return {
      purchases: 0,
      units: 0,
      revenue: 0,
      buyers: new Set<string>(),
      lastAt: 0,
      estimated: false,
    };
  }

  // Auto-paginate a Stripe list into a single array (READ-ONLY).
  private async listAll<T>(page: Stripe.ApiListPromise<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of page) out.push(item);
    return out;
  }

  private norm(s: string): string {
    return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Strip the sync decorations from a ledger line description so it reads as the
  // bare product name: "1 × Sermorelin (at $130.00 / month)" -> "sermorelin".
  private coreName(s: string): string {
    return this.norm(
      (s || '')
        .replace(/^\s*\d+\s*[×x]\s*/i, '')
        .replace(/\s*\(at\s+\$[\d.,]+\s*\/?\s*\w*\s*\)\s*$/i, ''),
    );
  }

  private addLine(a: ReturnType<ProductsService['emptyAgg']>, l: any, estimated: boolean) {
    const qty = l.quantity || 1;
    a.purchases += 1;
    a.units += qty;
    a.revenue += Number(l.unitAmount) * qty;
    if (l.paymentRecord?.userId) a.buyers.add(l.paymentRecord.userId);
    const at = (l.paymentRecord?.paidAt ?? l.paymentRecord?.createdAt)?.getTime?.() ?? 0;
    if (at > a.lastAt) a.lastAt = at;
    if (estimated) a.estimated = true;
  }

  // ---------------------------------------------------------------------------
  // List every product with its prices and derived sales stats.
  // ---------------------------------------------------------------------------
  async list() {
    // Full pagination — Stripe caps a page at 100, and the live catalog has more
    // than that, so a single page silently dropped products/prices (and their
    // sales). All calls here are READ-ONLY.
    const [products, prices, saleLines] = await Promise.all([
      this.listAll(this.stripe.products.list({ limit: 100 })),
      this.listAll(this.stripe.prices.list({ limit: 100 })),
      this.loadSaleLines(),
    ]);

    const pricesByProduct = new Map<string, Stripe.Price[]>();
    const priceToProduct = new Map<string, string>();
    for (const p of prices) {
      const pid = typeof p.product === 'string' ? p.product : (p.product as Stripe.Product)?.id;
      if (!pid) continue;
      priceToProduct.set(p.id, pid);
      const arr = pricesByProduct.get(pid) ?? [];
      arr.push(p);
      pricesByProduct.set(pid, arr);
    }

    // Attribute each SUCCEEDED ledger line to exactly ONE product. In this data
    // line items carry NO stripePriceId, so attribution is name-based:
    //   1) stripePriceId (exact) when present, else
    //   2) product whose name == the line's "core" name (decorations stripped), else
    //   3) product name contained in the description, else
    //   4) the core name contained in a product name (most specific product wins).
    const aggByProduct = new Map<string, ReturnType<ProductsService['emptyAgg']>>();
    const nameIndex = products
      .map((p) => ({ id: p.id, needle: this.norm(p.name) }))
      .filter((p) => p.needle.length >= 3)
      .sort((a, b) => b.needle.length - a.needle.length); // longest first

    const matchByName = (descRaw: string): string | null => {
      const hay = this.norm(descRaw);
      const c = this.coreName(descRaw);
      let hit = nameIndex.find((n) => n.needle === c); // exact on core
      if (hit) return hit.id;
      hit = nameIndex.find((n) => hay.includes(n.needle)); // product name inside desc
      if (hit) return hit.id;
      if (c.length >= 4) {
        const cand = nameIndex
          .filter((n) => n.needle.includes(c)) // bare desc inside a product name
          .sort((a, b) => a.needle.length - b.needle.length); // most specific (shortest)
        if (cand[0]) return cand[0].id;
      }
      return null;
    };

    for (const line of saleLines) {
      let productId: string | null = null;
      let estimated = false;
      if (line.stripePriceId && priceToProduct.has(line.stripePriceId)) {
        productId = priceToProduct.get(line.stripePriceId)!;
      } else if (line.description) {
        productId = matchByName(line.description);
        estimated = !!productId;
      }
      if (!productId) continue;
      const a = aggByProduct.get(productId) ?? this.emptyAgg();
      this.addLine(a, line, estimated);
      aggByProduct.set(productId, a);
    }

    const items = products.map((product) => {
      const prodPrices = (pricesByProduct.get(product.id) ?? []).sort(
        (a, b) => (b.created || 0) - (a.created || 0),
      );

      const agg = aggByProduct.get(product.id) ?? this.emptyAgg();
      const usedNameFallback = agg.estimated;

      const defaultPriceId =
        typeof product.default_price === 'string'
          ? product.default_price
          : (product.default_price as Stripe.Price | null)?.id ?? prodPrices[0]?.id ?? null;

      return {
        id: product.id,
        name: product.name,
        description: product.description || null,
        active: product.active,
        category: (product.metadata?.formamd_category as string) || null,
        createdAt: product.created ? new Date(product.created * 1000).toISOString() : null,
        defaultPriceId,
        prices: prodPrices.map((pr) => ({
          id: pr.id,
          amount: pr.unit_amount != null ? pr.unit_amount / 100 : null,
          currency: pr.currency,
          interval: pr.recurring?.interval || null,
          recurring: !!pr.recurring,
          active: pr.active,
          isDefault: pr.id === defaultPriceId,
          createdAt: pr.created ? new Date(pr.created * 1000).toISOString() : null,
        })),
        stats: {
          purchases: agg.purchases,
          unitsSold: agg.units,
          revenue: Math.round(agg.revenue * 100) / 100,
          buyers: agg.buyers.size,
          lastSoldAt: agg.lastAt ? new Date(agg.lastAt).toISOString() : null,
          estimated: usedNameFallback,
        },
      };
    });

    // Portfolio totals for the header stat strip.
    const totals = {
      products: items.length,
      active: items.filter((i) => i.active).length,
      archived: items.filter((i) => !i.active).length,
      unitsSold: items.reduce((s, i) => s + i.stats.unitsSold, 0),
      revenue: Math.round(items.reduce((s, i) => s + i.stats.revenue, 0) * 100) / 100,
    };

    items.sort((a, b) => b.stats.revenue - a.stats.revenue);
    return { products: items, totals };
  }

  // ---------------------------------------------------------------------------
  // Create a product + its first price (and set it as the default).
  // ---------------------------------------------------------------------------
  async create(input: CreateProductInput) {
    if (!input.name?.trim()) throw new BadRequestException('Product name is required');
    if (!input.amount || input.amount <= 0) throw new BadRequestException('Amount must be greater than 0');

    const product = await this.stripe.products.create({
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      metadata: input.category ? { formamd_category: input.category } : {},
    });

    const price = await this.stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(input.amount * 100),
      currency: (input.currency || 'usd').toLowerCase(),
      ...(input.recurring ? { recurring: { interval: input.recurring.interval } } : {}),
    });

    await this.stripe.products.update(product.id, { default_price: price.id });
    this.logger.log(`Created product ${product.id} with price ${price.id}`);
    return { ok: true, productId: product.id, priceId: price.id };
  }

  async update(productId: string, input: UpdateProductInput) {
    const patch: Stripe.ProductUpdateParams = {};
    if (input.name != null) patch.name = input.name.trim();
    if (input.description != null) patch.description = input.description.trim() || undefined;
    if (input.active != null) patch.active = input.active;
    if (input.category != null) patch.metadata = { formamd_category: input.category };
    try {
      const product = await this.stripe.products.update(productId, patch);
      return { ok: true, productId: product.id };
    } catch (e: any) {
      throw new BadRequestException(e.message || 'Failed to update product');
    }
  }

  // Prices are immutable in Stripe, so "changing the price" = create a new price,
  // set it as the product default, and (optionally) archive the previous default.
  async changePrice(productId: string, input: ChangePriceInput) {
    if (!input.amount || input.amount <= 0) throw new BadRequestException('Amount must be greater than 0');
    let product: Stripe.Product;
    try {
      product = await this.stripe.products.retrieve(productId);
    } catch {
      throw new NotFoundException('Product not found');
    }
    const oldDefault =
      typeof product.default_price === 'string'
        ? product.default_price
        : (product.default_price as Stripe.Price | null)?.id ?? null;

    const price = await this.stripe.prices.create({
      product: productId,
      unit_amount: Math.round(input.amount * 100),
      currency: (input.currency || 'usd').toLowerCase(),
      ...(input.recurring ? { recurring: { interval: input.recurring.interval } } : {}),
    });
    await this.stripe.products.update(productId, { default_price: price.id });

    if ((input.archiveOld ?? true) && oldDefault && oldDefault !== price.id) {
      try {
        await this.stripe.prices.update(oldDefault, { active: false });
      } catch (e: any) {
        this.logger.warn(`Could not archive old price ${oldDefault}: ${e.message}`);
      }
    }
    return { ok: true, priceId: price.id };
  }

  async setArchived(productId: string, archived: boolean) {
    try {
      await this.stripe.products.update(productId, { active: !archived });
      return { ok: true };
    } catch (e: any) {
      throw new BadRequestException(e.message || 'Failed to update product');
    }
  }
}
