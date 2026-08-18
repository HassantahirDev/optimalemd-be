import { Controller, Get, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { MailerService } from '../mailer/mailer.service';
import { EmailCheckerKeyGuard } from './email-checker-key.guard';
import { SendTestEmailDto } from './dto/email-checker.dto';

/**
 * Standalone diagnostic tool — confirms outbound email is actually working, and lets you
 * test any of the mail accounts configured in env against any address. Deliberately its own
 * URL/module, gated by EmailCheckerKeyGuard instead of the normal admin login.
 */
@ApiTags('Email Checker (diagnostic)')
@ApiHeader({ name: 'x-checker-key', description: 'Shared key from EMAIL_CHECKER_KEY' })
@UseGuards(EmailCheckerKeyGuard)
@Controller('email-checker')
export class EmailCheckerController {
  constructor(private readonly mailerService: MailerService) {}

  @Get('accounts')
  @ApiOperation({ summary: 'List the mail accounts configured in env' })
  getAccounts() {
    return { success: true, data: this.mailerService.getEmailAccountsInfo() };
  }

  @Post('send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a fixed test email to the given address via the chosen account' })
  async send(@Body() body: SendTestEmailDto) {
    try {
      const result = await this.mailerService.sendTestEmail(body.to, body.account || 'default');
      return {
        success: true,
        message: result.noop
          ? 'Send call completed, but this account has NO real SMTP credentials configured — nothing was actually delivered.'
          : `Test email sent to ${body.to}.`,
        data: result,
      };
    } catch (error: any) {
      return {
        success: false,
        message: error?.message || 'Failed to send test email.',
      };
    }
  }
}
