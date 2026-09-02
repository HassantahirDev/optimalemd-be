import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Builds a short-lived auto-login link that drops a patient straight into a given
 * page of the dashboard from an email — no re-entering credentials. Shared by every
 * "click here to do X" patient email (lab results → book follow-up, no-show →
 * reschedule, etc.) so they all behave identically.
 */
export function buildAutoLoginLink(
  jwtService: JwtService,
  configService: ConfigService,
  patient: { id: string; primaryEmail: string | null; firstName?: string | null },
  next: string,
): string {
  // Patient emails always target production, matching the verification-email pattern.
  const base = (configService.get<string>('PUBLIC_APP_URL') || 'https://formamd.com').replace(/\/+$/, '');
  try {
    const token = jwtService.sign(
      // userType is REQUIRED by JwtStrategy.validate — without it every guarded
      // call (e.g. /auth/me) returns 401 "Invalid token payload".
      // name/email are carried so the auto-login page can populate localStorage
      // identically to the regular email+password login flow.
      { sub: patient.id, email: patient.primaryEmail, userType: 'user', name: patient.firstName || '' },
      { expiresIn: '3d' },
    );
    return `${base}/auto-login?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
  } catch (e) {
    // If token signing fails, still give a usable link (they'll log in manually).
    return `${base}${next}`;
  }
}
