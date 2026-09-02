import { Module } from '@nestjs/common';
import { EmailCheckerController } from './email-checker.controller';
import { EmailCheckerKeyGuard } from './email-checker-key.guard';
import { MailerModule } from '../mailer/mailer.module';

@Module({
  imports: [MailerModule],
  controllers: [EmailCheckerController],
  providers: [EmailCheckerKeyGuard],
})
export class EmailCheckerModule {}
