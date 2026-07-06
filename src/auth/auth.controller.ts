import { Controller, Post, Body, HttpCode, HttpStatus, Get, Query, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiUnauthorizedResponse,
  ApiInternalServerErrorResponse
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import {
  LoginDto,
  RegisterDto,
  ForgotPasswordDto,
  ResetPasswordDto,

  AuthResponseDto,
  PasswordResetResponseDto,

} from './dto/auth.dto';
import { BaseApiResponse } from '../common/dto/api-response.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) { }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Get current authenticated identity',
    description: 'Returns the current user. For assistants, includes live CRUD permissions and linked doctor from the database.',
  })
  async getMe(@Req() req: any) {
    const u = req.user;
    if (u?.isAssistant) {
      const [firstName, ...rest] = (u.assistantName || '').split(' ');
      return {
        success: true,
        data: {
          userType: 'assistant',
          assistantId: u.assistantId,
          firstName: firstName || 'Assistant',
          lastName: rest.join(' '),
          linkedDoctorId: u.linkedDoctorId,
          permissions: u.permissions,
        },
      };
    }
    return { success: true, data: { userType: u?.userType, id: u?.id } };
  }

  @Post('assistant/change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assistant changes own password',
    description: 'Used for the forced first-time password change. Clears the must-change flag.',
  })
  async assistantChangePassword(
    @Req() req: any,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    if (!req.user?.isAssistant || !req.user?.assistantId) {
      return { success: false, message: 'Only assistant accounts can use this endpoint' };
    }
    const result = await this.authService.changeAssistantPassword(
      req.user.assistantId,
      body.currentPassword,
      body.newPassword,
    );
    return { success: true, message: result.message };
  }

  @Post('register')
  @ApiOperation({
    summary: 'User Registration',
    description: 'Register a new user account with all required medical information and optional fields.',
  })
  @ApiBody({
    type: RegisterDto,
    description: 'User registration data',
    examples: {
      basic: {
        summary: 'Basic Registration',
        description: 'Register with required fields only',
        value: {
          title: 'Mr',
          firstName: 'John',
          middleName: 'Michael',
          lastName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'Male',
          completeAddress: '123 Main St, Apt 4B',
          city: 'New York',
          state: 'NY',
          zipcode: '10001',
          primaryEmail: 'john.doe@example.com',
          alternativeEmail: 'john.doe.alternative@example.com',
          primaryPhone: '+1234567890',
          alternativePhone: '+1987654321',
          emergencyContactName: 'Jane Doe',
          emergencyContactRelationship: 'Spouse',
          emergencyContactPhone: '+1234567890',
          referringSource: 'Self',
          consentForTreatment: 'Y',
          hipaaPrivacyNoticeAcknowledgment: 'Y',
          releaseOfMedicalRecordsConsent: 'Y',
          preferredMethodOfCommunication: 'Email',
          disabilityAccessibilityNeeds: 'None',
          password: 'securepassword123',
        } as RegisterDto,
      },
      full: {
        summary: 'Full Registration',
        description: 'Register with all available fields including optional ones',
        value: {
          title: 'Dr',
          firstName: 'Jane',
          middleName: 'Elizabeth',
          lastName: 'Smith',
          dateOfBirth: '1985-05-15',
          gender: 'Female',
          completeAddress: '456 Oak Ave, Suite 200',
          city: 'Los Angeles',
          state: 'CA',
          zipcode: '90210',
          primaryEmail: 'jane.smith@example.com',
          alternativeEmail: 'jane.smith.alternative@example.com',
          primaryPhone: '+1234567890',
          alternativePhone: '+1987654321',
          emergencyContactName: 'John Smith',
          emergencyContactRelationship: 'Spouse',
          emergencyContactPhone: '+1234567890',
          referringSource: 'Physician',
          consentForTreatment: 'Y',
          hipaaPrivacyNoticeAcknowledgment: 'Y',
          releaseOfMedicalRecordsConsent: 'Y',
          preferredMethodOfCommunication: 'Phone',
          disabilityAccessibilityNeeds: 'None',
          careProviderPhone: '+1555123456',
          lastFourDigitsSSN: '1234',
          languagePreference: 'English',
          ethnicityRace: 'Caucasian',
          primaryCarePhysician: 'Dr. Johnson',
          insuranceProviderName: 'Blue Cross Blue Shield',
          insurancePolicyNumber: 'POL123456789',
          insuranceGroupNumber: 'GRP987654321',
          insurancePhoneNumber: '+18005551234',
          guarantorResponsibleParty: 'Jane Smith',
          dateOfFirstVisitPlanned: '2024-02-15',
          interpreterRequired: 'N',
          advanceDirectives: 'N',
          password: 'securepassword123',
        } as RegisterDto,
      },
    },
  })
  async register(@Body() registerDto: RegisterDto): Promise<AuthResponseDto> {
    const data = await this.authService.register(registerDto);
    return {
      success: true,
      statusCode: HttpStatus.CREATED,
      message: 'User registered successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/auth/register',
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'User/Doctor Login',
    description: 'Authenticate a user (patient) or doctor with email and password.',
  })
  @ApiBody({
    type: LoginDto,
    description: 'Login credentials with user type',
    examples: {
      userLogin: {
        summary: 'User (Patient) Login',
        description: 'Login as a patient user',
        value: {
          userType: 'user',
          email: 'john.doe@example.com',
          password: 'securepassword123'
        } as LoginDto,
      },
      doctorLogin: {
        summary: 'Doctor Login',
        description: 'Login as a healthcare provider',
        value: {
          userType: 'doctor',
          email: 'dr.smith@example.com',
          password: 'securepassword123'
        } as LoginDto,
      },
    },
  })
  @ApiOkResponse({
    description: 'Login successful',
    type: AuthResponseDto,
    examples: {
      userSuccess: {
        summary: 'User Login Success',
        value: {
          success: true,
          statusCode: 200,
          message: 'Login successful',
          data: {
            accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            user: {
              id: '123e4567-e89b-12d3-a456-426614174000',
              title: 'Mr',
              firstName: 'John',
              // ... other user fields
            },
            userType: 'user'
          },
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/login',
        },
      },
      doctorSuccess: {
        summary: 'Doctor Login Success',
        value: {
          success: true,
          statusCode: 200,
          message: 'Login successful',
          data: {
            accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            user: {
              id: '123e4567-e89b-12d3-a456-426614174000',
              email: 'dr.smith@example.com',
              title: 'Dr',
              firstName: 'John',
              // ... other doctor fields
            },
            userType: 'doctor'
          },
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/login',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error or invalid user type',
    examples: {
      invalidUserType: {
        summary: 'Invalid User Type',
        value: {
          success: false,
          statusCode: 400,
          message: 'Invalid user type. Must be either "user" or "doctor"',
          error: 'BadRequestError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/login',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid credentials or account issues',
    examples: {
      invalidCredentials: {
        summary: 'Invalid Credentials',
        value: {
          success: false,
          statusCode: 401,
          message: 'Invalid credentials',
          error: 'UnauthorizedError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/login',
        },
      },
      unverifiedEmail: {
        summary: 'Unverified Email',
        value: {
          success: false,
          statusCode: 401,
          message: 'Please verify your email address before logging in',
          error: 'UnauthorizedError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/login',
        },
      },
      deactivatedAccount: {
        summary: 'Deactivated Account',
        value: {
          success: false,
          statusCode: 401,
          message: 'Account is deactivated',
          error: 'UnauthorizedError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/login',
        },
      },
    },
  })
  async login(@Body() loginDto: LoginDto) {
    const data = await this.authService.login(loginDto);
    return {
      success: true,
      statusCode: 200,
      message: 'Login successful',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/auth/login',
    };
  }

  @Post('admin-google-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin Google SSO Login/Signup',
    description: 'Authenticate or register an admin using Google SSO. If the admin already exists, logs them in. If not, creates a new admin account.',
  })
  async adminGoogleLogin(@Body() body: { idToken: string }) {
    const data = await this.authService.adminGoogleLogin(body.idToken);
    return {
      success: true,
      statusCode: 200,
      message: 'Login successful',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/auth/admin-google-login',
    };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Forgot Password',
    description: 'Request a password reset link for user or doctor accounts.',
  })
  @ApiBody({
    type: ForgotPasswordDto,
    description: 'Email address for password reset',
    examples: {
      forgotPassword: {
        summary: 'Forgot Password Request',
        description: 'Enter your email address to receive a password reset link',
        value: {
          email: 'john.doe@example.com'
        } as ForgotPasswordDto,
      },
    },
  })
  @ApiOkResponse({
    description: 'Password reset email sent successfully',
    type: PasswordResetResponseDto,
    examples: {
      success: {
        summary: 'Reset Email Sent',
        value: {
          success: true,
          statusCode: 200,
          message: 'Password reset email sent successfully',
          data: {
            message: 'If an account with that email exists, a password reset link has been sent.',
            email: 'john.doe@example.com',
          },
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/forgot-password',
        },
      },
    },
  })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    const data = await this.authService.forgotPassword(forgotPasswordDto);
    return {
      success: true,
      statusCode: 200,
      message: 'Password reset email sent successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/auth/forgot-password',
    };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset Password',
    description: 'Reset password using the token received via email for user or doctor accounts.',
  })
  @ApiBody({
    type: ResetPasswordDto,
    description: 'Password reset data with token and new password',
    examples: {
      resetPassword: {
        summary: 'Reset Password',
        description: 'Enter the reset token and new password',
        value: {
          token: 'reset_token_1234567890abcdef',
          accountType: 'user',
          newPassword: 'newpassword123'
        } as ResetPasswordDto,
      },
    },
  })
  @ApiOkResponse({
    description: 'Password reset successful',
    type: PasswordResetResponseDto,
    examples: {
      success: {
        summary: 'Password Reset Success',
        value: {
          success: true,
          statusCode: 200,
          message: 'Password reset successful',
          data: {
            message: 'Password has been reset successfully',
            email: 'john.doe@example.com',
          },
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/reset-password',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid or expired reset token',
    examples: {
      invalidToken: {
        summary: 'Invalid Token',
        value: {
          success: false,
          statusCode: 400,
          message: 'Invalid or expired reset token',
          error: 'BadRequestError',
          timestamp: '2024-12-20T10:00:00.000Z',
          path: '/api/auth/reset-password',
        },
      },
    },
  })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    const data = await this.authService.resetPassword(resetPasswordDto);
    return {
      success: true,
      statusCode: 200,
      message: 'Password reset successful',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/auth/reset-password',
    };
  }

  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify Email',
    description: 'Verify user email address using verification token received via email.',
  })
  async verifyEmail(@Query('token') token: string): Promise<BaseApiResponse<any>> {
    const data = await this.authService.verifyEmail(token);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Email verified successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/auth/verify-email',
    };
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend Email Verification',
    description: 'Resend email verification link to user\'s primary email address.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          format: 'email',
          example: 'john.doe@example.com',
          description: 'Primary email address to resend verification to',
        },
      },
      required: ['email'],
    },
    description: 'Email address for verification resend',
  })
  @ApiOkResponse({
    description: 'Verification email resent successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        statusCode: { type: 'number', example: 200 },
        message: { type: 'string', example: 'Verification email sent successfully' },
        data: {
          type: 'object',
          properties: {
            message: { type: 'string', example: 'Verification email sent successfully' },
            primaryEmail: { type: 'string', example: 'john.doe@example.com' },
          },
        },
        timestamp: { type: 'string', example: '2024-01-01T00:00:00.000Z' },
        path: { type: 'string', example: '/api/auth/resend-verification' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error or user not found',
    examples: {
      invalidEmail: {
        summary: 'Invalid Email',
        value: {
          success: false,
          statusCode: 400,
          message: 'Validation failed',
          error: 'ValidationError',
          details: ['primaryEmail must be an email'],
          timestamp: '2024-01-01T00:00:00.000Z',
          path: '/api/auth/resend-verification',
          requestId: 'req_1234567890abcdef',
        },
      },
      userNotFound: {
        summary: 'User Not Found',
        value: {
          success: false,
          statusCode: 400,
          message: 'User not found',
          error: 'ValidationError',
          timestamp: '2024-01-01T00:00:00.000Z',
          path: '/api/auth/resend-verification',
          requestId: 'req_1234567890abcdef',
        },
      },
    },
  })
  async resendVerification(@Body() body: { email: string }): Promise<BaseApiResponse<any>> {
    const data = await this.authService.resendVerification(body.email);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Verification email sent successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/auth/resend-verification',
    };
  }

  @Get('verification-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check Email Verification Status',
    description: 'Check if the current user\'s primary email is verified.',
  })
  @ApiResponse({
    status: 200,
    description: 'Verification status retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        statusCode: { type: 'number', example: 200 },
        message: { type: 'string', example: 'Verification status retrieved successfully' },
        data: {
          type: 'object',
          properties: {
            isEmailVerified: { type: 'boolean', example: false },
            primaryEmail: { type: 'string', example: 'john.doe@example.com' },
          },
        },
        timestamp: { type: 'string', example: '2024-01-01T00:00:00.000Z' },
        path: { type: 'string', example: '/api/auth/verification-status' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'User not authenticated',
    examples: {
      unauthorized: {
        summary: 'Unauthorized',
        value: {
          success: false,
          statusCode: 401,
          message: 'Unauthorized',
          error: 'AuthenticationError',
          timestamp: '2024-01-01T00:00:00.000Z',
          path: '/api/auth/verification-status',
          requestId: 'req_1234567890abcdef',
        },
      },
    },
  })
  async getVerificationStatus(@Query('primaryEmail') primaryEmail: string): Promise<BaseApiResponse<any>> {
    const data = await this.authService.getVerificationStatus(primaryEmail);
    return {
      success: true,
      statusCode: HttpStatus.OK,
      message: 'Verification status retrieved successfully',
      data,
      timestamp: new Date().toISOString(),
      path: '/api/auth/verification-status',
    };
  }
}
