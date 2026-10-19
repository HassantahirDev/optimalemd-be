import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * PartnerGuard — allows ONLY authenticated referral partners.
 *
 * Use together with JwtAuthGuard: `@UseGuards(JwtAuthGuard, PartnerGuard)`.
 * JwtAuthGuard validates the token and populates req.user; this guard then
 * rejects anything whose userType is not 'partner'. This is what keeps admins,
 * doctors, and patients out of every /partners/me/* endpoint — even with a
 * valid token of their own.
 */
@Injectable()
export class PartnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;

    if (!user || user.userType !== 'partner') {
      throw new ForbiddenException('Partner portal access is restricted to referral partners.');
    }
    return true;
  }
}
