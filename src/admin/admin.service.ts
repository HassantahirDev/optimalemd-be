import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { AdminCreatePatientDto, AdminUpdatePatientDto, AdminCreateMedicalFormDto, PatientWithMedicalFormResponseDto } from './dto/admin.dto';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { generateNextPatientId } from '../common/utils/patient-id.utils';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService
  ) {}

  /**
   * Normalize phone number: ensure it has country code prefix (+1)
   * Removes spaces, dashes, parentheses but preserves +1 if already present
   * Example: 25428558482 -> +125428558482, +125428558482 -> +125428558482 (unchanged)
   */
  private normalizePhoneNumber(phone: string | undefined): string | undefined {
    if (!phone || phone.trim() === '') return undefined;
    
    // Remove all spaces, dashes, parentheses, but keep the + sign
    let cleaned = phone.replace(/[\s\-\(\)]/g, '');
    
    // If it already starts with +1, preserve it as-is (just clean any extra formatting)
    if (cleaned.startsWith('+1')) {
      // Extract only digits after +1
      const digits = cleaned.substring(2).replace(/\D/g, '');
      // Return +1 followed by the digits (preserve the format)
      return '+1' + digits;
    }
    
    // If it starts with + but not +1, extract digits and add +1
    if (cleaned.startsWith('+')) {
      const digits = cleaned.substring(1).replace(/\D/g, '');
      // Take last 10 digits if more than 10, otherwise use all
      const finalDigits = digits.length > 10 ? digits.slice(-10) : digits;
      return '+1' + finalDigits;
    }
    
    // If it doesn't start with +, extract all digits
    const digits = cleaned.replace(/\D/g, '');
    
    // If it's 10 digits, add +1 prefix
    if (digits.length === 10) {
      return '+1' + digits;
    }
    
    // If it's 11 digits starting with 1, add + prefix (becomes +1XXXXXXXXXX)
    if (digits.length === 11 && digits.startsWith('1')) {
      return '+' + digits;
    }
    
    // For any other case, take last 10 digits and add +1
    if (digits.length > 10) {
      return '+1' + digits.slice(-10);
    }
    
    // If less than 10 digits, add +1 prefix anyway
    return '+1' + digits;
  }

  /**
   * Create a new patient from admin side with auto-generated password and email
   */
  async createPatient(createPatientDto: AdminCreatePatientDto): Promise<PatientWithMedicalFormResponseDto> {
    const { sendWelcomeEmail = true, makePremiumMember = false, ...patientData } = createPatientDto;

    // Normalize emails to lowercase for case-insensitive matching
    const normalizedPrimaryEmail = patientData.primaryEmail.toLowerCase();
    const normalizedAlternativeEmail = patientData.alternativeEmail?.toLowerCase();

    // Normalize phone number before checking for duplicates
    const normalizedPrimaryPhone = this.normalizePhoneNumber(patientData.primaryPhone);

    // Check if user already exists by primary email
    const existingUserByEmail = await this.prisma.user.findUnique({
      where: { primaryEmail: normalizedPrimaryEmail },
    });

    if (existingUserByEmail) {
      throw new ConflictException('User with this primary email already exists');
    }

    // Check if user already exists by primary phone number
    if (normalizedPrimaryPhone) {
      const existingUserByPhone = await this.prisma.user.findFirst({
        where: { 
          primaryPhone: normalizedPrimaryPhone,
        },
      });

      if (existingUserByPhone) {
        throw new ConflictException('User with this primary phone number already exists');
      }
    }

    // Generate a secure random password
    const generatedPassword = this.generateSecurePassword();
    const hashedPassword = await bcrypt.hash(generatedPassword, 12);

    // Generate email verification token
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Generate patient ID
    const patientId = await generateNextPatientId(this.prisma);
    const normalizedAlternativePhone = patientData.alternativePhone 
      ? this.normalizePhoneNumber(patientData.alternativePhone) 
      : undefined;
    const normalizedEmergencyContactPhone = patientData.emergencyContactPhone 
      ? this.normalizePhoneNumber(patientData.emergencyContactPhone) 
      : undefined;

    // Prepare user data for creation
    const userCreateData: any = {
      ...patientData,
      primaryEmail: normalizedPrimaryEmail,
      alternativeEmail: normalizedAlternativeEmail,
      primaryPhone: normalizedPrimaryPhone,
      alternativePhone: normalizedAlternativePhone,
      emergencyContactPhone: normalizedEmergencyContactPhone,
      password: hashedPassword,
      patientId, // Assign sequential patient ID
      dateOfBirth: new Date(patientData.dateOfBirth),
      dateOfFirstVisitPlanned: patientData.dateOfFirstVisitPlanned && patientData.dateOfFirstVisitPlanned.trim() !== '' 
        ? new Date(patientData.dateOfFirstVisitPlanned) 
        : null,
      emailVerificationToken,
      emailVerificationTokenExpiry,
      // Map legacy fields for backward compatibility
      email: normalizedPrimaryEmail,
      phone: normalizedPrimaryPhone,
      isActive: true,
      isEmailVerified: false, // Admin created patients need to verify their email
      mustChangePassword: true, // Force password change on first login
      // Set premium membership if requested
      isSubscribed: makePremiumMember,
      subscriptionStatus: makePremiumMember ? 'active' : null,
      subscriptionStartDate: makePremiumMember ? new Date() : null,
    };

    // Create user
    const user = await this.prisma.user.create({
      data: userCreateData,
    });

    // Send welcome email with credentials if requested
    if (sendWelcomeEmail) {
      try {
        const verificationLink = `https://formamd.com/verify-email?token=${emailVerificationToken}`;
        
        await this.mailerService.sendAdminCreatedPatientEmail(
          normalizedPrimaryEmail,
          patientData.firstName,
          generatedPassword,
          verificationLink
        );
      } catch (error) {
        console.error('Failed to send welcome email:', error);
        // Don't fail patient creation if email fails, but log it
      }
    }

    return this.mapToResponseDto(user);
  }

  /**
   * Update patient data (excluding medical form data)
   */
  async updatePatient(patientId: string, updatePatientDto: AdminUpdatePatientDto): Promise<PatientWithMedicalFormResponseDto> {
    // Check if patient exists
    const existingPatient = await this.prisma.user.findUnique({
      where: { id: patientId },
    });

    if (!existingPatient) {
      throw new NotFoundException('Patient not found');
    }

    // Normalize emails to lowercase if they're being updated
    if (updatePatientDto.primaryEmail) {
      updatePatientDto.primaryEmail = updatePatientDto.primaryEmail.toLowerCase();
    }
    if (updatePatientDto.alternativeEmail) {
      updatePatientDto.alternativeEmail = updatePatientDto.alternativeEmail.toLowerCase();
    }

    // If email is being updated, check for conflicts
    if (updatePatientDto.primaryEmail && updatePatientDto.primaryEmail !== existingPatient.primaryEmail) {
      const existingUserWithEmail = await this.prisma.user.findUnique({
        where: { primaryEmail: updatePatientDto.primaryEmail },
      });

      if (existingUserWithEmail) {
        throw new ConflictException('Another user with this primary email already exists');
      }
    }

    // If phone is being updated, normalize and check for conflicts
    let normalizedPrimaryPhone: string | undefined;
    if (updatePatientDto.primaryPhone) {
      normalizedPrimaryPhone = this.normalizePhoneNumber(updatePatientDto.primaryPhone);
      
      // Check if another user already has this phone number
      if (normalizedPrimaryPhone && normalizedPrimaryPhone !== existingPatient.primaryPhone) {
        const existingUserWithPhone = await this.prisma.user.findFirst({
          where: { 
            primaryPhone: normalizedPrimaryPhone,
          },
        });

        if (existingUserWithPhone) {
          throw new ConflictException('Another user with this primary phone number already exists');
        }
      }
    }

    // Prepare update data
    const updateData: any = { ...updatePatientDto };
    
    if (updatePatientDto.dateOfBirth) {
      updateData.dateOfBirth = new Date(updatePatientDto.dateOfBirth);
    }
    
    if (updatePatientDto.dateOfFirstVisitPlanned && updatePatientDto.dateOfFirstVisitPlanned.trim() !== '') {
      updateData.dateOfFirstVisitPlanned = new Date(updatePatientDto.dateOfFirstVisitPlanned);
    } else if (updatePatientDto.dateOfFirstVisitPlanned === '') {
      updateData.dateOfFirstVisitPlanned = null;
    }

    // Normalize phone numbers if they're being updated (already normalized above for duplicate check)
    if (updatePatientDto.primaryPhone && normalizedPrimaryPhone) {
      updateData.primaryPhone = normalizedPrimaryPhone;
      updateData.phone = normalizedPrimaryPhone; // Also update legacy field
    }
    if (updatePatientDto.alternativePhone) {
      updateData.alternativePhone = this.normalizePhoneNumber(updatePatientDto.alternativePhone);
    }
    if (updatePatientDto.emergencyContactPhone) {
      updateData.emergencyContactPhone = this.normalizePhoneNumber(updatePatientDto.emergencyContactPhone);
    }

    // Update legacy fields if primary email is updated
    if (updatePatientDto.primaryEmail) {
      updateData.email = updatePatientDto.primaryEmail;
    }

    // Update user
    const updatedUser = await this.prisma.user.update({
      where: { id: patientId },
      data: updateData,
    });

    return this.mapToResponseDto(updatedUser);
  }

  /**
   * Create medical form for a patient
   */
  async createMedicalForm(patientId: string, createMedicalFormDto: AdminCreateMedicalFormDto): Promise<any> {
    // Check if patient exists
    const patient = await this.prisma.user.findUnique({
      where: { id: patientId }
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    // Check if medical form already exists for this patient
    const existingForm = await this.prisma.medicalForm.findFirst({
      where: { patientId }
    });

    if (existingForm) {
      throw new ConflictException('Medical form already exists for this patient. Use update instead.');
    }

    // Prepare medical form data
    const medicalFormData: any = {
      patientId,
      ...createMedicalFormDto,
      // Set labSchedulingNeeded to true by default if not provided
      labSchedulingNeeded: createMedicalFormDto.labSchedulingNeeded !== undefined ? createMedicalFormDto.labSchedulingNeeded : true,
    };

    // Convert date string to Date object if provided
    if (createMedicalFormDto.consentDate) {
      medicalFormData.consentDate = new Date(createMedicalFormDto.consentDate);
    }

    // Create medical form
    const medicalForm = await this.prisma.medicalForm.create({
      data: medicalFormData
    });

    // Update user's form completion status
    await this.prisma.user.update({
      where: { id: patientId },
      data: {
        hasCompletedMedicalForm: true,
        medicalFormCompletedAt: new Date()
      }
    });

    return medicalForm;
  }

  /**
   * Update medical form for a patient
   */
  async updateMedicalForm(patientId: string, updateMedicalFormDto: Partial<AdminCreateMedicalFormDto>): Promise<any> {
    // Check if patient exists
    const patient = await this.prisma.user.findUnique({
      where: { id: patientId }
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    // Check if medical form exists
    const existingForm = await this.prisma.medicalForm.findFirst({
      where: { patientId }
    });

    if (!existingForm) {
      throw new NotFoundException('Medical form not found for this patient');
    }

    // Prepare update data
    const updateData: any = { 
      ...updateMedicalFormDto,
      // Set labSchedulingNeeded to true by default if not provided
      labSchedulingNeeded: updateMedicalFormDto.labSchedulingNeeded !== undefined ? updateMedicalFormDto.labSchedulingNeeded : true,
    };

    // Convert date string to Date object if provided
    if (updateMedicalFormDto.consentDate) {
      updateData.consentDate = new Date(updateMedicalFormDto.consentDate);
    }

    // Update medical form
    const updatedMedicalForm = await this.prisma.medicalForm.update({
      where: { id: existingForm.id },
      data: updateData
    });

    return updatedMedicalForm;
  }

  /**
   * Get patient with medical form data
   */
  async getPatientWithMedicalForm(patientId: string): Promise<PatientWithMedicalFormResponseDto> {
    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      include: {
        medicalForms: {
          take: 1,
          orderBy: { createdAt: 'desc' }
        },
        welcomeOrders: {
          where: {
            paymentStatus: 'SUCCEEDED'
          },
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            paymentIntentId: true
          }
        }
      }
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    const responseDto = this.mapToResponseDto(patient);
    
    // Add medical form data if exists
    if (patient.medicalForms && patient.medicalForms.length > 0) {
      responseDto.medicalForm = patient.medicalForms[0];
    }

    // Add welcome order payment intent ID if exists
    if (patient.welcomeOrders && patient.welcomeOrders.length > 0) {
      responseDto.welcomeOrderPaymentIntentId = patient.welcomeOrders[0].paymentIntentId;
    }

    return responseDto;
  }

  /**
   * Get DOB search conditions for different date formats
   */
  private getDobSearchConditions(searchTerm: string): any[] {
    const conditions: any[] = [];
    
    // Try to parse different date formats
    const dateFormats = [
      // MM-DD-YYYY or MM/DD/YYYY
      /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/,
      // YYYY-MM-DD
      /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
      // MMDDYYYY
      /^(\d{2})(\d{2})(\d{4})$/,
      // MMDDYY
      /^(\d{2})(\d{2})(\d{2})$/
    ];

    for (const format of dateFormats) {
      const match = searchTerm.match(format);
      if (match) {
        let month: number, day: number, year: number;
        
        if (format.source.includes('YYYY')) {
          // MM-DD-YYYY or YYYY-MM-DD format
          if (format.source.startsWith('^\\d{4}')) {
            // YYYY-MM-DD
            year = parseInt(match[1]);
            month = parseInt(match[2]);
            day = parseInt(match[3]);
          } else {
            // MM-DD-YYYY
            month = parseInt(match[1]);
            day = parseInt(match[2]);
            year = parseInt(match[3]);
          }
        } else if (format.source.includes('YY')) {
          // MMDDYY format
          month = parseInt(match[1]);
          day = parseInt(match[2]);
          const twoDigitYear = parseInt(match[3]);
          // Assume years 00-30 are 2000-2030, 31-99 are 1931-1999
          year = twoDigitYear <= 30 ? 2000 + twoDigitYear : 1900 + twoDigitYear;
        } else {
          // MMDDYYYY format
          month = parseInt(match[1]);
          day = parseInt(match[2]);
          year = parseInt(match[3]);
        }

        // Validate the date
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
          try {
            const searchDate = new Date(year, month - 1, day);
            if (searchDate.getFullYear() === year && searchDate.getMonth() === month - 1 && searchDate.getDate() === day) {
              // Create date range for the day (start and end of day)
              const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
              const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
              
              conditions.push({
                dateOfBirth: {
                  gte: startOfDay,
                  lte: endOfDay
                }
              });
            }
          } catch (error) {
            // Invalid date, skip
          }
        }
        break; // Only try the first matching format
      }
    }

    // Also try searching for partial dates (just year, or month-year)
    const yearMatch = searchTerm.match(/^(\d{4})$/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1]);
      if (year >= 1900 && year <= 2100) {
        const startOfYear = new Date(year, 0, 1);
        const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);
        conditions.push({
          dateOfBirth: {
            gte: startOfYear,
            lte: endOfYear
          }
        });
      }
    }

    return conditions;
  }

  /**
   * Get all patients with pagination and search
   */
  async getAllPatients(query: any): Promise<{
    data: PatientWithMedicalFormResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 50,
      search,
      status,
    } = query;

    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {};

    if (search) {
      const searchTerms = search.trim().split(/\s+/).filter(term => term.length > 0);
      
      if (searchTerms.length === 1) {
        // Single term search - search in all fields including DOB
        const searchConditions = [
          { firstName: { contains: search, mode: 'insensitive' } },
          { middleName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { primaryEmail: { contains: search, mode: 'insensitive' } },
          { primaryPhone: { contains: search, mode: 'insensitive' } },
        ];

        // Add DOB search - try different date formats
        const dobSearchConditions = this.getDobSearchConditions(search);
        searchConditions.push(...dobSearchConditions);

        where.OR = searchConditions;
      } else {
        // Multiple terms search - search for name combinations across firstName, middleName, lastName
        const searchConditions: any[] = [];
        
        // Search for combinations across all name fields
        if (searchTerms.length === 2) {
          // Two terms: try different combinations
          searchConditions.push({
            AND: [
              { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
              { lastName: { contains: searchTerms[1], mode: 'insensitive' } }
            ]
          });
          searchConditions.push({
            AND: [
              { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
              { middleName: { contains: searchTerms[1], mode: 'insensitive' } }
            ]
          });
          searchConditions.push({
            AND: [
              { middleName: { contains: searchTerms[0], mode: 'insensitive' } },
              { lastName: { contains: searchTerms[1], mode: 'insensitive' } }
            ]
          });
        } else if (searchTerms.length === 3) {
          // Three terms: try different combinations
          searchConditions.push({
            AND: [
              { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
              { middleName: { contains: searchTerms[1], mode: 'insensitive' } },
              { lastName: { contains: searchTerms[2], mode: 'insensitive' } }
            ]
          });
          searchConditions.push({
            AND: [
              { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
              { lastName: { contains: searchTerms[2], mode: 'insensitive' } }
            ]
          });
        } else if (searchTerms.length > 3) {
          // More than 3 terms: try first + last, and first + middle + last
          searchConditions.push({
            AND: [
              { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
              { lastName: { contains: searchTerms[searchTerms.length - 1], mode: 'insensitive' } }
            ]
          });
          if (searchTerms.length >= 3) {
            searchConditions.push({
              AND: [
                { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
                { middleName: { contains: searchTerms[1], mode: 'insensitive' } },
                { lastName: { contains: searchTerms[searchTerms.length - 1], mode: 'insensitive' } }
              ]
            });
          }
        }
        
        // Also include individual field searches for each term
        searchTerms.forEach(term => {
          searchConditions.push(
            { firstName: { contains: term, mode: 'insensitive' } },
            { middleName: { contains: term, mode: 'insensitive' } },
            { lastName: { contains: term, mode: 'insensitive' } },
            { primaryEmail: { contains: term, mode: 'insensitive' } },
            { primaryPhone: { contains: term, mode: 'insensitive' } }
          );
          
          // Add DOB search for each term
          const dobSearchConditions = this.getDobSearchConditions(term);
          searchConditions.push(...dobSearchConditions);
        });
        
        where.OR = searchConditions;
      }
    }

    if (status === 'active') {
      where.isActive = true;
    } else if (status === 'inactive') {
      where.isActive = false;
    }

    const [patients, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          medicalForms: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          },
          welcomeOrders: {
            where: {
              paymentStatus: 'SUCCEEDED'
            },
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: {
              paymentIntentId: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where })
    ]);

    const data = patients.map(patient => {
      const responseDto = this.mapToResponseDto(patient);
      
      // Add medical form data if exists
      if (patient.medicalForms && patient.medicalForms.length > 0) {
        responseDto.medicalForm = patient.medicalForms[0];
      }

      // Add welcome order payment intent ID if exists
      if (patient.welcomeOrders && patient.welcomeOrders.length > 0) {
        responseDto.welcomeOrderPaymentIntentId = patient.welcomeOrders[0].paymentIntentId;
      }

      return responseDto;
    });

    return {
      data,
      total,
      page: parseInt(page),
      limit: parseInt(limit)
    };
  }

  /**
   * Toggle premium/subscription status for a patient
   */
  async togglePremiumStatus(patientId: string, isPremium: boolean): Promise<PatientWithMedicalFormResponseDto> {
    // Check if patient exists
    const existingPatient = await this.prisma.user.findUnique({
      where: { id: patientId },
    });

    if (!existingPatient) {
      throw new NotFoundException('Patient not found');
    }

    // Update subscription status. stripeSubscriptionId is ALWAYS cleared here (even when
    // granting) — an admin grant is a manual override, never Stripe-backed. Leaving a stale
    // subscription id in place (e.g. from a past real subscription that has since lapsed)
    // makes getSubscriptionStatus() treat this as "a real subscription that needs
    // reconciling", and it silently reverts the grant back to unsubscribed the next time the
    // patient's dashboard checks status. stripeCustomerId is kept — harmless, and needed if
    // the patient later subscribes for real.
    const updatedPatient = await this.prisma.user.update({
      where: { id: patientId },
      data: {
        isSubscribed: isPremium,
        subscriptionStatus: isPremium ? 'active' : null,
        subscriptionStartDate: isPremium ? new Date() : null,
        subscriptionEndDate: null,
        subscriptionCanceledAt: null,
        stripeSubscriptionId: null,
        stripeCustomerId: isPremium ? existingPatient.stripeCustomerId : null,
      },
    });

    return this.mapToResponseDto(updatedPatient);
  }

  /**
   * Delete patient (hard delete - permanently removes from database)
   */
  async deletePatient(patientId: string): Promise<void> {
    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    // Get patient email before deletion (for deleting welcome orders)
    const patientEmail = patient.primaryEmail || patient.email;

    // Delete welcome orders by email (in case they exist before user was created)
    // This handles cases where welcome orders exist with email but no userId yet
    if (patientEmail) {
      await this.prisma.welcomeOrder.deleteMany({
        where: {
          email: patientEmail
        }
      });
    }

    // Hard delete - permanently remove patient and all related data
    // Note: This will cascade delete related records based on Prisma schema relationships
    // WelcomeOrders with userId will be cascade deleted automatically via the relation
    // SignupSteps will also be cascade deleted
    await this.prisma.user.delete({
      where: { id: patientId }
    });
  }

  /**
   * Resend email verification to an admin-managed patient
   */
  async resendPatientVerification(patientId: string): Promise<{ message: string }> {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException('Patient not found');

    if (patient.isEmailVerified) {
      throw new BadRequestException('Patient email is already verified');
    }

    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.prisma.user.update({
      where: { id: patientId },
      data: { emailVerificationToken, emailVerificationTokenExpiry },
    });

    const email = patient.primaryEmail ?? patient.email;
    if (!email) throw new BadRequestException('Patient has no email address');

    const verificationLink = `https://formamd.com/verify-email?token=${emailVerificationToken}`;
    await this.mailerService.sendEmailVerificationEmail(email, patient.firstName || 'Patient', verificationLink);

    return { message: 'Verification email sent successfully' };
  }

  /**
   * Reset temporary credentials for an admin-managed patient
   * Generates a new password + verification token and sends the full welcome email
   */
  async resetPatientCredentials(patientId: string): Promise<{ message: string }> {
    const patient = await this.prisma.user.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException('Patient not found');

    const newPassword = this.generateSecurePassword();
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.prisma.user.update({
      where: { id: patientId },
      data: {
        password: hashedPassword,
        mustChangePassword: true,
        emailVerificationToken,
        emailVerificationTokenExpiry,
        // If already verified, keep verified — just reset password
        ...(patient.isEmailVerified ? {} : { isEmailVerified: false }),
      },
    });

    const email = patient.primaryEmail ?? patient.email;
    if (!email) throw new BadRequestException('Patient has no email address');

    const verificationLink = `https://formamd.com/verify-email?token=${emailVerificationToken}`;

    // Reuse the full admin-created email which includes credentials + verify & login CTA
    await this.mailerService.sendAdminCreatedPatientEmail(
      email,
      patient.firstName || 'Patient',
      newPassword,
      verificationLink,
    );

    return { message: 'New credentials sent successfully' };
  }

  /**
   * Generate a secure random password
   */
  private generateSecurePassword(): string {
    const length = 12;
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    
    // Ensure at least one of each type
    password += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]; // uppercase
    password += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]; // lowercase
    password += '0123456789'[Math.floor(Math.random() * 10)]; // number
    password += '!@#$%^&*'[Math.floor(Math.random() * 8)]; // special char
    
    // Fill the rest randomly
    for (let i = password.length; i < length; i++) {
      password += charset[Math.floor(Math.random() * charset.length)];
    }
    
    // Shuffle the password
    return password.split('').sort(() => Math.random() - 0.5).join('');
  }

  /**
   * Map user entity to response DTO
   */
  private mapToResponseDto(user: any): PatientWithMedicalFormResponseDto {
    return {
      id: user.id,
      patientId: user.patientId || null,
      title: user.title,
      firstName: user.firstName,
      middleName: user.middleName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      completeAddress: user.completeAddress,
      city: user.city,
      state: user.state,
      zipcode: user.zipcode,
      primaryEmail: user.primaryEmail,
      alternativeEmail: user.alternativeEmail,
      primaryPhone: user.primaryPhone,
      alternativePhone: user.alternativePhone,
      emergencyContactName: user.emergencyContactName,
      emergencyContactRelationship: user.emergencyContactRelationship,
      emergencyContactPhone: user.emergencyContactPhone,
      isActive: user.isActive,
      isEmailVerified: user.isEmailVerified,
      isSubscribed: user.isSubscribed,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionStartDate: user.subscriptionStartDate,
      drivingLicensePath: user.drivingLicensePath,
      photoPath: user.photoPath,
      welcomeOrderPaymentIntentId: (user as any).welcomeOrderPaymentIntentId || null,
      doseSpotPatientId: user.doseSpotPatientId || null,
      createdAt: user.createdAt,
    };
  }

  async getDashboardStats() {
    const [
      totalPatients,
      totalDoctors,
      totalAppointments,
      pendingRequests,
      todayAppointments,
      completedAppointments,
      cancelledAppointments,
      activePremiumMembers,
      activeSignedUpMembers,
      activeMembersOnMedications,
    ] = await Promise.all([
      // Total patients
      this.prisma.user.count({ where: { isActive: true } }),
      // Total doctors
      this.prisma.doctor.count({ where: { isActive: true } }),
      // Total appointments
      this.prisma.appointment.count(),
      // Pending requests (appointments without a doctor assigned)
      this.prisma.appointment.count({ where: { doctorId: null, status: 'PENDING' } }),
      // Today's appointments
      this.prisma.appointment.count({
        where: {
          appointmentDate: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
            lt: new Date(new Date().setHours(23, 59, 59, 999)),
          },
        },
      }),
      // Completed appointments
      this.prisma.appointment.count({ where: { status: 'COMPLETED' } }),
      // Cancelled appointments
      this.prisma.appointment.count({ where: { status: 'CANCELLED' } }),
      // Active premium members (subscriptionStatus = 'active' at user level)
      this.prisma.user.count({
        where: { isActive: true, subscriptionStatus: 'active' },
      }),
      // Active signed-up members (completed a welcome order / paid during sign up)
      this.prisma.user.count({
        where: {
          isActive: true,
          welcomeOrders: { some: { paymentStatus: 'SUCCEEDED' } },
        },
      }),
      // Active members on medications (distinct patients with at least one prescription)
      this.prisma.appointment.findMany({
        where: { medicationPrescriptions: { some: {} } },
        distinct: ['patientId'],
        select: { patientId: true },
      }).then(rows => rows.length),
    ]);

    return {
      totalPatients,
      totalDoctors,
      totalAppointments,
      pendingRequests,
      todayAppointments,
      completedAppointments,
      cancelledAppointments,
      activeSubscribedPatients: activePremiumMembers, // keep old key for backward compat
      activePremiumMembers,
      activeSignedUpMembers,
      activeMembersOnMedications,
    };
  }
}
