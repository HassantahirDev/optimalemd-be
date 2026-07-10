import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { NewSignupService } from './new-signup.service';
import { NewSignupController } from './new-signup.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AssistantPermissionGuard } from './guards/assistant-permission.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { MailerModule } from '../mailer/mailer.module';
import { StripeModule } from '../stripe/stripe.module';
import { ReferralModule } from '../referral/referral.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    PrismaModule,
    MailerModule,
    StripeModule,
    ReferralModule,
    PaymentsModule,
    PassportModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRES_IN', '7d'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, NewSignupController],
  providers: [
    AuthService,
    NewSignupService,
    JwtStrategy,
    { provide: APP_GUARD, useClass: AssistantPermissionGuard },
  ],
  exports: [AuthService, NewSignupService, JwtStrategy],
})
export class AuthModule {}
