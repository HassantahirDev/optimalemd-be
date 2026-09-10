import { 
  Controller, 
  Post, 
  Get, 
  Put, 
  Body, 
  Param, 
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
  Req,
  BadRequestException,
  NotFoundException
} from '@nestjs/common';
import { NewSignupService } from './new-signup.service';
import { StripeService } from '../stripe/stripe.service';
import { 
  CreateWelcomeOrderDto, 
  UpdateSignupStepDto, 
  GenderStepDto,
  BasicInfoStepDto,
  CheckoutStepDto,
  PasswordStepDto,
  DetailsStepDto,
  CreateUserStepByStepDto
} from './dto/new-signup.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CreatePaymentIntentDto } from '../stripe/dto';

@Controller('auth/new-signup')
export class NewSignupController {
  constructor(
    private readonly newSignupService: NewSignupService,
    private readonly stripeService: StripeService,
  ) {}

  // Check if email already exists (public endpoint - no auth required)
  @Get('check-email')
  @HttpCode(HttpStatus.OK)
  async checkEmailExists(@Query('email') email: string) {
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    try {
      const checkResult = await this.newSignupService.checkEmailExists(email);
      
      // Check if user is inactive first
      if (checkResult.exists && checkResult.isActive === false) {
        return {
          success: false,
          statusCode: 403,
          data: {
            email,
            exists: true,
            hasIncompleteSignup: false,
            isActive: false,
          },
          message: 'This account has been deactivated. Please contact support for assistance.',
        };
      }

      let message = 'Email is available';
      if (checkResult.exists && checkResult.hasIncompleteSignup) {
        message = 'An account with this email already exists. You have an incomplete signup - please log in to resume.';
      } else if (checkResult.exists) {
        message = 'An account with this email already exists. Please log in.';
      } else if (checkResult.hasIncompleteSignup) {
        // No user account, but incomplete signup exists (paid but didn't create password)
        // This will be handled by frontend to auto-resume
        message = 'You have an incomplete signup. You will be redirected to continue where you left off.';
      }

      return {
        success: true,
        statusCode: 200,
        data: {
          email,
          exists: checkResult.exists,
          hasIncompleteSignup: checkResult.hasIncompleteSignup,
          welcomeOrderId: checkResult.welcomeOrderId,
          isActive: checkResult.isActive,
        },
        message,
      };
    } catch (error) {
      console.error('Error checking email existence:', error);
      throw new BadRequestException('Unable to check email. Please try again.');
    }
  }

  // Create a new welcome order
  @Post('welcome-order')
  @HttpCode(HttpStatus.CREATED)
  async createWelcomeOrder(@Body() createDto: CreateWelcomeOrderDto) {
    try {
      return await this.newSignupService.createWelcomeOrder(createDto);
    } catch (error) {
      console.error('Error in createWelcomeOrder controller:', error);
      
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      throw new BadRequestException('Unable to create welcome order. Please try again.');
    }
  }

