import { IsEmail, IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendTestEmailDto {
  @ApiProperty({ description: 'Address to send the test email to', example: 'you@example.com' })
  @IsEmail()
  to: string;

  @ApiPropertyOptional({
    description: 'Which env-configured mail account to send from',
    enum: ['default', 'appointment'],
    default: 'default',
  })
  @IsOptional()
  @IsIn(['default', 'appointment'])
  account?: 'default' | 'appointment';
}
