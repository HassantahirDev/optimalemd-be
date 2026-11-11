import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type UspsTrackingStatus = 'LABEL_CREATED' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'ALERT' | 'UNKNOWN';

export interface UspsTrackingResult {
  trackingNumber: string;
  status: UspsTrackingStatus;
  detail: string | null;
  eventAt: Date | null;
}

export interface UspsAddress {
  firstName: string;
  lastName: string;
  streetAddress: string;
  secondaryAddress?: string | null;
  city: string;
  state: string;
  ZIPCode: string;
}

export interface UspsPackage {
  mailClass: string; // USPS_GROUND_ADVANTAGE | PRIORITY_MAIL
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

/**
 * Thin client for the USPS APIs (developers.usps.com). Credentials come from the
 * client's USPS developer app: USPS_CONSUMER_KEY / USPS_CONSUMER_SECRET, against
 * USPS_API_BASE (https://apis-tem.usps.com for testing, https://apis.usps.com live).
 * Tracking always reads live USPS data (USPS_TRACKING_BASE to override): the test
 * environment has no real packages, and looking a package up costs nothing.
 *
 * What each call needs on the USPS side:
 *  - prices, tracking: the default app access.
 *  - labels: Labels + Payments API access enabled by USPS (APISupport@usps.gov), plus
 *    the account's CRID, MIDs and EPS account in USPS_CRID / USPS_MID /
 *    USPS_MANIFEST_MID / USPS_EPS_ACCOUNT, and the return address in USPS_FROM_*.
 */
@Injectable()
export class UspsService {
  private readonly logger = new Logger(UspsService.name);
  private tokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly config: ConfigService) {}

  private get base() {
    return (this.config.get<string>('USPS_API_BASE') || 'https://apis.usps.com').replace(/\/$/, '');
  }

  private get trackingBase() {
    return (this.config.get<string>('USPS_TRACKING_BASE') || 'https://apis.usps.com').replace(/\/$/, '');
  }

  isConfigured() {
    return !!(this.config.get<string>('USPS_CONSUMER_KEY') && this.config.get<string>('USPS_CONSUMER_SECRET'));
  }

  /** Labels also need the account identifiers for the payment token. */
  labelsConfigured() {
    return (
      this.isConfigured() &&
      ['USPS_CRID', 'USPS_MID', 'USPS_EPS_ACCOUNT', 'USPS_FROM_STREET', 'USPS_FROM_CITY', 'USPS_FROM_STATE', 'USPS_FROM_ZIP'].every(
        (k) => !!this.config.get<string>(k),
      )
    );
  }

