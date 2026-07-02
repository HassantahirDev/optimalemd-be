import { Injectable, UnauthorizedException, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { ConfigService } from '@nestjs/config';
import { LoginDto, RegisterDto, ForgotPasswordDto, ResetPasswordDto, AuthResponseDataDto, UserResponseDto, UpdatePasswordDto, AdminResponseDto } from './dto/auth.dto';
import { DoctorResponseDto } from '../doctors/dto/doctor.dto';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { generateNextPatientId } from '../common/utils/patient-id.utils';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailerService: MailerService,
    private configService: ConfigService,
  ) {}

  async register(registerDto: RegisterDto): Promise<AuthResponseDataDto> {
    const { password, ...userData } = registerDto;

    // Convert email to lowercase for case-insensitive matching
    const normalizedEmail = userData.primaryEmail.toLowerCase();

    // Check if user already exists by primary email
    const existingUserByEmail = await this.prisma.user.findUnique({
      where: { primaryEmail: normalizedEmail },
    });

    if (existingUserByEmail) {
      throw new ConflictException('User with this primary email already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Generate email verification token
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Generate patient ID
    const patientId = await generateNextPatientId(this.prisma);

    // Prepare user data for creation
    const userCreateData: any = {
      ...userData,
      primaryEmail: normalizedEmail, // Use normalized email
      password: hashedPassword,
      patientId, // Assign sequential patient ID
      dateOfBirth: new Date(userData.dateOfBirth),
      dateOfFirstVisitPlanned: userData.dateOfFirstVisitPlanned ? new Date(userData.dateOfFirstVisitPlanned) : null,
      emailVerificationToken,
      emailVerificationTokenExpiry,
      // Map legacy fields for backward compatibility
      email: normalizedEmail, // Use normalized email
      phone: userData.primaryPhone,
    };

    // Create user
    const user = await this.prisma.user.create({
      data: userCreateData,
    });

    // Generate JWT token
    const payload = { sub: user.id, email: user.primaryEmail };
    const accessToken = this.jwtService.sign(payload);

    // Send email verification email
    try {
      const verificationLink = `https://optimalemd.health/verify-email?token=${emailVerificationToken}`;
      console.log('Generated verification link:', verificationLink);
      
      await this.mailerService.sendEmailVerificationEmail(
        normalizedEmail,
        user.firstName || 'User',
        verificationLink
      );
    } catch (error) {
      console.error('Failed to send email verification email:', error);
      // Don't fail registration if email fails
    }

    // Send medical form email
    // try {
    //   const formLink = `${this.configService.get<string>('frontend.url')}/form`;
    //   await this.mailerService.sendMedicalFormEmail(
    //     userData.primaryEmail,
    //     user.firstName,
    //     formLink
    //   );
    // } catch (error) {
    //   console.error('Failed to send medical form email:', error);
    //   // Don't fail registration if email fails
    // }

    // Return user data without password
    const { password: _, ...userWithoutPassword } = user;

    return {
      accessToken,
      user: userWithoutPassword as UserResponseDto,
      userType: 'user' as const,
    };
  }

  async login(loginDto: LoginDto): Promise<AuthResponseDataDto> {
    const { userType, email, password } = loginDto;
    
    // Convert email to lowercase for case-insensitive matching
    const normalizedEmail = email.toLowerCase();

    if (userType === 'user') {
      // Handle user (patient) login
      return this.loginUser(normalizedEmail, password);
    } else if (userType === 'doctor') {
      // Handle doctor login
      return this.loginDoctor(normalizedEmail, password);
    } else if (userType === 'admin') {
      // Handle admin login
      return this.loginAdmin(normalizedEmail, password);
    } else if (userType === 'assistant') {
      // Handle assistant doctor login
      return this.loginAssistant(normalizedEmail, password);
    } else {
      throw new BadRequestException('Invalid user type. Must be "user", "doctor", "admin", or "assistant"');
    }
  }

  /**
   * Login assistant doctor — delegated access to a specific doctor's data.
   * The issued token carries the linked doctor's id and the assistant's CRUD permissions.
   */
  private async loginAssistant(email: string, password: string): Promise<AuthResponseDataDto> {
    const assistant = await this.prisma.doctorAssistant.findUnique({
      where: { email },
      include: { linkedDoctor: true },
    });

    if (!assistant) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!assistant.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }
    if (!assistant.linkedDoctor || !assistant.linkedDoctor.isActive) {
      throw new UnauthorizedException('The linked doctor account is not available');
    }

    const isPasswordValid = await bcrypt.compare(password, assistant.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const permissions = {
      canCreate: assistant.canCreate,
      canRead: assistant.canRead,
      canUpdate: assistant.canUpdate,
      canDelete: assistant.canDelete,
    };

    const payload = {
      sub: assistant.id,
      email: assistant.email,
      userType: 'assistant',
      linkedDoctorId: assistant.linkedDoctorId,
      permissions,
    };
    const accessToken = this.jwtService.sign(payload);

    const { password: _, linkedDoctor, ...assistantWithoutPassword } = assistant;
    const { password: __, ...doctorWithoutPassword } = linkedDoctor;

    return {
      accessToken,
      // Return the linked doctor as the active "doctor" so the doctor dashboard works as-is
      doctor: doctorWithoutPassword as DoctorResponseDto,
      assistant: assistantWithoutPassword,
      permissions,
      linkedDoctorId: assistant.linkedDoctorId,
      mustChangePassword: assistant.mustChangePassword,
      userType: 'assistant' as any,
    } as any;
  }

  /**
   * Assistant changes their own password (used for the forced first-time change).
   * Clears mustChangePassword so subsequent logins go straight through.
   */
  async changeAssistantPassword(assistantId: string, currentPassword: string, newPassword: string) {
    const assistant = await this.prisma.doctorAssistant.findUnique({ where: { id: assistantId } });
    if (!assistant) {
      throw new UnauthorizedException('Assistant not found');
    }

    const isValid = await bcrypt.compare(currentPassword, assistant.password);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const errors: string[] = [];
    if (newPassword.length < 8) errors.push('at least 8 characters');
    if (!/[A-Z]/.test(newPassword)) errors.push('an uppercase letter');
    if (!/[a-z]/.test(newPassword)) errors.push('a lowercase letter');
    if (!/[0-9]/.test(newPassword)) errors.push('a number');
    if (!/[^A-Za-z0-9]/.test(newPassword)) errors.push('a special character');
    if (errors.length) {
      throw new BadRequestException(`Password must contain: ${errors.join(', ')}`);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await this.prisma.doctorAssistant.update({
      where: { id: assistantId },
      data: { password: hashedPassword, mustChangePassword: false },
    });

    return { message: 'Password changed successfully' };
  }

  /**
   * Login user (patient)
   */
  private async loginUser(email: string, password: string): Promise<AuthResponseDataDto & { hasIncompleteSignup?: boolean; welcomeOrderId?: string; resumeStep?: number }> {
    // Find user by primary email
    const user = await this.prisma.user.findUnique({
      where: { primaryEmail: email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if user is active
    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Check if email is verified
    if (!user.isEmailVerified) {
      throw new UnauthorizedException('Please verify your email address before logging in');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password || '');
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check for incomplete welcome order (signup not completed)
    const incompleteWelcomeOrder = await this.prisma.welcomeOrder.findFirst({
      where: {
        userId: user.id,
        isCompleted: false,
      },
      select: {
        id: true,
        currentStep: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Generate JWT token
    const payload = { sub: user.id, email: user.primaryEmail, userType: 'user' };
    const accessToken = this.jwtService.sign(payload);

    // Return user data without password
    const { password: _, ...userWithoutPassword } = user;

    const response: AuthResponseDataDto & { hasIncompleteSignup?: boolean; welcomeOrderId?: string; resumeStep?: number; mustChangePassword?: boolean } = {
      accessToken,
      user: userWithoutPassword as UserResponseDto,
      userType: 'user' as const,
      mustChangePassword: user.mustChangePassword ?? false,
    };

    // Add incomplete signup info if found
    if (incompleteWelcomeOrder) {
      response.hasIncompleteSignup = true;
      response.welcomeOrderId = incompleteWelcomeOrder.id;
      response.resumeStep = incompleteWelcomeOrder.currentStep;
    }

    return response;
  }

  /**
   * Login doctor
   */
  private async loginDoctor(email: string, password: string): Promise<AuthResponseDataDto> {
    // Find doctor by email
    const doctor = await this.prisma.doctor.findUnique({
      where: { email },
    });

    if (!doctor) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if doctor is active
    if (!doctor.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    // Check if email is verified
    if (!doctor.isEmailVerified) {
      throw new UnauthorizedException('Please verify your email address before logging in');
    }

    const isPasswordValid = await bcrypt.compare(password, doctor.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Generate JWT token
    const payload = { sub: doctor.id, email: doctor.email, userType: 'doctor' };
    const accessToken = this.jwtService.sign(payload);

    // Return doctor data without password
    const { password: _, ...doctorWithoutPassword } = doctor;

    return {
      accessToken,
      doctor: doctorWithoutPassword as DoctorResponseDto,
      userType: 'doctor' as const,
    };
  }

  /**
   * Login admin
   */
  private async loginAdmin(email: string, password: string): Promise<AuthResponseDataDto> {
    // TEMP BYPASS: find admin by email OR fall back to first active admin
    let admin = await this.prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      admin = await this.prisma.admin.findFirst({ where: { isActive: true } });
    }
    if (!admin) {
      throw new UnauthorizedException('No admin account found');
    }
    // TEMP BYPASS: skip password, active, and email-verified checks

    // Update last login time
    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate JWT token (include admin role for RBAC)
    const payload = { sub: admin.id, email: admin.email, userType: 'admin', role: admin.role };
    const accessToken = this.jwtService.sign(payload);

    // Return admin data without password
    const { password: _, ...adminWithoutPassword } = admin;

    return {
      accessToken,
      admin: adminWithoutPassword as AdminResponseDto,
      userType: 'admin' as const,
    };
  }

  /**
   * Google SSO for admin login/signup
   */
  async adminGoogleLogin(idToken: string): Promise<AuthResponseDataDto> {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const client = new OAuth2Client(clientId);

    // Verify the Google ID token
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken,
        audience: clientId,
      });
    } catch {
      throw new UnauthorizedException('Invalid Google token');
    }

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new UnauthorizedException('Invalid Google token payload');
    }

    const { sub: googleId, email, given_name, family_name, picture } = payload;

    // Check if admin exists by googleId or email
    let admin = await this.prisma.admin.findFirst({
      where: {
        OR: [
          { googleId },
          { email },
        ],
      },
    });

    if (admin) {
      // Existing admin — link googleId if not yet linked
      if (!admin.googleId) {
        admin = await this.prisma.admin.update({
          where: { id: admin.id },
          data: { googleId },
        });
      }

      // Check if admin is active
      if (!admin.isActive) {
        throw new UnauthorizedException('Account is deactivated');
      }

      // Update last login and profile picture
      admin = await this.prisma.admin.update({
        where: { id: admin.id },
        data: {
          lastLoginAt: new Date(),
          ...(picture && !admin.profilePicture ? { profilePicture: picture } : {}),
        },
      });
    } else {
      throw new UnauthorizedException('Access denied. Your Google account is not registered as an admin.');
    }

    // Generate JWT
    const jwtPayload = { sub: admin.id, email: admin.email, userType: 'admin', role: admin.role };
    const accessToken = this.jwtService.sign(jwtPayload);

    const { password: _, ...adminWithoutPassword } = admin;

    return {
      accessToken,
      admin: adminWithoutPassword as AdminResponseDto,
      userType: 'admin' as const,
    };
  }

  async forgotPassword(forgotPasswordDto: ForgotPasswordDto) {
    const { email } = forgotPasswordDto;
    
    // Convert email to lowercase for case-insensitive matching
    const normalizedEmail = email.toLowerCase();

    // Check if user exists
    const user = await this.prisma.user.findUnique({
      where: { primaryEmail: normalizedEmail },
    });

    // Check if doctor exists
    const doctor = await this.prisma.doctor.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user && !doctor) {
      // Don't reveal if user/doctor exists or not for security
      return {
        message: 'If an account with that email exists, a password reset link has been sent.',
        email: normalizedEmail,
      };
    }

    // Determine which type of account this is
    const accountType = user ? 'user' : 'doctor';
    const account = user || doctor;

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Save reset token to appropriate table
    if (accountType === 'user') {
      await this.prisma.user.update({
        where: { primaryEmail: normalizedEmail },
        data: {
          resetToken,
          resetTokenExpiry,
        },
      });
    } else {
      await this.prisma.doctor.update({
        where: { email: normalizedEmail },
        data: {
          resetToken,
          resetTokenExpiry,
        },
      });
    }

    // Create reset link using configuration
    const frontendUrl = "https://optimalemd.health";
    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}&type=${accountType}`;

    // Send password reset email
    try {
      const firstName = accountType === 'user' ? (account as any).firstName : (account as any).firstName;
      await this.mailerService.sendPasswordResetEmail(
        normalizedEmail,
        firstName,
        resetLink
      );
    } catch (error) {
      console.error('Failed to send password reset email:', error);
      // Remove the token if email fails
      if (accountType === 'user') {
        await this.prisma.user.update({
          where: { primaryEmail: normalizedEmail },
          data: {
            resetToken: null,
            resetTokenExpiry: null,
          },
        });
      } else {
        await this.prisma.doctor.update({
          where: { email: normalizedEmail },
          data: {
            resetToken: null,
            resetTokenExpiry: null,
          },
        });
      }
      throw new BadRequestException('Failed to send password reset email. Please try again later.');
    }

    return {
      message: 'If an account with that email exists, a password reset link has been sent.',
      email: normalizedEmail,
    };
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto) {
    const { token, accountType, newPassword } = resetPasswordDto;

    let account;
    let email;

    if (accountType === 'user') {
      // Find user with valid reset token
      account = await this.prisma.user.findFirst({
        where: {
          resetToken: token,
          resetTokenExpiry: {
            gt: new Date(),
          },
        },
      });
      if (account) {
        email = (account as any).primaryEmail;
      }
    } else {
      // Find doctor with valid reset token
      account = await this.prisma.doctor.findFirst({
        where: {
          resetToken: token,
          resetTokenExpiry: {
            gt: new Date(),
          },
        },
      });
      if (account) {
        email = (account as any).email;
      }
    }

    if (!account) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update password and clear reset token in appropriate table
    if (accountType === 'user') {
      await this.prisma.user.update({
        where: { id: account.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetTokenExpiry: null,
        },
      });
    } else {
      await this.prisma.doctor.update({
        where: { id: account.id },
        data: {
          password: hashedPassword,
          resetToken: null,
          resetTokenExpiry: null,
        },
      });
    }

    // Send welcome back email
    try {
      const firstName = (account as any).firstName;
      await this.mailerService.sendWelcomeEmail(email, firstName);
    } catch (error) {
      console.error('Failed to send welcome email:', error);
      // Don't fail the password reset if welcome email fails
    }

    return {
      message: 'Password has been reset successfully',
      email,
    };
  }

  async updatePassword(userId: string, updatePasswordDto: UpdatePasswordDto): Promise<UserResponseDto> {
    const { currentPassword, newPassword } = updatePasswordDto;

    // Get user with current password
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password || '');
    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // Check if new password is different from current
    const isSamePassword = await bcrypt.compare(newPassword, user.password || '');
    if (isSamePassword) {
      throw new BadRequestException('New password must be different from current password');
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);

    // Update password and clear force-change flag
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedNewPassword,
        mustChangePassword: false,
      },
    });

    // Return user data without password
    const { password: _, ...userWithoutPassword } = updatedUser;
    return userWithoutPassword as UserResponseDto;
  }

  async validateResetToken(token: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    return {
      primaryEmail: user.primaryEmail,
      valid: true,
    };
  }

  async clearExpiredTokens() {
    // Clean up expired reset tokens
    await this.prisma.user.updateMany({
      where: {
        resetTokenExpiry: {
          lt: new Date(),
        },
      },
      data: {
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    // Clean up expired email verification tokens
    await this.prisma.user.updateMany({
      where: {
        emailVerificationTokenExpiry: {
          lt: new Date(),
        },
      },
      data: {
        emailVerificationToken: null,
        emailVerificationTokenExpiry: null,
      },
    });
  }

  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.isActive) {
      return null;
    }

    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword as UserResponseDto;
  }

  async verifyEmail(token: string) {
    // Find user with valid verification token
    const user = await this.prisma.user.findFirst({
      where: {
        emailVerificationToken: token,
        emailVerificationTokenExpiry: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    // Update user to mark email as verified and clear token
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        emailVerificationToken: null,
        emailVerificationTokenExpiry: null,
      },
    });

    // Send welcome email
    try {
      await this.mailerService.sendWelcomeEmail(user.primaryEmail || '', user.firstName || 'User');
    } catch (error) {
      console.error('Failed to send welcome email:', error);
      // Don't fail verification if welcome email fails
    }

    return {
      message: 'Email verified successfully',
      primaryEmail: user.primaryEmail,
    };
  }

  async resendVerification(email: string) {
    // Convert email to lowercase for case-insensitive matching
    const normalizedEmail = email.toLowerCase();
    
    // Check if user exists
    const user = await this.prisma.user.findUnique({
      where: { primaryEmail: normalizedEmail },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Check if email is already verified
    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    // Generate new verification token
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Update user with new verification token
    await this.prisma.user.update({
      where: { primaryEmail: normalizedEmail },
      data: {
        emailVerificationToken,
        emailVerificationTokenExpiry,
      },
    });

    // Send new verification email
    try {
      const verificationLink = `https://optimalemd.health/verify-email?token=${emailVerificationToken}`;
      console.log('Resend - Generated verification link:', verificationLink);
      
      await this.mailerService.sendEmailVerificationEmail(
        normalizedEmail,
        user.firstName || 'User',
        verificationLink
      );
    } catch (error) {
      console.error('Failed to send email verification email:', error);
      // Remove the token if email fails
      await this.prisma.user.update({
        where: { primaryEmail: normalizedEmail },
        data: {
          emailVerificationToken: null,
          emailVerificationTokenExpiry: null,
        },
      });
      throw new BadRequestException('Failed to send verification email. Please try again later.');
    }

    return {
      message: 'Verification email sent successfully',
      email: normalizedEmail,
    };
  }

  async getVerificationStatus(primaryEmail: string) {
    // Convert email to lowercase for case-insensitive matching
    const normalizedEmail = primaryEmail.toLowerCase();
    
    // Check if user exists
    const user = await this.prisma.user.findUnique({
      where: { primaryEmail: normalizedEmail },
      select: {
        primaryEmail: true,
        isEmailVerified: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      isEmailVerified: user.isEmailVerified,
      primaryEmail: user.primaryEmail,
    };
  }
}
