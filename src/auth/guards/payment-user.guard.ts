import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * PaymentUserGuard — allows ONLY authenticated payment-portal users.
 *
 * Use together with JwtAuthGuard: `@UseGuards(JwtAuthGuard, PaymentUserGuard)`.
 * JwtAuthGuard validates the token and populates req.user; this guard then
 * rejects anything whose userType is not 'payment'. This is what keeps admins,
 * doctors, and patients out of every /payments/* endpoint — even with a valid
 * token of their own.
 */
@Injectable()
export class PaymentUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;

    if (!user || user.userType !== 'payment') {
      throw new ForbiddenException('Payments portal access is restricted to payment users.');
    }
    return true;
  }
}