  // Update signup step
  @Put('welcome-order/:welcomeOrderId/step')
  @HttpCode(HttpStatus.OK)
  async updateSignupStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() updateDto: UpdateSignupStepDto
  ) {
    try {
      return await this.newSignupService.updateSignupStep(welcomeOrderId, updateDto);
    } catch (error) {
      console.error('Error in updateSignupStep controller:', error);
      
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      throw new BadRequestException('Unable to update signup step. Please try again.');
    }
  }

  // Get signup progress
  @Get('welcome-order/:welcomeOrderId/progress')
  async getSignupProgress(@Param('welcomeOrderId') welcomeOrderId: string) {
    return this.newSignupService.getSignupProgress(welcomeOrderId);
  }

  // Resume signup by email
  @Get('resume')
  async resumeSignupByEmail(@Query('email') email: string) {
    return this.newSignupService.resumeSignupByEmail(email);
  }

  // Resuming a PAID but abandoned signup, without charging again. Public like
  // the rest of this controller, so ownership is proven by clicking a signed
  // link emailed to that address — the email lookup only decides whether to
  // send one.
  @Post('resume/request-link')
  async requestResumeLink(@Body() body: { email: string }) {
    const data = await this.newSignupService.requestResumeLink(body.email);
    return { success: true, data };
  }

  @Post('resume/verify-token')
  async verifyResumeToken(@Body() body: { token: string }) {
    const data = await this.newSignupService.verifyResumeToken(body.token);
    return { success: true, data };
  }

  // Complete signup and create user
  @Post('welcome-order/:welcomeOrderId/complete')
  @HttpCode(HttpStatus.CREATED)
  async completeSignup(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() userData: any
  ) {
    return this.newSignupService.completeSignup(welcomeOrderId, userData);
  }

  // Get welcome order details
  @Get('welcome-order/:welcomeOrderId')
  async getWelcomeOrder(@Param('welcomeOrderId') welcomeOrderId: string) {
    return this.newSignupService.getWelcomeOrder(welcomeOrderId);
  }

  // Update payment status
  @Put('welcome-order/:welcomeOrderId/payment')
  @HttpCode(HttpStatus.OK)
  async updatePaymentStatus(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() body: { paymentIntentId: string; status: string }
  ) {
    return this.newSignupService.updatePaymentStatus(
      welcomeOrderId, 
      body.paymentIntentId, 
      body.status as any
    );
  }

  // Get welcome order status by user ID
  @Get('welcome-orders/status')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getWelcomeOrderStatus(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found');
    }
    
    const welcomeOrder = await this.newSignupService.getWelcomeOrderStatusByUserId(userId);
    
    return {
      success: true,
      data: welcomeOrder,
      message: welcomeOrder ? 'Welcome order found' : 'No welcome order in progress'
    };
  }

  // Complete welcome order
  @Put('welcome-orders/:welcomeOrderId/complete')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async completeWelcomeOrder(@Param('welcomeOrderId') welcomeOrderId: string) {
    const welcomeOrder = await this.newSignupService.completeWelcomeOrder(welcomeOrderId);
    
    return {
      success: true,
      data: welcomeOrder,
      message: 'Welcome order completed successfully'
    };
  }

  // Update user medical form completion status (separate endpoint to avoid route conflict)
  @Put('update-user-completion/:userId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateUserMedicalFormCompletion(@Param('userId') userId: string) {
    const user = await this.newSignupService.updateUserMedicalFormCompletion(userId);
    
    return {
      success: true,
      data: {
        hasCompletedMedicalForm: user.hasCompletedMedicalForm,
        medicalFormCompletedAt: user.medicalFormCompletedAt,
        hasCompletedIntakeForm: user.hasCompletedIntakeForm,
        intakeFormCompletedAt: user.intakeFormCompletedAt,
      },
      message: 'User medical form completion status updated successfully'
    };
  }

  // Step-specific endpoints for easier frontend integration

  // Step 0 - Gender
  @Put('welcome-order/:welcomeOrderId/step/gender')
  @HttpCode(HttpStatus.OK)
  async updateGenderStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() genderData: GenderStepDto
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 0,
      stepName: 'Gender',
      stepData: genderData,
      isCompleted: true,
      isValid: true,
    });
  }

  // Step 1 - Basic Info
  @Put('welcome-order/:welcomeOrderId/step/basic-info')
  @HttpCode(HttpStatus.OK)
  async updateBasicInfoStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() basicInfoData: BasicInfoStepDto
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 1,
      stepName: 'Basic Info',
      stepData: basicInfoData,
      isCompleted: true,
      isValid: true,
    });
  }

  // Step 2 - Password
  @Put('welcome-order/:welcomeOrderId/step/password')
  @HttpCode(HttpStatus.OK)
  async updatePasswordStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() passwordData: PasswordStepDto
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 2,
      stepName: 'Password',
      stepData: passwordData,
      isCompleted: true,
      isValid: true,
    });
  }

  // Step 3 - Checkout
  @Put('welcome-order/:welcomeOrderId/step/checkout')
  @HttpCode(HttpStatus.OK)
  async updateCheckoutStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() checkoutData: CheckoutStepDto
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 3,
      stepName: 'Checkout',
      stepData: checkoutData,
      isCompleted: true,
      isValid: true,
    });
  }

  // Step 4 - Details (BMI + Medical + Consent)
  @Put('welcome-order/:welcomeOrderId/step/details')
  @HttpCode(HttpStatus.OK)
  async updateDetailsStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() detailsData: DetailsStepDto
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 4,
      stepName: 'Details',
      stepData: detailsData,
      isCompleted: true,
      isValid: true,
    });
  }

  // Sub-step endpoints for internal navigation

  // Step 1 - Basic Info Sub-steps
  @Put('welcome-order/:welcomeOrderId/step/basic-info/basic')
  @HttpCode(HttpStatus.OK)
  async updateBasicInfoBasicSubStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() basicData: { firstName: string; lastName: string; email: string }
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 1,
      stepName: 'Basic Info',
      subStepNumber: 0,
      subStepName: 'basic',
      stepData: basicData,
      isCompleted: false,
      isValid: true,
    });
  }

  @Put('welcome-order/:welcomeOrderId/step/basic-info/state')
  @HttpCode(HttpStatus.OK)
  async updateBasicInfoStateSubStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() stateData: { state: string }
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 1,
      stepName: 'Basic Info',
      subStepNumber: 1,
      subStepName: 'state',
      stepData: stateData,
      isCompleted: true,
      isValid: true,
    });
  }

  // Update User Profile
  @Put('update-user/:userId')
  @HttpCode(HttpStatus.OK)
  async updateUserProfile(
    @Param('userId') userId: string,
    @Body() userData: any
  ) {
    const updatedUser = await this.newSignupService.updateUserProfile(userId, userData);
    
    if (!updatedUser) {
      throw new NotFoundException('User not found');
    }
    
    // Return updated user data in response (exclude password field safely)
    const userResponse: any = { ...updatedUser };
    delete userResponse.password;
    
    return {
      success: true,
      statusCode: 200,
      message: 'User profile updated successfully',
      data: userResponse,
      timestamp: new Date().toISOString(),
      path: `/api/auth/new-signup/update-user/${userId}`,
    };
  }

  // Save BMI data to Medical Form
  @Post('save-bmi-data/:userId')
  @HttpCode(HttpStatus.OK)
  async saveBMIData(
    @Param('userId') userId: string,
    @Body() bmiData: { height: string; weight: string; waist: string; bmi: string }
  ) {
    return this.newSignupService.saveBMIData(userId, bmiData);
  }

  // Save Medical Intake Form data
  @Post('save-medical-intake/:userId')
  @HttpCode(HttpStatus.OK)
  async saveMedicalIntake(
    @Param('userId') userId: string,
    @Body() medicalData: any
  ) {
    return this.newSignupService.saveMedicalIntake(userId, medicalData);
  }

  // Save Consent data and send emails
  @Post('save-consent-and-complete/:userId')
  @HttpCode(HttpStatus.OK)
  async saveConsentAndComplete(
    @Param('userId') userId: string,
    @Body() consentData: any
  ) {
    return this.newSignupService.saveConsentAndComplete(userId, consentData);
  }

  // Step 4 - Details Sub-steps
  @Put('welcome-order/:welcomeOrderId/step/details/basicInfo')
  @HttpCode(HttpStatus.OK)
  async updateDetailsBasicInfoSubStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() basicInfoData: { 
      dateOfBirth: string; 
      completeAddress: string; 
      city: string; 
      zipcode: string; 
      primaryPhone: string; 
      alternativePhone: string; 
    }
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 4,
      stepName: 'Details',
      subStepNumber: 0,
      subStepName: 'basicInfo',
      stepData: basicInfoData,
      isCompleted: false,
      isValid: true,
    });
  }

  @Put('welcome-order/:welcomeOrderId/step/details/bmi')
  @HttpCode(HttpStatus.OK)
  async updateDetailsBMISubStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() bmiData: { height: string; weight: string; waist: string; bmi: string }
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 4,
      stepName: 'Details',
      subStepNumber: 1,
      subStepName: 'bmi',
      stepData: bmiData,
      isCompleted: false,
      isValid: true,
    });
  }

  @Put('welcome-order/:welcomeOrderId/step/details/medical')
  @HttpCode(HttpStatus.OK)
  async updateDetailsMedicalSubStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() medicalData: any
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 4,
      stepName: 'Details',
      subStepNumber: 1,
      subStepName: 'medical',
      stepData: medicalData,
      isCompleted: false,
      isValid: true,
    });
  }

  @Put('welcome-order/:welcomeOrderId/step/details/consent')
  @HttpCode(HttpStatus.OK)
  async updateDetailsConsentSubStep(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() consentData: {
      consentForTreatment: boolean;
      hipaaPrivacyNoticeAcknowledgment: boolean;
      releaseOfMedicalRecordsConsent: boolean;
    }
  ) {
    return this.newSignupService.updateSignupStep(welcomeOrderId, {
      stepNumber: 4,
      stepName: 'Details',
      subStepNumber: 2,
      subStepName: 'consent',
      stepData: consentData,
      isCompleted: true,
      isValid: true,
    });
  }

  // Create user step by step
  @Post('create-user-step-by-step')
  async createUserStepByStep(@Body() userData: CreateUserStepByStepDto) {
    try {
      const result = await this.newSignupService.createUserStepByStep(userData);
      return {
        success: true,
        statusCode: 201,
        message: 'User created successfully',
        data: result,
      };
    } catch (error) {
      console.error('Error in createUserStepByStep controller:', error);
      
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      throw new BadRequestException('Unable to create user account. Please check your information and try again.');
    }
  }

  // Update welcome order with user ID
  @Put('welcome-order/:welcomeOrderId')
  @HttpCode(HttpStatus.OK)
  async updateWelcomeOrder(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() updateData: { userId: string }
  ) {
    return this.newSignupService.updateWelcomeOrder(welcomeOrderId, updateData);
  }

  // Create payment intent for welcome order (public endpoint - no auth required)
  @Post('welcome-order/:welcomeOrderId/payment-intent')
  @HttpCode(HttpStatus.CREATED)
  async createWelcomeOrderPaymentIntent(
    @Param('welcomeOrderId') welcomeOrderId: string,
    @Body() body: { amount: number; currency?: string }
  ) {
    try {
      // Validate welcome order exists and is not already paid
      const welcomeOrder = await this.newSignupService.getWelcomeOrder(welcomeOrderId);

      if (welcomeOrder.paymentStatus === 'SUCCEEDED') {
        throw new BadRequestException('Welcome order is already paid');
      }

      // Create payment intent using StripeService
      const result = await this.stripeService.createPaymentIntent({
        welcomeOrderId,
        amount: body.amount || welcomeOrder.finalAmount.toNumber(),
        currency: body.currency || 'usd',
      });

      return {
        success: true,
        statusCode: 201,
        message: 'Payment intent created successfully',
        data: result,
      };
    } catch (error) {
      console.error('Error creating welcome order payment intent:', error);
      
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      
      throw new BadRequestException('Failed to create payment intent. Please try again.');
    }
  }
}