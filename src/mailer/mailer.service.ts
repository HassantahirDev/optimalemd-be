import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MailerService implements OnModuleInit {
  private transporter: nodemailer.Transporter;
  private appointmentTransporter: nodemailer.Transporter;
  private isNoopTransport = false;
  private isAppointmentNoopTransport = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    // Initialize default transporter
    await this.initializeDefaultTransporter();
    
    // Initialize appointment-specific transporter
    await this.initializeAppointmentTransporter();
  }

  private async initializeDefaultTransporter() {
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT');
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASS');

    if (!user || !pass) {
      this.transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true,
      } as any);
      this.isNoopTransport = true;
      console.warn('Default mailer running in no-op mode: missing SMTP_USER/SMTP_PASS');
      return;
    }

    const useSecure = Number(port) === 465;
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      host: host || 'smtp.gmail.com',
      port: Number(port) || 587,
      secure: useSecure,
      auth: { user, pass },
    });

    try {
      await this.transporter.verify();
      console.log('Default mailer service is ready');
    } catch (error) {
      console.error('Failed to initialize default SMTP transport, falling back to no-op transport:', error);
      this.transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true,
      } as any);
      this.isNoopTransport = true;
    }
  }

  private async initializeAppointmentTransporter() {
    const host = this.configService.get<string>('APPOINTMENT_SMTP_HOST');
    const port = this.configService.get<number>('APPOINTMENT_SMTP_PORT');
    const user = this.configService.get<string>('APPOINTMENT_SMTP_USER');
    const pass = this.configService.get<string>('APPOINTMENT_SMTP_PASS');

    // If appointment-specific config is not provided, use default transporter
    if (!user || !pass) {
      console.log('Appointment email config not found, using default transporter');
      this.appointmentTransporter = this.transporter;
      this.isAppointmentNoopTransport = this.isNoopTransport;
      return;
    }

    const useSecure = Number(port) === 465;
    this.appointmentTransporter = nodemailer.createTransport({
      service: 'gmail',
      host: host || 'smtp.gmail.com',
      port: Number(port) || 587,
      secure: useSecure,
      auth: { user, pass },
    });

    try {
      await this.appointmentTransporter.verify();
      console.log('Appointment mailer service is ready');
    } catch (error) {
      console.error('Failed to initialize appointment SMTP transport, falling back to default:', error);
      this.appointmentTransporter = this.transporter;
      this.isAppointmentNoopTransport = this.isNoopTransport;
    }
  }

  async sendEmail(
    to: string,
    subject: string,
    text: string,
    html?: string,
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject,
        text,
        html,
      });
      const note = this.isNoopTransport ? '(no-op transport)' : '';
      console.log(`Email sent successfully to ${to} ${note}`);
    } catch (error) {
      console.error('Failed to send email:', error);
      throw error;
    }
  }

  async sendEmailWithAttachment(
    to: string,
    subject: string,
    text: string,
    attachments: Array<{ filename: string; path: string; contentType?: string }>,
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject,
        text,
        attachments,
      });
      const note = this.isNoopTransport ? '(no-op transport)' : '';
      console.log(`Email with attachment sent successfully to ${to} ${note}`);
    } catch (error) {
      console.error('Failed to send email with attachment:', error);
      throw error;
    }
  }

  async sendEmailVerificationEmail(to: string, name: string, verificationLink: string): Promise<void> {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .verification-button {
            display: inline-block;
            background-color: #000000;
            color: #ffffff !important;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            font-size: 16px;
            margin: 20px 0;
          }
          .info-box {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #000000;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
          .link-fallback {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border: 1px solid #e9ecef;
            color: #666666;
            font-size: 14px;
          }
          .link-fallback a {
            color: #000000;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Verify Your Email</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">Please verify your email address to complete your registration.</p>
            
            <a href="${verificationLink}" class="verification-button">Verify Email</a>
            
            <div class="info-box">
              <p style="margin: 0; color: #000000; font-weight: bold;">⏰ This link expires in 1 hour</p>
            </div>
            
            <div class="link-fallback">
              <p style="margin: 0 0 10px 0;"><strong>Manual Link:</strong></p>
              <p style="margin: 0;">If the button doesn't work, copy this link:</p>
              <a href="${verificationLink}">${verificationLink}</a>
            </div>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Verify Your Email - FormaMD',
        html,
      });
      console.log(`Email verification email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send email verification email:', error);
      throw error;
    }
  }

  async sendPasswordResetEmail(to: string, name: string, resetLink: string): Promise<void> {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .reset-button {
            display: inline-block;
            background-color: #000000;
            color: #ffffff !important;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            font-size: 16px;
            margin: 20px 0;
          }
          .info-box {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #000000;
          }
          .warning-box {
            background-color: #fff3cd;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #ffc107;
            color: #856404;
            font-size: 14px;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
          .link-fallback {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border: 1px solid #e9ecef;
            color: #666666;
            font-size: 14px;
          }
          .link-fallback a {
            color: #000000;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Reset Your Password</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">We received a request to reset your password. Click the button below to create a new password.</p>
            
            <a href="${resetLink}" class="reset-button">Reset Password</a>
            
            <div class="info-box">
              <p style="margin: 0; color: #000000; font-weight: bold;">⏰ This link expires in 1 hour</p>
            </div>
            
            <div class="warning-box">
              <p style="margin: 0;"><strong>⚠️ Security Notice:</strong></p>
              <p style="margin: 5px 0 0 0;">If you didn't request this password reset, please ignore this email.</p>
            </div>
            
            <div class="link-fallback">
              <p style="margin: 0 0 10px 0;"><strong>Manual Link:</strong></p>
              <p style="margin: 0;">If the button doesn't work, copy this link:</p>
              <a href="${resetLink}">${resetLink}</a>
            </div>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Reset Your Password - FormaMD',
        html,
      });
      console.log(`Password reset email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send password reset email:', error);
      throw error;
    }
  }

  async sendWelcomeEmail(to: string, name: string): Promise<void> {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .welcome-message {
            background-color: #f8f9fa;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #000000;
            color: #333333;
            font-size: 16px;
          }
          .welcome-icon {
            font-size: 32px;
            margin-bottom: 15px;
            display: block;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
          .cta-section {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 25px 0;
            border: 1px solid #e9ecef;
            color: #666666;
            font-size: 16px;
          }
          .cta-button {
            display: inline-block;
            background-color: #000000;
            color: #ffffff !important;
            padding: 12px 25px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            font-size: 16px;
            margin-top: 15px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Welcome to FormaMD!</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">Welcome to FormaMD! Your account has been successfully verified.</p>
            
            <div class="welcome-message">
              <span class="welcome-icon">🎉</span>
              <p style="margin: 0 0 10px 0; color: #000000; font-weight: bold; font-size: 18px;">Your account is now active!</p>
              <p style="margin: 0;">You can now access all features of FormaMD.</p>
            </div>
            
            <div class="cta-section">
              <p style="margin: 0 0 10px 0;"><strong>Ready to get started?</strong></p>
              <p style="margin: 0;">Log in to your account and explore our services.</p>
              <a href="${this.configService.get<string>('frontend.url')}/login" class="cta-button">Login Now</a>
            </div>
            
            <p class="description">Thank you for choosing FormaMD!</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Welcome to FormaMD!',
        html,
      });
      console.log(`Welcome email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send welcome email:', error);
      throw error;
    }
  }

  async sendAppointmentConfirmationEmail(
    patientEmail: string, 
    patientName: string, 
    doctorName: string, 
    serviceName: string, 
    appointmentDate: string, 
    appointmentTime: string,
    amount: string,
    googleMeetLink?: string,
    timezone?: string, // Optional IANA timezone (e.g., "America/Chicago"). Defaults to doctor's timezone (CST) if not provided.
    additionalServices?: Array<{ id: string; name: string; duration: number }> // Optional additional services
  ): Promise<void> {
    // Convert UTC time to specified timezone (or UTC if not provided)
    const [hours, minutes] = appointmentTime.split(':').map(Number);
    const [year, month, day] = appointmentDate.split('-').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));
    
    // Use Intl.DateTimeFormat to convert to specified timezone (or UTC)
    const targetTimezone = timezone || 'America/Chicago';
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    
    // Format time in target timezone
    const formattedTime = timeFormatter.format(utcDate);
    // Extract hour and minute from formatted string (e.g., "08:00 AM" or "8:00 AM")
    const timeMatch = formattedTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const displayTime = timeMatch ? `${timeMatch[1]}:${timeMatch[2]} ${timeMatch[3]}` : formattedTime;
    
    // Add timezone indicator
    const timezoneAbbr = this.getTimezoneAbbreviation(targetTimezone, utcDate);
    const localTime = `${displayTime} ${timezoneAbbr ? `(${timezoneAbbr})` : '(UTC)'}`;
    
    // Format date based on appointmentDate string directly (not from UTC date object)
    // This matches the frontend logic: extract YYYY-MM-DD and create local date to avoid timezone shift
    // This ensures the date is correct even when time crosses midnight in UTC
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    // Create a local date from the date string (not UTC) to match frontend behavior
    const localDateObj = new Date(year, month - 1, day);
    const localDate = dateFormatter.format(localDateObj);
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .appointment-details {
            background-color: #f8f9fa;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #28a745;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
            font-weight: bold;
            color: #000000;
            font-size: 18px;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Appointment Confirmed!</h2>
            <p class="description">Hi ${patientName},</p>
            <p class="description">Your appointment has been successfully confirmed. Here are the details:</p>
            
            <div class="appointment-details">
              <div class="detail-row">
                <span class="detail-label">Doctor:</span>
                <span class="detail-value">${doctorName}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Service${additionalServices && additionalServices.length > 0 ? 's' : ''}:</span>
                <span class="detail-value">${serviceName}${additionalServices && additionalServices.length > 0 ? `, ${additionalServices.map(s => s.name).join(', ')}` : ''}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Date:</span>
                <span class="detail-value">${localDate}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span class="detail-value">${localTime}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Amount Paid:</span>
                <span class="detail-value">$${amount}</span>
              </div>
            </div>
            
            <p class="description">Please arrive 10 minutes before your scheduled time.</p>
            ${googleMeetLink ? `
            <div style="background-color: #e8f5e8; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #28a745;">
              <h3 style="color: #28a745; margin-top: 0;">Video Consultation</h3>
              <p style="color: #333; margin-bottom: 15px;">This is a telemedicine appointment. Please use the Google Meet link below to join your video consultation:</p>
              <a href="${googleMeetLink}" style="display: inline-block; background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 10px 0;">Join Google Meet</a>
              <p style="color: #666; font-size: 14px; margin-top: 10px;">Or copy this link: <span style="word-break: break-all;">${googleMeetLink}</span></p>
            </div>
            ` : ''}
            <p class="description">If you need to reschedule or cancel, please do so at least 1 hour before your appointment.</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const fromEmail = this.configService.get<string>('APPOINTMENT_SMTP_FROM') || this.configService.get<string>('SMTP_FROM');
      await this.appointmentTransporter.sendMail({
        from: `"FormaMD" <${fromEmail}>`,
        to: patientEmail,
        subject: 'Appointment Confirmed - FormaMD',
        html,
      });
      console.log(`Appointment confirmation email sent successfully to ${patientEmail}`);
    } catch (error) {
      console.error('Failed to send appointment confirmation email:', error);
      throw error;
    }
  }

  async sendDoctorAppointmentNotification(
    doctorEmail: string,
    doctorName: string,
    patientName: string,
    serviceName: string,
    appointmentDate: string,
    appointmentTime: string,
    amount: string,
    googleMeetLink?: string,
    timezone?: string, // Optional IANA timezone (e.g., "America/New_York"). Defaults to UTC if not provided.
    additionalServices?: Array<{ id: string; name: string; duration: number }> // Optional additional services
  ): Promise<void> {
    // Convert UTC time to specified timezone (or UTC if not provided)
    const [hours, minutes] = appointmentTime.split(':').map(Number);
    const [year, month, day] = appointmentDate.split('-').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));
    
    // Use Intl.DateTimeFormat to convert to specified timezone (or UTC)
    const targetTimezone = timezone || 'UTC';
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    
    // Format time in target timezone
    const formattedTime = timeFormatter.format(utcDate);
    // Extract hour and minute from formatted string (e.g., "08:00 AM" or "8:00 AM")
    const timeMatch = formattedTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const displayTime = timeMatch ? `${timeMatch[1]}:${timeMatch[2]} ${timeMatch[3]}` : formattedTime;
    
    // Add timezone indicator
    const timezoneAbbr = this.getTimezoneAbbreviation(targetTimezone, utcDate);
    const localTime = `${displayTime} ${timezoneAbbr ? `(${timezoneAbbr})` : '(UTC)'}`;
    
    // Format date based on appointmentDate string directly (not from UTC date object)
    // This matches the frontend logic: extract YYYY-MM-DD and create local date to avoid timezone shift
    // This ensures the date is correct even when time crosses midnight in UTC
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    // Create a local date from the date string (not UTC) to match frontend behavior
    const localDateObj = new Date(year, month - 1, day);
    const localDate = dateFormatter.format(localDateObj);
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .appointment-details {
            background-color: #f8f9fa;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #007bff;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
            font-weight: bold;
            color: #28a745;
            font-size: 18px;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">New Appointment Scheduled</h2>
            <p class="description">Hi Dr. ${doctorName},</p>
            <p class="description">A new appointment has been scheduled with you. Here are the details:</p>
            
            <div class="appointment-details">
              <div class="detail-row">
                <span class="detail-label">Patient:</span>
                <span class="detail-value">${patientName}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Service${additionalServices && additionalServices.length > 0 ? 's' : ''}:</span>
                <span class="detail-value">${serviceName}${additionalServices && additionalServices.length > 0 ? `, ${additionalServices.map(s => s.name).join(', ')}` : ''}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Date:</span>
                <span class="detail-value">${localDate}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span class="detail-value">${localTime}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Amount:</span>
                <span class="detail-value">$${amount}</span>
              </div>
            </div>
            
            <p class="description">Please ensure you're available at the scheduled time.</p>
            ${googleMeetLink ? `
            <div style="background-color: #e8f5e8; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #28a745;">
              <h3 style="color: #28a745; margin-top: 0;">Video Consultation</h3>
              <p style="color: #333; margin-bottom: 15px;">This is a telemedicine appointment. Please use the Google Meet link below to join your video consultation:</p>
              <a href="${googleMeetLink}" style="display: inline-block; background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 10px 0;">Join Google Meet</a>
              <p style="color: #666; font-size: 14px; margin-top: 10px;">Or copy this link: <span style="word-break: break-all;">${googleMeetLink}</span></p>
            </div>
            ` : ''}
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const fromEmail = this.configService.get<string>('APPOINTMENT_SMTP_FROM') || this.configService.get<string>('SMTP_FROM');
      await this.appointmentTransporter.sendMail({
        from: `"FormaMD" <${fromEmail}>`,
        to: doctorEmail,
        subject: 'New Appointment Scheduled - FormaMD',
        html,
      });
      console.log(`Doctor appointment notification sent successfully to ${doctorEmail}`);
    } catch (error) {
      console.error('Failed to send doctor appointment notification:', error);
      throw error;
    }
  }

  async sendCancellationEmail(
    patientEmail: string,
    patientName: string,
    doctorName: string,
    appointmentDate: string,
    appointmentTime: string,
    amount: string
  ): Promise<void> {
    // Format date based on appointmentDate string directly (not from UTC date object)
    // This matches the frontend logic: extract YYYY-MM-DD and create local date to avoid timezone shift
    const [year, month, day] = appointmentDate.split('-').map(Number);
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const localDateObj = new Date(year, month - 1, day);
    const formattedDate = dateFormatter.format(localDateObj);
    
    // Format time (convert from UTC to patient's timezone - default to America/Chicago)
    const [hours, minutes] = appointmentTime.split(':').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));
    const targetTimezone = 'America/Chicago';
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    const formattedTime = timeFormatter.format(utcDate);
    const timeMatch = formattedTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const displayTime = timeMatch ? `${timeMatch[1]}:${timeMatch[2]} ${timeMatch[3]}` : formattedTime;
    const timezoneAbbr = this.getTimezoneAbbreviation(targetTimezone, utcDate);
    const formattedTimeWithTz = `${displayTime} ${timezoneAbbr ? `(${timezoneAbbr})` : '(UTC)'}`;
    
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .cancellation-details {
            background-color: #fff3cd;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #ffc107;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
            font-weight: bold;
            color: #000000;
            font-size: 18px;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .refund-notice {
            background-color: #d4edda;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #28a745;
            color: #155724;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Appointment Cancelled</h2>
            <p class="description">Hi ${patientName},</p>
            <p class="description">Your appointment has been cancelled. Here are the details:</p>
            
            <div class="cancellation-details">
              <div class="detail-row">
                <span class="detail-label">Doctor:</span>
                <span class="detail-value">${doctorName}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Date:</span>
                <span class="detail-value">${formattedDate}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span class="detail-value">${formattedTimeWithTz}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Amount:</span>
                <span class="detail-value">$${amount}</span>
              </div>
            </div>
            
            <div class="refund-notice">
              <p style="margin: 0;"><strong>Cancellation Policy:</strong></p>
              <p style="margin: 5px 0 0 0;">You may be charged $25 if you cancelled within less than 24 hours, or $50 if you missed your appointment. Please check with your doctor for any applicable charges.</p>
            </div>
            
            <p class="description">You can book a new appointment anytime through your dashboard.</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const fromEmail = this.configService.get<string>('APPOINTMENT_SMTP_FROM') || this.configService.get<string>('SMTP_FROM');
      await this.appointmentTransporter.sendMail({
        from: `"FormaMD" <${fromEmail}>`,
        to: patientEmail,
        subject: 'Appointment Cancelled - FormaMD',
        html,
      });
      console.log(`Cancellation email sent successfully to ${patientEmail}`);
    } catch (error) {
      console.error('Failed to send cancellation email:', error);
      throw error;
    }
  }

  async sendDoctorCancellationNotification(
    doctorEmail: string,
    doctorName: string,
    patientName: string,
    patientEmail: string,
    appointmentDate: string,
    appointmentTime: string,
    amount: string,
    timezone?: string
  ): Promise<void> {
    const targetTimezone = timezone || 'America/Chicago';
    const [hours, minutes] = appointmentTime.split(':').map(Number);
    const [year, month, day] = appointmentDate.split('-').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    // Format date based on date string directly (not from UTC date object)
    // This matches the frontend logic: extract YYYY-MM-DD and create local date to avoid timezone shift
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const formattedTime = timeFormatter.format(utcDate);
    const timeMatch = formattedTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const displayTime = timeMatch ? `${timeMatch[1]}:${timeMatch[2]} ${timeMatch[3]}` : formattedTime;
    const timezoneAbbr = this.getTimezoneAbbreviation(targetTimezone, utcDate);
    const localTime = `${displayTime} ${timezoneAbbr ? `(${timezoneAbbr})` : ''}`.trim();
    // Create a local date from the date string (not UTC) to match frontend behavior
    const localDateObj = new Date(year, month - 1, day);
    const localDate = dateFormatter.format(localDateObj);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .cancellation-details {
            background-color: #fff3cd;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #ffc107;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
            font-weight: bold;
            color: #000000;
            font-size: 18px;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .refund-notice {
            background-color: #d4edda;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #28a745;
            color: #155724;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Appointment Cancelled</h2>
            <p class="description">Hi Dr. ${doctorName},</p>
            <p class="description">An appointment has been cancelled by the patient. Here are the details:</p>
            
            <div class="cancellation-details">
              <div class="detail-row">
                <span class="detail-label">Patient:</span>
                <span class="detail-value">${patientName}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Patient Email:</span>
                <span class="detail-value">${patientEmail}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Date:</span>
                <span class="detail-value">${localDate}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span class="detail-value">${localTime}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Amount:</span>
                <span class="detail-value">$${amount}</span>
              </div>
            </div>
            
            <div class="refund-notice">
              <p style="margin: 0;"><strong>Cancellation Policy:</strong></p>
              <p style="margin: 5px 0 0 0;">Please review if the patient should be charged $25 for cancelling within less than 24 hours, or $50 if they missed the appointment.</p>
            </div>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const fromEmail = this.configService.get<string>('APPOINTMENT_SMTP_FROM') || this.configService.get<string>('SMTP_FROM');
      await this.appointmentTransporter.sendMail({
        from: `"FormaMD" <${fromEmail}>`,
        to: doctorEmail,
        subject: 'Appointment Cancelled - FormaMD',
        html,
      });
      console.log(`Doctor cancellation notification sent successfully to ${doctorEmail}`);
    } catch (error) {
      console.error('Failed to send doctor cancellation notification:', error);
      throw error;
    }
  }

  async sendRescheduleEmail(
    patientEmail: string,
    patientName: string,
    doctorName: string,
    oldDate: string,
    oldTime: string,
    newDate: string,
    newTime: string,
    googleMeetLink?: string,
    timezone?: string // Optional IANA timezone. Defaults to doctor's timezone (CST) if not provided.
  ): Promise<void> {
    // Convert UTC times to specified timezone (or UTC if not provided)
    const targetTimezone = timezone || 'America/Chicago';
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    
    // Format date based on date string directly (not from UTC date object)
    // This matches the frontend logic: extract YYYY-MM-DD and create local date to avoid timezone shift
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    // Convert old appointment time
    const [oldHours, oldMinutes] = oldTime.split(':').map(Number);
    const [oldYear, oldMonth, oldDay] = oldDate.split('-').map(Number);
    const oldUtcDate = new Date(Date.UTC(oldYear, oldMonth - 1, oldDay, oldHours, oldMinutes, 0));
    const oldFormattedTime = timeFormatter.format(oldUtcDate);
    const oldTimeMatch = oldFormattedTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const oldDisplayTime = oldTimeMatch ? `${oldTimeMatch[1]}:${oldTimeMatch[2]} ${oldTimeMatch[3]}` : oldFormattedTime;
    const oldTimezoneAbbr = this.getTimezoneAbbreviation(targetTimezone, oldUtcDate);
    const oldLocalTime = `${oldDisplayTime} ${oldTimezoneAbbr ? `(${oldTimezoneAbbr})` : '(UTC)'}`;
    // Create a local date from the date string (not UTC) to match frontend behavior
    const oldLocalDateObj = new Date(oldYear, oldMonth - 1, oldDay);
    const oldLocalDate = dateFormatter.format(oldLocalDateObj);

    // Convert new appointment time
    const [newHours, newMinutes] = newTime.split(':').map(Number);
    const [newYear, newMonth, newDay] = newDate.split('-').map(Number);
    const newUtcDate = new Date(Date.UTC(newYear, newMonth - 1, newDay, newHours, newMinutes, 0));
    const newFormattedTime = timeFormatter.format(newUtcDate);
    const newTimeMatch = newFormattedTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const newDisplayTime = newTimeMatch ? `${newTimeMatch[1]}:${newTimeMatch[2]} ${newTimeMatch[3]}` : newFormattedTime;
    const newTimezoneAbbr = this.getTimezoneAbbreviation(targetTimezone, newUtcDate);
    const newLocalTime = `${newDisplayTime} ${newTimezoneAbbr ? `(${newTimezoneAbbr})` : '(UTC)'}`;
    // Create a local date from the date string (not UTC) to match frontend behavior
    const newLocalDateObj = new Date(newYear, newMonth - 1, newDay);
    const newLocalDate = dateFormatter.format(newLocalDateObj);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .reschedule-details {
            background-color: #e7f3ff;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #007bff;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .old-appointment {
            background-color: #fff3cd;
            padding: 15px;
            border-radius: 5px;
            margin: 15px 0;
            border-left: 4px solid #ffc107;
          }
          .new-appointment {
            background-color: #d4edda;
            padding: 15px;
            border-radius: 5px;
            margin: 15px 0;
            border-left: 4px solid #28a745;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Appointment Rescheduled</h2>
            <p class="description">Hi ${patientName},</p>
            <p class="description">Your appointment has been successfully rescheduled. Here are the details:</p>
            
            <div class="reschedule-details">
              <div class="detail-row">
                <span class="detail-label">Doctor:</span>
                <span class="detail-value">${doctorName}</span>
              </div>
              
              <div class="old-appointment">
                <div class="detail-row">
                  <span class="detail-label">Previous Date:</span>
                  <span class="detail-value">${oldLocalDate}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Previous Time:</span>
                  <span class="detail-value">${oldLocalTime}</span>
                </div>
              </div>
              
              <div class="new-appointment">
                <div class="detail-row">
                  <span class="detail-label">New Date:</span>
                  <span class="detail-value">${newLocalDate}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">New Time:</span>
                  <span class="detail-value">${newLocalTime}</span>
                </div>
              </div>
            </div>
            
            <p class="description">Please arrive 10 minutes before your new scheduled time.</p>
            ${googleMeetLink ? `
            <div style="background-color: #e8f5e8; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #28a745;">
              <h3 style="color: #28a745; margin-top: 0;">Video Consultation</h3>
              <p style="color: #333; margin-bottom: 15px;">This is a telemedicine appointment. Please use the Google Meet link below to join your video consultation:</p>
              <a href="${googleMeetLink}" style="display: inline-block; background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 10px 0;">Join Google Meet</a>
              <p style="color: #666; font-size: 14px; margin-top: 10px;">Or copy this link: <span style="word-break: break-all;">${googleMeetLink}</span></p>
            </div>
            ` : ''}
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const fromEmail = this.configService.get<string>('APPOINTMENT_SMTP_FROM') || this.configService.get<string>('SMTP_FROM');
      await this.appointmentTransporter.sendMail({
        from: `"FormaMD" <${fromEmail}>`,
        to: patientEmail,
        subject: 'Appointment Rescheduled - FormaMD',
        html,
      });
      console.log(`Reschedule email sent successfully to ${patientEmail}`);
    } catch (error) {
      console.error('Failed to send reschedule email:', error);
      throw error;
    }
  }

  async sendDoctorRescheduleNotification(
    doctorEmail: string,
    doctorName: string,
    patientName: string,
    oldDate: string,
    oldTime: string,
    newDate: string,
    newTime: string,
    googleMeetLink?: string,
    timezone?: string // Optional IANA timezone. Defaults to UTC if not provided.
  ): Promise<void> {
    // Convert UTC times to specified timezone (or UTC if not provided)
    const targetTimezone = timezone || 'UTC';
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    
    // Format date based on date string directly (not from UTC date object)
    // This matches the frontend logic: extract YYYY-MM-DD and create local date to avoid timezone shift
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    // Convert old appointment time
    const [oldHours, oldMinutes] = oldTime.split(':').map(Number);
    const [oldYear, oldMonth, oldDay] = oldDate.split('-').map(Number);
    const oldUtcDate = new Date(Date.UTC(oldYear, oldMonth - 1, oldDay, oldHours, oldMinutes, 0));
    const oldFormattedTime = timeFormatter.format(oldUtcDate);
    const oldTimeMatch = oldFormattedTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const oldDisplayTime = oldTimeMatch ? `${oldTimeMatch[1]}:${oldTimeMatch[2]} ${oldTimeMatch[3]}` : oldFormattedTime;
    const oldTimezoneAbbr = this.getTimezoneAbbreviation(targetTimezone, oldUtcDate);
    const oldLocalTime = `${oldDisplayTime} ${oldTimezoneAbbr ? `(${oldTimezoneAbbr})` : '(UTC)'}`;
    // Create a local date from the date string (not UTC) to match frontend behavior
    const oldLocalDateObj = new Date(oldYear, oldMonth - 1, oldDay);
    const oldLocalDate = dateFormatter.format(oldLocalDateObj);

    // Convert new appointment time
    const [newHours, newMinutes] = newTime.split(':').map(Number);
    const [newYear, newMonth, newDay] = newDate.split('-').map(Number);
    const newUtcDate = new Date(Date.UTC(newYear, newMonth - 1, newDay, newHours, newMinutes, 0));
    const newFormattedTime = timeFormatter.format(newUtcDate);
    const newTimeMatch = newFormattedTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    const newDisplayTime = newTimeMatch ? `${newTimeMatch[1]}:${newTimeMatch[2]} ${newTimeMatch[3]}` : newFormattedTime;
    const newTimezoneAbbr = this.getTimezoneAbbreviation(targetTimezone, newUtcDate);
    const newLocalTime = `${newDisplayTime} ${newTimezoneAbbr ? `(${newTimezoneAbbr})` : '(UTC)'}`;
    // Create a local date from the date string (not UTC) to match frontend behavior
    const newLocalDateObj = new Date(newYear, newMonth - 1, newDay);
    const newLocalDate = dateFormatter.format(newLocalDateObj);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .reschedule-details {
            background-color: #e7f3ff;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #007bff;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .old-appointment {
            background-color: #fff3cd;
            padding: 15px;
            border-radius: 5px;
            margin: 15px 0;
            border-left: 4px solid #ffc107;
          }
          .new-appointment {
            background-color: #d4edda;
            padding: 15px;
            border-radius: 5px;
            margin: 15px 0;
            border-left: 4px solid #28a745;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Appointment Rescheduled</h2>
            <p class="description">Hi Dr. ${doctorName},</p>
            <p class="description">An appointment has been rescheduled. Here are the details:</p>
            
            <div class="reschedule-details">
              <div class="detail-row">
                <span class="detail-label">Patient:</span>
                <span class="detail-value">${patientName}</span>
              </div>
              
              <div class="old-appointment">
                <div class="detail-row">
                  <span class="detail-label">Previous Date:</span>
                  <span class="detail-value">${oldLocalDate}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Previous Time:</span>
                  <span class="detail-value">${oldLocalTime}</span>
                </div>
              </div>
              
              <div class="new-appointment">
                <div class="detail-row">
                  <span class="detail-label">New Date:</span>
                  <span class="detail-value">${newLocalDate}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">New Time:</span>
                  <span class="detail-value">${newLocalTime}</span>
                </div>
              </div>
            </div>
            
            <p class="description">Please ensure you're available at the new scheduled time.</p>
            ${googleMeetLink ? `
            <div style="background-color: #e8f5e8; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #28a745;">
              <h3 style="color: #28a745; margin-top: 0;">Video Consultation</h3>
              <p style="color: #333; margin-bottom: 15px;">This is a telemedicine appointment. Please use the Google Meet link below to join your video consultation:</p>
              <a href="${googleMeetLink}" style="display: inline-block; background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 10px 0;">Join Google Meet</a>
              <p style="color: #666; font-size: 14px; margin-top: 10px;">Or copy this link: <span style="word-break: break-all;">${googleMeetLink}</span></p>
            </div>
            ` : ''}
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const fromEmail = this.configService.get<string>('APPOINTMENT_SMTP_FROM') || this.configService.get<string>('SMTP_FROM');
      await this.appointmentTransporter.sendMail({
        from: `"FormaMD" <${fromEmail}>`,
        to: doctorEmail,
        subject: 'Appointment Rescheduled - FormaMD',
        html,
      });
      console.log(`Doctor reschedule notification sent successfully to ${doctorEmail}`);
    } catch (error) {
      console.error('Failed to send doctor reschedule notification:', error);
      throw error;
    }
  }

  async sendMedicalFormEmail(to: string, name: string, formLink: string): Promise<void> {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .form-button {
            display: inline-block;
            background-color: #000000;
            color: #ffffff !important;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            font-size: 16px;
            margin: 20px 0;
          }
          .info-box {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #000000;
            text-align: left;
          }
          .important-notice {
            background-color: #fff3cd;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #ffc107;
            color: #856404;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
          .link-fallback {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border: 1px solid #e9ecef;
            color: #666666;
            font-size: 14px;
          }
          .link-fallback a {
            color: #000000;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Complete Your Medical Consultation Form</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">Welcome to FormaMD! To ensure we can provide you with the best possible care, please complete your medical consultation form.</p>
            
            <a href="${formLink}" class="form-button">Complete Medical Form</a>
            
            <div class="info-box">
              <p style="margin: 0 0 10px 0; color: #000000; font-weight: bold;">📋 Required Information</p>
              <p style="margin: 0;">This form includes your medical history, current medications, allergies, and other important health information that will help our doctors provide better care.</p>
            </div>
            
            <div class="important-notice">
              <p style="margin: 0;"><strong>⚠️ Important:</strong></p>
              <p style="margin: 5px 0 0 0;">You must complete this form before you can book any appointments. This ensures our doctors have all the necessary information to provide you with the best care.</p>
            </div>
            
            <div class="link-fallback">
              <p style="margin: 0 0 10px 0;"><strong>Manual Link:</strong></p>
              <p style="margin: 0;">If the button doesn't work, copy this link:</p>
              <a href="${formLink}">${formLink}</a>
            </div>
            
            <p class="description">Thank you for choosing FormaMD for your healthcare needs!</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Complete Your Medical Consultation Form - FormaMD',
        html,
      });
      console.log(`Medical form email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send medical form email:', error);
      throw error;
    }
  }

  async sendAssistantCreatedEmail(
    to: string,
    name: string,
    password: string,
    doctorName: string,
    loginUrl: string,
  ): Promise<void> {
    const text = `Hi ${name},

An Assistant Doctor account has been created for you at FormaMD, linked to Dr. ${doctorName}.

Login URL: ${loginUrl}
Email: ${to}
Temporary Password: ${password}

For your security, you will be asked to set a new password the first time you log in.

Select the "Assistant Doctor" tab on the login page.

— FormaMD`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="font-family: Arial, sans-serif; line-height:1.6; margin:0; padding:20px; background-color:#f4f4f4; color:#333;">
        <div style="max-width:600px; margin:0 auto; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 4px 6px rgba(0,0,0,.1);">
          <div style="background:#000; color:#fff; padding:30px 20px; text-align:center;">
            <img src="https://formamd.com/logo.png" alt="FormaMD Logo" style="width:40px; height:40px; object-fit:contain; vertical-align:middle;" />
            <h1 style="margin:8px 0 0; font-size:26px;">FormaMD</h1>
            <p style="margin:8px 0 0; opacity:.9;">Assistant Doctor Access</p>
          </div>
          <div style="padding:36px 30px;">
            <h2 style="color:#000; font-size:22px; margin:0 0 16px;">Your account is ready</h2>
            <p style="color:#555;">Hi ${name},</p>
            <p style="color:#555;">An Assistant Doctor account has been created for you, linked to <strong>Dr. ${doctorName}</strong>. Use the credentials below to sign in.</p>
            <div style="background:#f8f9fa; border:2px solid #e9ecef; border-radius:8px; padding:20px; margin:24px 0;">
              <p style="margin:0 0 8px;"><strong>Email:</strong> ${to}</p>
              <p style="margin:0;"><strong>Temporary Password:</strong> ${password}</p>
            </div>
            <div style="text-align:center; margin:28px 0;">
              <a href="${loginUrl}" style="background:#e53935; color:#fff; text-decoration:none; padding:14px 28px; border-radius:8px; font-weight:600; display:inline-block;">Go to Login</a>
            </div>
            <p style="color:#555;">On the login page, choose the <strong>Assistant Doctor</strong> tab. For your security, you'll be asked to set a new password the first time you sign in.</p>
          </div>
          <div style="padding:20px 30px; text-align:center; color:#999; font-size:13px; border-top:1px solid #eee;">
            <p style="margin:0;">This is an automated email, please do not reply.</p>
            <p style="margin:6px 0 0;">&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>`;

    await this.sendEmail(to, 'Your FormaMD Assistant Doctor Account', text, html);
  }

  async sendAdminCreatedPatientEmail(to: string, name: string, password: string, verificationLink: string): Promise<void> {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            color: white;
            padding: 30px 20px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: 700;
          }
          .header p {
            margin: 10px 0 0 0;
            font-size: 16px;
            opacity: 0.9;
          }
          .content {
            padding: 40px 30px;
          }
          .content h2 {
            color: #000000;
            font-size: 24px;
            margin-bottom: 20px;
            font-weight: 600;
          }
          .content p {
            font-size: 16px;
            margin-bottom: 20px;
            color: #555555;
          }
          .credentials-box {
            background-color: #f8f9fa;
            border: 2px solid #e9ecef;
            border-radius: 8px;
            padding: 20px;
            margin: 25px 0;
            text-align: center;
          }
          .credentials-box h3 {
            color: #000000;
            margin: 0 0 15px 0;
            font-size: 18px;
          }
          .credential-item {
            background-color: #ffffff;
            border: 1px solid #dee2e6;
            border-radius: 6px;
            padding: 12px;
            margin: 10px 0;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            word-break: break-all;
          }
          .credential-label {
            font-weight: bold;
            color: #495057;
            display: block;
            margin-bottom: 5px;
            font-family: Arial, sans-serif;
          }
          .button {
            display: inline-block;
            background-color: #000000;
            color: #ffffff !important;
            text-decoration: none;
            padding: 15px 30px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 16px;
            text-align: center;
            margin: 20px 0;
          }
          .warning {
            background-color: #fff3cd;
            border: 1px solid #ffeaa7;
            color: #856404;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
            font-size: 14px;
          }
          .footer {
            background-color: #f8f9fa;
            padding: 30px 20px;
            text-align: center;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
          .footer p {
            margin: 5px 0;
          }
          .logo {
            font-size: 32px;
            font-weight: 800;
            margin-bottom: 10px;
          }
          @media (max-width: 600px) {
            body {
              padding: 10px;
            }
            .content {
              padding: 30px 20px;
            }
            .header {
              padding: 25px 15px;
            }
            .header h1 {
              font-size: 24px;
            }
            .button {
              padding: 12px 25px;
              font-size: 14px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">FormaMD</div>
            <h1>Welcome to FormaMD!</h1>
            <p>Your account has been created by our admin team</p>
          </div>
          
          <div class="content">
            <h2>Hello ${name}!</h2>
            
            <p>Great news! Your FormaMD patient account has been successfully created by our administrative team. You can now access our platform to manage your healthcare journey.</p>
            
            <div class="credentials-box">
              <h3>🔐 Your Login Credentials</h3>
              <div class="credential-item">
                <span class="credential-label">Email Address:</span>
                ${to}
              </div>
              <div class="credential-item">
                <span class="credential-label">Temporary Password:</span>
                ${password}
              </div>
            </div>
            
            <div class="warning">
              <strong>⚠️ Important Security Notice:</strong><br>
              For your security, please change your password after your first login. This temporary password should only be used for initial access.
            </div>
            
            <p><strong>Next Steps:</strong></p>
            <ol style="color: #555555; font-size: 16px; line-height: 1.8;">
              <li>Click the verification button below to verify your email address</li>
              <li>Log in to your account using the credentials above</li>
              <li>Change your password in your account settings</li>
              <li>Complete your medical intake form</li>
              <li>Schedule your first appointment</li>
            </ol>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verificationLink}" class="button">
                ✅ Verify Email & Get Started
              </a>
            </div>
            
            <p>If you have any questions or need assistance, please don't hesitate to contact our support team at <a href="mailto:support@formamd.com" style="color: #000000; font-weight: bold;">support@formamd.com</a>. We're here to help you every step of the way!</p>
            
            <p style="margin-top: 30px;">
              <strong>The FormaMD Team</strong><br>
              <em>Optimizing your health, one step at a time</em>
            </p>
          </div>
          
          <div class="footer">
            <p><strong>FormaMD</strong></p>
            <p>This email was sent because an account was created for you by our admin team.</p>
            <p>If you believe this was sent in error, please contact our support team at <a href="mailto:support@formamd.com" style="color: #000000; font-weight: bold;">support@formamd.com</a> immediately.</p>
            <p style="margin-top: 20px; font-size: 12px; color: #999999;">
              © 2026 FormaMD. All rights reserved.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"FormaMD" <${this.configService.get<string>('SMTP_USER')}>`,
      to,
      subject: '🎉 Welcome to FormaMD - Your Account is Ready!',
      html,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`Admin-created patient welcome email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send admin-created patient welcome email:', error);
      throw error;
    }
  }

  async sendSubscriptionConfirmationEmail(to: string, name: string, subscriptionStartDate: Date, subscriptionEndDate: Date, monthlyAmount: number): Promise<void> {
    const formattedStartDate = subscriptionStartDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const formattedEndDate = subscriptionEndDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .success-message {
            background-color: #d4edda;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #28a745;
            color: #155724;
          }
          .subscription-details {
            background-color: #f8f9fa;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #000000;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
            font-weight: bold;
            color: #000000;
            font-size: 18px;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .info-box {
            background-color: #e7f3ff;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #007bff;
            color: #004085;
            font-size: 14px;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Subscription Confirmed!</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">Thank you for subscribing to FormaMD! Your subscription has been successfully activated.</p>
            
            <div class="success-message">
              <span style="font-size: 32px; display: block; margin-bottom: 10px;">🎉</span>
              <p style="margin: 0; color: #155724; font-weight: bold; font-size: 18px;">Your subscription is now active!</p>
            </div>
            
            <div class="subscription-details">
              <div class="detail-row">
                <span class="detail-label">Subscription Period:</span>
                <span class="detail-value">${formattedStartDate} - ${formattedEndDate}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Monthly Cost:</span>
                <span class="detail-value">$${monthlyAmount.toFixed(2)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Billing Cycle:</span>
                <span class="detail-value">Monthly</span>
              </div>
            </div>
            
            <div class="info-box">
              <p style="margin: 0;"><strong>ℹ️ Important Information:</strong></p>
              <ul style="text-align: left; margin: 10px 0 0 20px; padding: 0;">
                <li>Your subscription will automatically renew each month</li>
                <li>You can manage or cancel your subscription anytime from your account settings</li>
                <li>You'll receive email notifications for each renewal</li>
              </ul>
            </div>
            
            <p class="description">You now have access to all premium features and benefits. We're excited to help you on your health journey!</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Subscription Confirmed - FormaMD',
        html,
      });
      console.log(`Subscription confirmation email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send subscription confirmation email:', error);
      throw error;
    }
  }

  async sendSubscriptionCancellationEmail(to: string, name: string, subscriptionEndDate: Date, monthlyAmount: number): Promise<void> {
    const formattedEndDate = subscriptionEndDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .cancellation-message {
            background-color: #fff3cd;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #ffc107;
            color: #856404;
          }
          .subscription-details {
            background-color: #f8f9fa;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #000000;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .info-box {
            background-color: #e7f3ff;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #007bff;
            color: #004085;
            font-size: 14px;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Subscription Cancellation Request</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">We've received your request to cancel your recurring subscription payment.</p>
            
            <div class="cancellation-message">
              <span style="font-size: 32px; display: block; margin-bottom: 10px;">⚠️</span>
              <p style="margin: 0; color: #856404; font-weight: bold; font-size: 18px;">Your subscription will remain active until the end of your current billing period.</p>
            </div>
            
            <div class="subscription-details">
              <div class="detail-row">
                <span class="detail-label">Subscription End Date:</span>
                <span class="detail-value">${formattedEndDate}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Monthly Cost:</span>
                <span class="detail-value">$${monthlyAmount.toFixed(2)}</span>
              </div>
            </div>
            
            <p class="description">We're sorry to see you go! If you have any feedback or concerns, please don't hesitate to contact our support team. We'd love to help improve your experience.</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Subscription Cancellation Confirmation - FormaMD',
        html,
      });
      console.log(`Subscription cancellation email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send subscription cancellation email:', error);
      throw error;
    }
  }

  async sendPaymentConfirmationEmail(to: string, name: string, amount: number, orderNumber: string): Promise<void> {
    const formattedDate = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .success-message {
            background-color: #d4edda;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #28a745;
            color: #155724;
          }
          .payment-details {
            background-color: #f8f9fa;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #000000;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
            font-weight: bold;
            color: #000000;
            font-size: 18px;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .info-box {
            background-color: #e7f3ff;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #007bff;
            color: #004085;
            font-size: 14px;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Payment Confirmed!</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">Thank you for your purchase! Your payment has been successfully processed.</p>
            
            <div class="success-message">
              <span style="font-size: 32px; display: block; margin-bottom: 10px;">🎉</span>
              <p style="margin: 0; color: #155724; font-weight: bold; font-size: 18px;">Your payment was successful!</p>
            </div>
            
            <div class="payment-details">
              <div class="detail-row">
                <span class="detail-label">Order Number:</span>
                <span class="detail-value">${orderNumber}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Payment Date:</span>
                <span class="detail-value">${formattedDate}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Amount Paid:</span>
                <span class="detail-value">$${amount.toFixed(2)}</span>
              </div>
            </div>
            
            <div class="info-box">
              <p style="margin: 0;"><strong>ℹ️ What's Next:</strong></p>
              <ul style="text-align: left; margin: 10px 0 0 20px; padding: 0;">
                <li>Continue with your registration to complete your account setup</li>
                <li>You'll receive additional emails with instructions on next steps</li>
                <li>If you have any questions, please contact our support team</li>
              </ul>
            </div>
            
            <p class="description">We're excited to have you join FormaMD and look forward to helping you on your health journey!</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Payment Confirmed - FormaMD',
        html,
      });
      console.log(`Payment confirmation email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send payment confirmation email:', error);
      throw error;
    }
  }

  async sendMedicationPaymentConfirmationEmail(
    to: string,
    name: string,
    amount: number,
    appointmentId: string,
    invoiceItems: Array<{
      name: string;
      strength?: string | null;
      dose?: string | null;
      frequency?: string | null;
      route?: string | null;
      standardPrice: number;
      membershipPrice: number | null;
      price: number;
      discount: number;
    }>,
    isSubscribed: boolean,
    totalDiscount: number,
  ): Promise<void> {
    const formattedDate = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const formatPrice = (price: number) => {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(price);
    };

    const formatVariationDetails = (item: typeof invoiceItems[0]) => {
      const parts: string[] = [];
      if (item.strength) parts.push(item.strength);
      if (item.dose) parts.push(item.dose);
      if (item.frequency) parts.push(item.frequency);
      if (item.route) parts.push(`(${item.route})`);
      return parts.length > 0 ? parts.join(' • ') : null;
    };

    const itemsHtml = invoiceItems.map((item) => {
      const variationDetails = formatVariationDetails(item);
      const hasDiscount = isSubscribed && item.membershipPrice !== null && item.discount > 0;
      
      return `
        <tr style="border-bottom: 1px solid #e9ecef;">
          <td style="padding: 15px; text-align: left;">
            <div style="font-weight: bold; color: #333333; margin-bottom: 5px;">${item.name}</div>
            ${variationDetails ? `<div style="font-size: 12px; color: #666666; margin-top: 3px;">${variationDetails}</div>` : ''}
          </td>
          <td style="padding: 15px; text-align: right;">
            ${hasDiscount ? `
              <div style="text-decoration: line-through; color: #999999; font-size: 14px;">${formatPrice(item.standardPrice)}</div>
              <div style="color: #28a745; font-weight: bold; font-size: 16px;">${formatPrice(item.price)}</div>
              <div style="color: #28a745; font-size: 12px; margin-top: 3px;">Member Discount: ${formatPrice(item.discount)}</div>
            ` : `
              <div style="font-weight: bold; color: #333333; font-size: 16px;">${formatPrice(item.price)}</div>
            `}
          </td>
        </tr>
      `;
    }).join('');

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 700px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
            text-align: center;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .success-message {
            background-color: #d4edda;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #28a745;
            color: #155724;
            text-align: center;
          }
          .invoice-table {
            width: 100%;
            border-collapse: collapse;
            margin: 25px 0;
            background-color: #f8f9fa;
            border-radius: 5px;
            overflow: hidden;
          }
          .invoice-table thead {
            background-color: #000000;
            color: #ffffff;
          }
          .invoice-table th {
            padding: 15px;
            text-align: left;
            font-weight: bold;
          }
          .invoice-table th:last-child {
            text-align: right;
          }
          .invoice-summary {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #000000;
          }
          .summary-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .summary-row:last-child {
            border-bottom: none;
            font-weight: bold;
            color: #000000;
            font-size: 18px;
            margin-top: 10px;
            padding-top: 15px;
            border-top: 2px solid #000000;
          }
          .discount-row {
            color: #28a745;
          }
          .info-box {
            background-color: #e7f3ff;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #007bff;
            color: #004085;
            font-size: 14px;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Medication Subscription Activated!</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">Thank you for subscribing! Your medication subscription has been successfully activated and will be billed monthly.</p>
            
            <div class="success-message">
              <span style="font-size: 32px; display: block; margin-bottom: 10px;">💊</span>
              <p style="margin: 0; color: #155724; font-weight: bold; font-size: 18px;">Your subscription is now active!</p>
            </div>
            
            <h3 style="color: #333333; font-size: 18px; margin-top: 30px; margin-bottom: 15px;">Invoice Details</h3>
            <table class="invoice-table">
              <thead>
                <tr>
                  <th>Medication</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                ${itemsHtml}
              </tbody>
            </table>
            
            <div class="invoice-summary">
              ${totalDiscount > 0 ? `
                <div class="summary-row">
                  <span>Subtotal:</span>
                  <span>${formatPrice(amount + totalDiscount)}</span>
                </div>
                <div class="summary-row discount-row">
                  <span>🎁 Member Discount:</span>
                  <span>-${formatPrice(totalDiscount)}</span>
                </div>
              ` : ''}
              <div class="summary-row">
                <span>Monthly Subscription Amount:</span>
                <span>${formatPrice(amount)}</span>
              </div>
            </div>
            
            <div class="info-box">
              <p style="margin: 0;"><strong>ℹ️ Important Information:</strong></p>
              <ul style="text-align: left; margin: 10px 0 0 20px; padding: 0;">
                <li><strong>Monthly Billing:</strong> You will be charged ${formatPrice(amount)} each month automatically</li>
                <li>Your payment method has been saved for automatic monthly billing</li>
                <li>Your medications will be processed and shipped according to your prescription</li>
                <li>You will receive tracking information once your order ships</li>
                <li>If you have any questions about your medications, please contact your healthcare provider</li>
                <li>Keep this email as your receipt for your records</li>
              </ul>
            </div>
            
            <p class="description" style="text-align: center; margin-top: 30px;">
              <strong>Appointment ID:</strong> ${appointmentId}<br>
              <strong>Payment Date:</strong> ${formattedDate}
            </p>
            
            <p class="description">If you have any questions or concerns, please don't hesitate to contact our support team.</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Medication Subscription Activated - FormaMD',
        html,
      });
      console.log(`Medication payment confirmation email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send medication payment confirmation email:', error);
      throw error;
    }
  }

  async sendMedicationSubscriptionCancellationEmail(
    to: string,
    name: string,
    appointmentId: string,
    monthlyAmount: number,
    subscriptionEndDate?: Date,
    serviceName?: string,
    oldMedicationName?: string,
  ): Promise<void> {
    const formattedDate = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const formattedEndDate = subscriptionEndDate
      ? subscriptionEndDate.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
      : 'N/A';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 15px;
            margin: 0 auto;
            width: fit-content;
          }
          .logo-img {
            width: 40px;
            height: 40px;
            object-fit: contain;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #333333;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .description {
            color: #666666;
            font-size: 16px;
            margin-bottom: 25px;
            line-height: 1.6;
          }
          .warning-message {
            background-color: #fff3cd;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #ffc107;
            color: #856404;
            text-align: left;
          }
          .subscription-details {
            background-color: #f8f9fa;
            padding: 25px;
            border-radius: 5px;
            margin: 25px 0;
            border-left: 4px solid #000000;
            text-align: left;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #e9ecef;
          }
          .detail-row:last-child {
            border-bottom: none;
          }
          .detail-label {
            font-weight: bold;
            color: #333333;
          }
          .detail-value {
            color: #666666;
          }
          .info-box {
            background-color: #e7f3ff;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #007bff;
            color: #004085;
            font-size: 14px;
            text-align: left;
          }
          .footer {
            background-color: #f8f9fa;
            text-align: center;
            padding: 20px;
            color: #666666;
            font-size: 14px;
            border-top: 1px solid #e9ecef;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo-container">
              <img src="https://formamd.com/logo.png" alt="FormaMD Logo" class="logo-img" />
              <div class="logo">FormaMD</div>
            </div>
          </div>
          <div class="content">
            <h2 class="title">Medication Subscription Canceled</h2>
            <p class="description">Hi ${name},</p>
            <p class="description">We are reaching out to inform you of a supervised change to your current medication regimen. After a thorough review of your latest ${serviceName || 'appointment'}, the clinical team at FormaMD has decided to transition your treatment from ${oldMedicationName || 'your current medication'}. The new medication will be discussed in the upcoming appointment.</p>
            
            <p class="description">Our primary goal is to ensure your treatment remains as effective and safe as possible. If you have any questions regarding this change or how to transition between these medications, please reply to this email or schedule a brief check-in via the patient portal.</p>
            
            <div class="subscription-details">
              <div class="detail-row">
                <span class="detail-label">Appointment ID:</span>
                <span class="detail-value">${appointmentId}</span>
              </div>
              ${subscriptionEndDate ? `
              <div class="detail-row">
                <span class="detail-label">Subscription End Date:</span>
                <span class="detail-value">${formattedEndDate}</span>
              </div>
              ` : ''}
            </div>
            
            <p class="description" style="margin-top: 30px;">Best regards,</p>
            <p class="description" style="margin-top: 10px;"><strong>The Clinical Support Team</strong><br>FormaMD</p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: 'Medication Subscription Cancellation Request - FormaMD',
        html,
      });
      console.log(`Medication subscription cancellation email sent successfully to ${to}`);
    } catch (error) {
      console.error('Failed to send medication subscription cancellation email:', error);
      throw error;
    }
  }

  /**
   * Get timezone abbreviation (e.g., EST, EDT, PST, UTC) for a given timezone and date
   * @param timezone - IANA timezone string (e.g., "America/New_York")
   * @param date - Date object to determine DST (Daylight Saving Time)
   * @returns Timezone abbreviation string
   */
  private getTimezoneAbbreviation(timezone: string, date: Date): string {
    try {
      if (timezone === 'UTC') {
        return 'UTC';
      }
      
      // Use Intl.DateTimeFormat to get timezone name
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short'
      });
      
      const parts = formatter.formatToParts(date);
      const timeZoneName = parts.find(part => part.type === 'timeZoneName');
      
      return timeZoneName?.value || 'UTC';
    } catch (error) {
      console.error(`Error getting timezone abbreviation for ${timezone}:`, error);
      return 'UTC';
    }
  }

  private getFrontendBaseUrl() {
    return (
      this.configService.get<string>('FRONTEND_URL')?.replace(/\/$/, '') ||
      'https://www.formamd.com'
    );
  }

  private getLabInstructionImagePath(fileName: string) {
    const candidates = [
      path.join(__dirname, 'assets', 'email', fileName),
      path.join(process.cwd(), 'src', 'mailer', 'assets', 'email', fileName),
      path.join(process.cwd(), 'dist', 'src', 'mailer', 'assets', 'email', fileName),
      path.join(process.cwd(), '..', 'optimalmd', 'public', fileName),
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
  }

  private getLabInstructionInlineAttachments(): Array<{
    filename: string;
    path: string;
    cid: string;
  }> {
    const images = [
      { fileName: 'lab-quest-order.png', cid: 'labQuestOrder@optimalemd' },
      { fileName: 'lab-quest-all-tests.png', cid: 'labQuestAllTests@optimalemd' },
    ];

    return images.flatMap((image) => {
      const imagePath = this.getLabInstructionImagePath(image.fileName);
      if (!imagePath) {
        console.warn(`[Lab order email] Missing instruction image: ${image.fileName}`);
        return [];
      }

      return [
        {
          filename: image.fileName,
          path: imagePath,
          cid: image.cid,
        },
      ];
    });
  }

  private buildLabSchedulingInstructionsHtml() {
    const baseUrl = this.getFrontendBaseUrl();
    const questAppointmentUrl = 'https://www.questdiagnostics.com/appointment';
    const orderImagePath = this.getLabInstructionImagePath('lab-quest-order.png');
    const allTestsImagePath = this.getLabInstructionImagePath('lab-quest-all-tests.png');
    const orderImageSrc = orderImagePath ? 'cid:labQuestOrder@optimalemd' : `${baseUrl}/lab-quest-order.png`;
    const allTestsImageSrc = allTestsImagePath
      ? 'cid:labQuestAllTests@optimalemd'
      : `${baseUrl}/lab-quest-all-tests.png`;

    return `
      <div class="instructions-box">
        <h3 class="instructions-title">How to schedule your lab appointment</h3>
        <p class="instructions-intro">
          Your lab order is attached to this email and is also available in your patient portal under
          <strong>Order Labs</strong>. Follow these steps to schedule at Quest Diagnostics:
        </p>
        <ol class="instructions-list">
          <li>
            Open the attached lab order PDF. Use the Quest appointment link shown on the order —
            <a href="${questAppointmentUrl}">${questAppointmentUrl}</a> — as shown below.
            <p class="screenshot-caption">Lab order — Quest appointment link</p>
            <img
              src="${orderImageSrc}"
              alt="Quest Diagnostics lab order confirmation"
              class="instruction-image"
            />
          </li>
          <li>Enter your information exactly as it appears on your FormaMD profile. This is used to retrieve your exact lab order.</li>
          <li>
            Choose <strong>"All Other Tests"</strong> on the Quest scheduling page, as shown below.
            <p class="screenshot-caption">Quest scheduling — select All Other Tests</p>
            <img
              src="${allTestsImageSrc}"
              alt="Quest Diagnostics — select All Other Tests"
              class="instruction-image"
            />
          </li>
          <li>Follow the prompts on the Quest portal to choose the date, time, and location for your lab work.</li>
          <li>After scheduling, you will receive a Quest confirmation email with your appointment details. We recommend scheduling earlier in the day with <strong>12 hours of fasting</strong> when required.</li>
          <li>Once your labs are complete, we will notify you when results are published. You can then book your provider appointment in the patient portal.</li>
        </ol>
        <p class="portal-note">
          Full instructions with screenshots are also in your portal:
          <a href="${baseUrl}/dashboard">Log in to FormaMD</a> → <strong>Order Labs</strong>.
        </p>
      </div>
    `;
  }

  async sendLabOrderEmail(
    patientEmail: string,
    patientName: string,
    testNames: string,
    attachmentPath?: string,
  ): Promise<void> {
    const schedulingInstructions = this.buildLabSchedulingInstructionsHtml();
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 640px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: left;
          }
          .title {
            color: #dc2626;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
            text-align: center;
          }
          .info-box {
            background-color: #f9f9f9;
            border-left: 4px solid #dc2626;
            padding: 20px;
            margin: 20px 0;
          }
          .info-item {
            margin: 10px 0;
          }
          .info-label {
            font-weight: bold;
            color: #333333;
          }
          .instructions-box {
            background-color: #f9f9f9;
            border: 1px solid #e5e5e5;
            border-radius: 8px;
            padding: 20px;
            margin: 24px 0;
          }
          .instructions-title {
            color: #111111;
            font-size: 18px;
            margin: 0 0 12px;
          }
          .instructions-intro {
            margin: 0 0 16px;
            color: #444444;
          }
          .instructions-list {
            margin: 0 0 16px;
            padding-left: 22px;
            color: #333333;
          }
          .instructions-list li {
            margin-bottom: 10px;
          }
          .screenshot-caption {
            font-size: 13px;
            color: #666666;
            margin: 8px 0 6px;
          }
          .instruction-image {
            display: block;
            max-width: 100%;
            width: 520px;
            height: auto;
            border: 1px solid #dddddd;
            border-radius: 6px;
            margin: 0 0 18px;
          }
          .portal-note {
            margin: 16px 0 0;
            font-size: 14px;
            color: #444444;
          }
          .portal-note a {
            color: #dc2626;
            font-weight: bold;
          }
          .footer {
            background-color: #000000;
            color: #ffffff;
            padding: 20px;
            text-align: center;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 class="logo">FormaMD</h1>
          </div>
          <div class="content">
            <h2 class="title">Lab Order Confirmed</h2>
            <p>Dear ${patientName},</p>
            <p>Your lab order has been confirmed. Please use the instructions below to schedule your Quest Diagnostics appointment.</p>
            
            <div class="info-box">
              <div class="info-item">
                <span class="info-label">Tests ordered:</span> ${testNames || 'Lab panel'}
              </div>
              <div class="info-item">
                <span class="info-label">Lab panel:</span> Your lab panel contains 60+ biomarkers
              </div>
            </div>

            <p>Your lab order PDF is attached to this email and is also available in your patient portal.</p>

            ${schedulingInstructions}
            
            <p style="margin-top: 30px;">Best regards,<br><strong>The FormaMD Team</strong></p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const mailOptions: any = {
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to: patientEmail,
        subject: 'Lab Order Confirmed - FormaMD',
        html,
      };

      const attachments: Array<{
        filename: string;
        path: string;
        cid?: string;
      }> = [...this.getLabInstructionInlineAttachments()];

      if (attachmentPath && fs.existsSync(attachmentPath)) {
        attachments.push({
          filename: path.basename(attachmentPath),
          path: attachmentPath,
        });
      }

      if (attachments.length > 0) {
        mailOptions.attachments = attachments;
      }

      await this.transporter.sendMail(mailOptions);
      console.log(`Lab order email sent successfully to ${patientEmail}${attachmentPath ? ' with attachment' : ''}`);
    } catch (error) {
      console.error('Failed to send lab order email:', error);
      throw error;
    }
  }

  async sendLabResultsEmail(
    patientEmail: string,
    patientName: string,
    testNames: string,
    attachmentPath?: string,
  ): Promise<void> {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            margin: 0;
            padding: 20px;
            background-color: #f4f4f4;
            color: #333333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
          }
          .header {
            background-color: #000000;
            padding: 25px;
            text-align: center;
          }
          .logo {
            color: #ffffff;
            font-size: 24px;
            font-weight: bold;
            text-transform: uppercase;
            margin: 0;
          }
          .content {
            padding: 30px;
            text-align: center;
          }
          .title {
            color: #dc2626;
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 20px;
          }
          .info-box {
            background-color: #f9f9f9;
            border-left: 4px solid #dc2626;
            padding: 20px;
            margin: 20px 0;
            text-align: left;
          }
          .info-item {
            margin: 10px 0;
          }
          .info-label {
            font-weight: bold;
            color: #333333;
          }
          .footer {
            background-color: #000000;
            color: #ffffff;
            padding: 20px;
            text-align: center;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 class="logo">FormaMD</h1>
          </div>
          <div class="content">
            <h2 class="title">Lab Results Available</h2>
            <p>Dear ${patientName},</p>
            <p>Your lab results are now available.</p>
            
            <div class="info-box">
              <div class="info-item">
                <span class="info-label">Lab Panel:</span> Your lab panel contains 60+ bio markers
              </div>
            </div>

            <p>Your lab results have been attached to this email and are also available in your patient portal. Your healthcare provider will review these results and contact you if any follow-up is needed.</p>
            
            <div class="info-box" style="margin-top: 30px; background-color: #e8f4f8; border-left-color: #3b82f6;">
              <p style="margin: 0; font-weight: bold; color: #1e40af;">Next Steps:</p>
              <p style="margin: 10px 0 0 0; color: #1e3a8a;">Your lab results are now available. You can now book an appointment to discuss your results with your healthcare provider.</p>
            </div>
            
            <p style="margin-top: 30px;">Best regards,<br><strong>The FormaMD Team</strong></p>
          </div>
          <div class="footer">
            <p>This is an automated email, please do not reply.</p>
            <p>&copy; ${new Date().getFullYear()} FormaMD</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      const mailOptions: any = {
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to: patientEmail,
        subject: 'Lab Results Available - FormaMD',
        html,
      };

      // Add attachment if file path is provided
      if (attachmentPath && fs.existsSync(attachmentPath)) {
        const fileName = path.basename(attachmentPath);
        mailOptions.attachments = [
          {
            filename: fileName,
            path: attachmentPath,
          },
        ];
      }

      await this.transporter.sendMail(mailOptions);
      console.log(`Lab results email sent successfully to ${patientEmail}${attachmentPath ? ' with attachment' : ''}`);
    } catch (error) {
      console.error('Failed to send lab results email:', error);
      throw error;
    }
  }

  async sendReferralCreditEmail(to: string, name: string, creditPct: number, isSubscribed: boolean): Promise<void> {
    const context = isSubscribed ? 'your next monthly subscription renewal' : 'your next appointment';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f4f4f4; color: #333333; }
          .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background-color: #000000; padding: 25px; text-align: center; }
          .logo { color: #ffffff; font-size: 24px; font-weight: bold; text-transform: uppercase; margin: 0; }
          .content { padding: 30px; }
          .credit-badge { background-color: #22c55e; color: #ffffff; font-size: 28px; font-weight: bold; text-align: center; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { background-color: #f9f9f9; padding: 20px; text-align: center; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <p class="logo">FormaMD</p>
          </div>
          <div class="content">
            <h2>You earned a referral credit! 🎉</h2>
            <p>Hi ${name},</p>
            <p>Great news! A patient you referred just completed their first appointment. As a thank-you, we've added a <strong>${creditPct}% discount</strong> to your account.</p>
            <div class="credit-badge">${creditPct}% OFF</div>
            <p>This credit will automatically be applied to ${context}. Credits expire 30 days after being earned, so use them soon!</p>
            <p>Keep sharing your referral link to earn more credits. You can view your current balance in the <strong>Referrals &amp; Credits</strong> section of your dashboard.</p>
            <p>Thank you for helping grow the FormaMD community!</p>
            <p>— The FormaMD Team</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} FormaMD. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: `You earned ${creditPct}% credit — referral qualified!`,
        html,
      });
      console.log(`Referral credit email sent to ${to}`);
    } catch (error) {
      console.error('Failed to send referral credit email:', error);
      throw error;
    }
  }

  async sendReviewCreditEmail(to: string, name: string, creditPct: number, isSubscribed: boolean): Promise<void> {
    const context = isSubscribed ? 'your next monthly subscription renewal' : 'your next appointment';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f4f4f4; color: #333333; }
          .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background-color: #000000; padding: 25px; text-align: center; }
          .logo { color: #ffffff; font-size: 24px; font-weight: bold; text-transform: uppercase; margin: 0; }
          .content { padding: 30px; }
          .credit-badge { background-color: #eab308; color: #000000; font-size: 28px; font-weight: bold; text-align: center; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { background-color: #f9f9f9; padding: 20px; text-align: center; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <p class="logo">FormaMD</p>
          </div>
          <div class="content">
            <h2>Your review credit has been applied! ⭐</h2>
            <p>Hi ${name},</p>
            <p>Our team has verified your review — thank you for taking the time to share your experience! We've added a <strong>${creditPct}% discount</strong> to your account as a token of our appreciation.</p>
            <div class="credit-badge">${creditPct}% OFF</div>
            <p>This credit will automatically be applied to ${context}. Credits expire 30 days after being earned.</p>
            <p>You can view your current balance in the <strong>Referrals &amp; Credits</strong> section of your dashboard.</p>
            <p>Thank you for being a valued member of the FormaMD community!</p>
            <p>— The FormaMD Team</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} FormaMD. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject: `Your ${creditPct}% review credit has been applied!`,
        html,
      });
      console.log(`Review credit email sent to ${to}`);
    } catch (error) {
      console.error('Failed to send review credit email:', error);
      throw error;
    }
  }

  async sendUnreadMessageReminderEmail(
    patientEmail: string,
    patientName: string,
    senderName: string,
  ): Promise<void> {
    const safeSenderName = senderName?.trim() || 'your care team';
    const loginUrl = `https://formamd.com/login`;
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f4f4f4; color: #333333; }
          .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background-color: #000000; padding: 24px; text-align: center; }
          .logo { color: #ffffff; font-size: 24px; font-weight: bold; margin: 0; }
          .content { padding: 28px; }
          .notice-box { background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 18px 0; }
          .cta-wrap { text-align: center; margin: 24px 0 10px; }
          .cta-button {
            display: inline-block;
            background-color: #ef4444;
            color: #ffffff !important;
            text-decoration: none;
            font-weight: 600;
            padding: 12px 22px;
            border-radius: 8px;
          }
          .link-fallback { font-size: 12px; color: #666666; word-break: break-all; margin-top: 10px; }
          .footer { background-color: #f9f9f9; padding: 16px; text-align: center; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <p class="logo">FormaMD</p>
          </div>
          <div class="content">
            <p>Hi ${patientName},</p>
            <p>You received a new message in your FormaMD portal.</p>
            <div class="notice-box">
              <strong>From:</strong> ${safeSenderName}
            </div>
            <p>Please log in to your account to review and respond.</p>
            <div class="cta-wrap">
              <a href="${loginUrl}" class="cta-button">Log in to Portal</a>
              <p class="link-fallback">If the button does not work, copy and paste this link into your browser: ${loginUrl}</p>
            </div>
            <p>Best,<br/>The FormaMD Team</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} FormaMD. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to: patientEmail,
        subject: `You received a message from "${safeSenderName}"`,
        html,
      });
      console.log(`Unread message reminder email sent to ${patientEmail}`);
    } catch (error) {
      console.error('Failed to send unread message reminder email:', error);
      throw error;
    }
  }

  async sendNewsletterWelcomeEmail(params: {
    to: string;
    firstName: string;
    latestBlogTitle?: string;
    latestBlogUrl: string;
    blogsListUrl: string;
    isResubscribe?: boolean;
  }): Promise<void> {
    const {
      to,
      firstName,
      latestBlogTitle,
      latestBlogUrl,
      blogsListUrl,
      isResubscribe,
    } = params;

    const safeName = firstName || 'there';
    const intro = isResubscribe
      ? `You're already on our list — here's the latest from FormaMD.`
      : `Thanks for subscribing to the FormaMD newsletter!`;

    const blogBlock = latestBlogTitle
      ? `
            <p>Our latest article: <strong>${latestBlogTitle}</strong></p>
            <p style="text-align: center; margin: 28px 0;">
              <a href="${latestBlogUrl}" class="cta-button">Read the latest blog</a>
            </p>
          `
      : `
            <p style="text-align: center; margin: 28px 0;">
              <a href="${blogsListUrl}" class="cta-button">Browse our blog</a>
            </p>
          `;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f4f4f4; color: #333333; }
          .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background-color: #000000; padding: 25px; text-align: center; }
          .logo { color: #ffffff; font-size: 24px; font-weight: bold; text-transform: uppercase; margin: 0; }
          .content { padding: 30px; }
          .cta-button { display: inline-block; background-color: #dc2626; color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 999px; font-weight: bold; font-size: 16px; }
          .secondary-link { color: #dc2626; font-weight: bold; }
          .footer { background-color: #f9f9f9; padding: 20px; text-align: center; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <p class="logo">FormaMD</p>
          </div>
          <div class="content">
            <h2>Welcome to FormaMD Insights</h2>
            <p>Hi ${safeName},</p>
            <p>${intro}</p>
            <p>You'll receive expert tips on hormones, metabolism, performance, and longevity — straight to your inbox.</p>
            ${blogBlock}
            <p>Explore more articles anytime: <a href="${blogsListUrl}" class="secondary-link">View all blogs</a></p>
            <p>— The FormaMD Team</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} FormaMD. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const subject = latestBlogTitle
      ? `Welcome! Read our latest: ${latestBlogTitle}`
      : 'Welcome to the FormaMD newsletter';

    try {
      await this.transporter.sendMail({
        from: `"FormaMD" <${this.configService.get<string>('SMTP_FROM')}>`,
        to,
        subject,
        html,
        text: `${intro}\n\nRead the latest: ${latestBlogUrl}\n\nAll blogs: ${blogsListUrl}`,
      });
      console.log(`Newsletter welcome email sent to ${to}`);
    } catch (error) {
      console.error('Failed to send newsletter welcome email:', error);
      throw error;
    }
  }
} 