import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Fallback key used only when EMAIL_CHECKER_KEY isn't set in the environment (e.g. a
// deploy target where the env var was never added). Set EMAIL_CHECKER_KEY in env to
// override this with your own value — that always takes priority.
const FALLBACK_KEY = 'fmd-email-checker-9f3a7c2e1b';

/**
 * Lightweight protection for the standalone /email-checker tool. This is a diagnostic
 * utility reachable at its own URL, deliberately outside the normal admin-login flow — so
 * instead of requiring a full JWT session, it's gated by a single shared key sent as the
 * `x-checker-key` header. Reads EMAIL_CHECKER_KEY from env if present, otherwise falls
 * back to the hardcoded key above — the tool is never disabled for lack of env config.
 */
@Injectable()
export class EmailCheckerKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedKey = this.configService.get<string>('EMAIL_CHECKER_KEY') || FALLBACK_KEY;

    const req = context.switchToHttp().getRequest();
    const providedKey = req.headers['x-checker-key'];
    if (!providedKey || providedKey !== expectedKey) {
      throw new UnauthorizedException('Invalid or missing access key.');
    }
    return true;
  }
}
