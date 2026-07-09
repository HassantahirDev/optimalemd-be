import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  AddressSuggestion,
  AddressValidationResult,
  StandardizedAddress,
  ValidateAddressDto,
} from './dto/address.dto';

@Injectable()
export class AddressService {
  private readonly logger = new Logger(AddressService.name);

  // Cached USPS OAuth token
  private uspsToken: string | null = null;
  private uspsTokenExpiry = 0;

  constructor(private readonly configService: ConfigService) {}

  // ---------------------------------------------------------------------------
  // AUTOCOMPLETE  (free — OpenStreetMap / Nominatim, proxied so we can send the
  // User-Agent that Nominatim's usage policy requires; browsers can't set one)
  // ---------------------------------------------------------------------------
  async autocomplete(query: string): Promise<AddressSuggestion[]> {
    const q = (query || '').trim();
    if (q.length < 3) return [];

    try {
      const res = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: {
          q,
          format: 'jsonv2',
          addressdetails: 1,
          countrycodes: 'us',
          limit: 6,
        },
        headers: {
          'User-Agent': 'FormaMD/1.0 (address-autocomplete; support@formamd.com)',
          'Accept-Language': 'en-US',
        },
        timeout: 8000,
      });

      const items = Array.isArray(res.data) ? res.data : [];
      return items
        .map((item: any) => this.nominatimToSuggestion(item))
        .filter((s: AddressSuggestion | null): s is AddressSuggestion => !!s);
    } catch (err: any) {
      this.logger.warn(`Nominatim autocomplete failed: ${err?.message}`);
      return [];
    }
  }

  private nominatimToSuggestion(item: any): AddressSuggestion | null {
    const a = item.address || {};
    const houseNumber = a.house_number || '';
    const road = a.road || a.pedestrian || a.hamlet || '';
    const street = [houseNumber, road].filter(Boolean).join(' ').trim();
    const city =
      a.city || a.town || a.village || a.suburb || a.county || '';
    const state = this.stateNameToCode(a.state) || a.state || '';
    const zip = a.postcode || '';

    // Only surface things that look like real street addresses
    if (!road) return null;

    return {
      label: item.display_name,
      street,
      city,
      state,
      zip,
      lat: item.lat,
      lon: item.lon,
    };
  }

  // ---------------------------------------------------------------------------
  // VALIDATION  (USPS if credentials present, else free US Census fallback)
  // ---------------------------------------------------------------------------
  async validate(dto: ValidateAddressDto): Promise<AddressValidationResult> {
    const hasUsps =
      !!this.configService.get<string>('USPS_CLIENT_ID') &&
      !!this.configService.get<string>('USPS_CLIENT_SECRET');

    if (hasUsps) {
      try {
        return await this.validateWithUsps(dto);
      } catch (err: any) {
        this.logger.warn(
          `USPS validation failed, falling back to Census: ${err?.message}`,
        );
      }
    }

    return this.validateWithCensus(dto);
  }

  // ---- USPS Addresses API v3 (https://developer.usps.com) --------------------
  private async getUspsToken(): Promise<string> {
    const now = Date.now();
    if (this.uspsToken && now < this.uspsTokenExpiry - 30_000) {
      return this.uspsToken;
    }

    const base =
      this.configService.get<string>('USPS_BASE_URL') || 'https://apis.usps.com';
    const clientId = this.configService.get<string>('USPS_CLIENT_ID');
    const clientSecret = this.configService.get<string>('USPS_CLIENT_SECRET');

    const res = await axios.post(
      `${base}/oauth2/v3/token`,
      {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 },
    );

    const token = res.data?.access_token;
    const expiresIn = Number(res.data?.expires_in || 3600);
    if (!token) throw new Error('USPS token response missing access_token');

    this.uspsToken = token;
    this.uspsTokenExpiry = now + expiresIn * 1000;
    return token;
  }

  private async validateWithUsps(
    dto: ValidateAddressDto,
  ): Promise<AddressValidationResult> {
    const base =
      this.configService.get<string>('USPS_BASE_URL') || 'https://apis.usps.com';
    const token = await this.getUspsToken();

    const res = await axios.get(`${base}/addresses/v3/address`, {
      params: {
        streetAddress: dto.street,
        secondaryAddress: dto.secondary || undefined,
        city: dto.city,
        state: dto.state,
        ZIPCode: dto.zip,
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });

    const addr = res.data?.address;
    if (!addr || !addr.streetAddress) {
      return {
        valid: false,
        source: 'usps',
        message: 'USPS could not find a matching address.',
        raw: res.data,
      };
    }

    const standardized: StandardizedAddress = {
      street: addr.streetAddress,
      secondary: addr.secondaryAddress || undefined,
      city: addr.city,
      state: addr.state,
      zip: addr.ZIPCode,
      zipPlus4: addr.ZIPPlus4 || undefined,
    };

    return {
      valid: true,
      source: 'usps',
      standardized,
      message: 'Address verified by USPS.',
      raw: res.data,
    };
  }

  // ---- Free fallback: US Census Bureau geocoder (no key required) -----------
  private async validateWithCensus(
    dto: ValidateAddressDto,
  ): Promise<AddressValidationResult> {
    const oneLine = [
      [dto.street, dto.secondary].filter(Boolean).join(' '),
      dto.city,
      dto.state,
      dto.zip,
    ]
      .filter(Boolean)
      .join(', ');

    try {
      const res = await axios.get(
        'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress',
        {
          params: {
            address: oneLine,
            benchmark: 'Public_AR_Current',
            format: 'json',
          },
          timeout: 8000,
        },
      );

      const matches = res.data?.result?.addressMatches || [];
      if (!matches.length) {
        return {
          valid: false,
          source: 'census',
          message:
            'No matching US address found. Please double-check the address.',
          raw: res.data,
        };
      }

      const m = matches[0];
      const c = m.addressComponents || {};

      // matchedAddress is the fully standardized single line, e.g.
      // "1600 AMPHITHEATRE PKWY, MOUNTAIN VIEW, CA, 94043" — its first segment
      // keeps the real house number (the addressComponents give a block range).
      const matchedStreet =
        typeof m.matchedAddress === 'string'
          ? m.matchedAddress.split(',')[0].trim()
          : '';

      const standardized: StandardizedAddress = {
        street: matchedStreet || dto.street,
        city: c.city || dto.city,
        state: c.state || dto.state,
        zip: c.zip || dto.zip,
      };

      return {
        valid: true,
        source: 'census',
        standardized,
        message:
          'Address confirmed against the US Census database (USPS fallback).',
        raw: { matchedAddress: m.matchedAddress, coordinates: m.coordinates },
      };
    } catch (err: any) {
      this.logger.warn(`Census validation failed: ${err?.message}`);
      return {
        valid: false,
        source: 'none',
        message:
          'Address validation service is temporarily unavailable. Please try again.',
      };
    }
  }

  // ---------------------------------------------------------------------------
  private stateNameToCode(name?: string): string | null {
    if (!name) return null;
    const map: Record<string, string> = {
      alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
      california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
      'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI',
      idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
      kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
      massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
      missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
      'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
      'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
      ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
      'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
      tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
      virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
      wisconsin: 'WI', wyoming: 'WY',
    };
    return map[name.toLowerCase()] || null;
  }
}