  private async accessToken(base: string): Promise<string> {
    const cached = this.tokens.get(base);
    if (cached && Date.now() < cached.expiresAt) return cached.value;
    if (!this.isConfigured()) throw new ServiceUnavailableException('USPS is not configured (USPS_CONSUMER_KEY / USPS_CONSUMER_SECRET).');
    const res = await fetch(`${base}/oauth2/v3/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.get<string>('USPS_CONSUMER_KEY')!,
        client_secret: this.config.get<string>('USPS_CONSUMER_SECRET')!,
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new ServiceUnavailableException(`USPS sign-in failed: ${body.error_description || body.error || res.status}`);
    }
    // Refresh a few minutes before USPS expires it (tokens last ~8 hours).
    this.tokens.set(base, { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in || 3600) - 300) * 1000 });
    return body.access_token;
  }

  private async call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}, base = this.base) {
    const token = await this.accessToken(base);
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  }

  private static errorMessage(body: any, fallback: string) {
    const e = body?.error;
    return e?.errors?.[0]?.detail || e?.message || (typeof body === 'string' ? body.slice(0, 200) : fallback);
  }

  // ---------------------------------------------------------------- tracking --
  /** Latest status for up to 35 tracking numbers per call (USPS batch limit). */
  async track(trackingNumbers: string[]): Promise<UspsTrackingResult[]> {
    const out: UspsTrackingResult[] = [];
    for (let i = 0; i < trackingNumbers.length; i += 35) {
      const batch = trackingNumbers.slice(i, i + 35);
      const res = await this.call(
        '/tracking/v3r2/tracking',
        { method: 'POST', body: JSON.stringify(batch.map((trackingNumber) => ({ trackingNumber }))) },
        this.trackingBase,
      );
      // An unknown number comes back as a 404 error body, not an array — and so does
      // a whole batch when none of it is known. Check a failed batch one by one.
      if (!res.ok && !Array.isArray(res.body)) {
        if (res.status === 404 && batch.length === 1) {
          out.push({ trackingNumber: batch[0], status: 'UNKNOWN', detail: UspsService.errorMessage(res.body, 'Not found'), eventAt: null });
          continue;
        }
        if (res.status === 404) {
          for (const n of batch) out.push(...(await this.track([n])));
          continue;
        }
        throw new ServiceUnavailableException(`USPS tracking failed (${res.status}): ${UspsService.errorMessage(res.body, 'error')}`);
      }
      const items: any[] = Array.isArray(res.body) ? res.body : res.body?.trackingResults || [res.body];
      for (const n of batch) {
        const item = items.find((x) => String(x?.trackingNumber || '').replace(/\s/g, '') === n) || null;
        out.push(UspsService.parseTracking(n, item));
      }
    }
    return out;
  }

  /**
   * USPS doesn't publish a fixed list of status values, so map on the words it
   * uses: "Delivered", "Out for Delivery", "In Transit", "Accepted", "Pre-Shipment"
   * / "Label Created", "Alert" / "Return to Sender" / "Delivery Exception".
   */
  static parseTracking(trackingNumber: string, item: any): UspsTrackingResult {
    if (!item || item.error || item.errors) {
      const detail = item ? UspsService.errorMessage(item, 'No tracking information yet') : 'No tracking information yet';
      return { trackingNumber, status: 'UNKNOWN', detail, eventAt: null };
    }
    const events: any[] = item.trackingEvents || item.events || [];
    const latest = events
      .slice()
      .sort((a, b) => String(b.eventTimestamp || '').localeCompare(String(a.eventTimestamp || '')))[0];
    const words = [item.statusCategory, item.status, latest?.eventType, item.statusSummary].filter(Boolean).join(' | ');
    const t = words.toLowerCase();
    const status: UspsTrackingStatus = /\bdelivered\b/.test(t) && !/attempt|exception|not delivered|undeliverable/.test(t)
      ? 'DELIVERED'
      : /out for delivery/.test(t)
        ? 'OUT_FOR_DELIVERY'
        : /alert|exception|return to sender|returned|undeliverable|held|refused|damaged|attempt/.test(t)
          ? 'ALERT'
          : /pre-?shipment|label created|shipping label|awaiting item|not yet in system/.test(t)
            ? 'LABEL_CREATED'
            : /transit|accepted|arrived|departed|processed|picked up|in possession|moving/.test(t)
              ? 'IN_TRANSIT'
              : 'UNKNOWN';
    const eventAt = latest?.eventTimestamp ? new Date(latest.eventTimestamp) : null;
    const detail = item.statusSummary || latest?.eventType || item.status || item.statusCategory || null;
    return { trackingNumber, status, detail, eventAt: eventAt && !isNaN(+eventAt) ? eventAt : null };
  }

  // ------------------------------------------------------------------ prices --
  /** Commercial postage for one package (works with the default app access). */
  async quote(fromZip: string, toZip: string, pkg: UspsPackage): Promise<{ price: number; description: string }> {
    const res = await this.call('/prices/v3/base-rates/search', {
      method: 'POST',
      body: JSON.stringify({
        originZIPCode: fromZip,
        destinationZIPCode: toZip.slice(0, 5),
        weight: Math.max(pkg.weightOz, 0.1) / 16,
        length: pkg.lengthIn,
        width: pkg.widthIn,
        height: pkg.heightIn,
        mailClass: pkg.mailClass,
        processingCategory: 'MACHINABLE',
        rateIndicator: 'SP',
        destinationEntryFacilityType: 'NONE',
        priceType: 'COMMERCIAL',
      }),
    });
    if (!res.ok) throw new BadRequestException(`USPS price lookup failed: ${UspsService.errorMessage(res.body, String(res.status))}`);
    return { price: Number(res.body?.totalBasePrice ?? 0), description: res.body?.rates?.[0]?.description || pkg.mailClass };
  }

  // ------------------------------------------------------------------ labels --
  private async paymentToken(): Promise<string> {
    const crid = this.config.get<string>('USPS_CRID');
    const mid = this.config.get<string>('USPS_MID');
    const manifestMid = this.config.get<string>('USPS_MANIFEST_MID') || mid;
    const res = await this.call('/payments/v3/payment-authorization', {
      method: 'POST',
      body: JSON.stringify({
        roles: [
          { roleName: 'PAYER', CRID: crid, MID: mid, manifestMID: manifestMid, accountType: 'EPS', accountNumber: this.config.get<string>('USPS_EPS_ACCOUNT') },
          { roleName: 'LABEL_OWNER', CRID: crid, MID: mid, manifestMID: manifestMid },
        ],
      }),
    });
    if (!res.ok || !res.body?.paymentAuthorizationToken) {
      throw new ServiceUnavailableException(
        `USPS payment authorization failed (${res.status}): ${UspsService.errorMessage(res.body, 'error')}. ` +
          'Labels need the Payments + Labels APIs enabled for this USPS app and a valid CRID/MID/EPS account.',
      );
    }
    return res.body.paymentAuthorizationToken;
  }

  /** Buys a label. Returns the tracking number, postage and the 4x6 label PDF. */
  async createLabel(to: UspsAddress, pkg: UspsPackage): Promise<{ trackingNumber: string; postage: number | null; pdf: Buffer }> {
    if (!this.labelsConfigured()) {
      throw new ServiceUnavailableException(
        'USPS labels are not set up yet: add USPS_CRID, USPS_MID, USPS_EPS_ACCOUNT and the USPS_FROM_* return address, and ask USPS to enable the Labels API.',
      );
    }
    const paymentToken = await this.paymentToken();
    const c = (k: string) => this.config.get<string>(k) || '';
    const res = await this.call('/labels/v3/label', {
      method: 'POST',
      headers: { 'X-Payment-Authorization-Token': paymentToken, Accept: 'application/vnd.usps.labels+json' },
      body: JSON.stringify({
        imageInfo: { imageType: 'PDF', labelType: '4X6LABEL' },
        toAddress: to,
        fromAddress: {
          firmName: c('USPS_FROM_NAME') || 'FormaMD',
          streetAddress: c('USPS_FROM_STREET'),
          secondaryAddress: c('USPS_FROM_STREET2') || undefined,
          city: c('USPS_FROM_CITY'),
          state: c('USPS_FROM_STATE'),
          ZIPCode: c('USPS_FROM_ZIP'),
          phone: c('USPS_FROM_PHONE') || undefined,
        },
        packageDescription: {
          mailClass: pkg.mailClass,
          rateIndicator: 'SP',
          weightUOM: 'lb',
          weight: Math.max(pkg.weightOz, 0.1) / 16,
          dimensionsUOM: 'in',
          length: pkg.lengthIn,
          width: pkg.widthIn,
          height: pkg.heightIn,
          processingCategory: 'MACHINABLE',
          mailingDate: new Date().toISOString().slice(0, 10),
          destinationEntryFacilityType: 'NONE',
        },
      }),
    });
    if (!res.ok) throw new BadRequestException(`USPS label failed (${res.status}): ${UspsService.errorMessage(res.body, 'error')}`);
    const meta = res.body?.labelMetadata || res.body;
    const image = res.body?.labelImage || res.body?.labelImages?.[0];
    if (!meta?.trackingNumber || !image) {
      this.logger.warn(`[usps] unexpected label response keys: ${Object.keys(res.body || {}).join(',')}`);
      throw new BadRequestException('USPS returned a label response without a tracking number or image.');
    }
    return {
      trackingNumber: String(meta.trackingNumber).replace(/\s/g, ''),
      postage: meta.postage != null ? Number(meta.postage) : null,
      pdf: Buffer.from(image, 'base64'),
    };
  }
}
