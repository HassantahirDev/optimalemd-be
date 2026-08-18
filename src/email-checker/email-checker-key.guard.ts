import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Lightweight protection for the standalone /email-checker tool. This is a diagnostic
 * utility reachable at its own URL, deliberately outside the normal admin-login flow — so
 * instead of requiring a full JWT session, it's gated by a single shared key set via
 * EMAIL_CHECKER_KEY, sent as the `x-checker-key` header. If the env var isn't set, the
 * tool refuses all requests rather than ever being silently open to spam-relay abuse.
 */
@Injectable()
export class EmailCheckerKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedKey = this.configService.get<string>('EMAIL_CHECKER_KEY');
    if (!expectedKey) {
      throw new ServiceUnavailableException(
        'Email checker is disabled: set EMAIL_CHECKER_KEY in the environment to enable it.',
      );
    }

    const req = context.switchToHttp().getRequest();
    const providedKey = req.headers['x-checker-key'];
    if (!providedKey || providedKey !== expectedKey) {
      throw new UnauthorizedException('Invalid or missing access key.');
    }
    return true;
  }
}
