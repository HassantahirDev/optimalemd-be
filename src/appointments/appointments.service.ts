import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mailer/mailer.service';
import { GoogleCalendarService } from '../google-calendar/google-calendar.service';
import {
  CreateAppointmentDto,
  UpdateAppointmentDto,
  QueryAppointmentsDto,
  CancelAppointmentDto,
  RescheduleAppointmentDto,
  AppointmentResponseDto,
  AppointmentWithRelationsResponseDto,
} from './dto';
import { AppointmentStatus } from '@prisma/client';
import { dateStringToUTC, isDateTimeInPast, getUTCMidnight, getUTCEndOfDay } from '../common/utils/timezone.utils';

@Injectable()
export class AppointmentsService {
  private stripe: Stripe;

  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService,
    private googleCalendarService: GoogleCalendarService,
    private configService: ConfigService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, { apiVersion: '2025-10-29.clover' as any });
    }
  }

  /**
   * Create a temporary appointment for payment processing
   */
    async createTemporaryAppointment(createAppointmentDto: CreateAppointmentDto): Promise<AppointmentResponseDto> {
    const { patientId, doctorId, serviceId, slotId, appointmentDate, appointmentTime, duration, patientNotes, symptoms, amount, primaryServiceId, selectedSlotTime, patientTimezone, additionalServiceIds } = createAppointmentDto;

    // Check if patient exists and is active
    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: { id: true, isActive: true, drivingLicensePath: true, photoPath: true }
    });
    if (!patient) {
      throw new NotFoundException('Patient not found');
    }
    if (!patient.isActive) {
      throw new BadRequestException('Patient account is not active');
    }
    if (!patient.drivingLicensePath || !patient.photoPath) {
      throw new BadRequestException('Please upload your driving license and photo before booking appointments. You can upload them from the dashboard.');
    }
    // Note: We don't check hasCompletedMedicalForm here because the patient only needs to complete Screen 2
    // before booking. The full medical form is completed AFTER booking the first appointment.

    // Check if doctor exists and is active (only if doctorId is provided)
    if (doctorId) {
      const doctor = await this.prisma.doctor.findUnique({
        where: { id: doctorId },
        select: { id: true, isActive: true, isAvailable: true }
      });
      if (!doctor) {
        throw new NotFoundException('Doctor not found');
      }
      if (!doctor.isActive || !doctor.isAvailable) {
        throw new BadRequestException('Doctor is not available');
      }
    }

    // Check if service exists and is active
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true, isActive: true, duration: true, name: true }
    });
    if (!service) {
      throw new NotFoundException('Service not found');
    }
    if (!service.isActive) {
      throw new BadRequestException('Service is not active');
    }

    const uniqueAdditionalServiceIds = Array.from(new Set((additionalServiceIds || []).filter(id => id && id !== serviceId)));

    let additionalServicesData: Array<{ id: string; name: string; duration: number }> = [];
    let additionalServicesDuration = 0;

    if (uniqueAdditionalServiceIds.length > 0) {
      const additionalServices = await this.prisma.service.findMany({
        where: { id: { in: uniqueAdditionalServiceIds } },
        select: { id: true, name: true, duration: true, isActive: true }
      });

      if (additionalServices.length !== uniqueAdditionalServiceIds.length) {
        throw new BadRequestException('One or more additional services are invalid');
      }

      for (const additional of additionalServices) {
        if (!additional.isActive) {
          throw new BadRequestException(`Service "${additional.name}" is not active`);
        }
        additionalServicesDuration += additional.duration;
        additionalServicesData.push({
          id: additional.id,
          name: additional.name,
          duration: additional.duration,
        });
      }
    }

    const computedDuration = service.duration + additionalServicesDuration;
    const appointmentDuration = additionalServicesData.length > 0
      ? computedDuration
      : (typeof duration === 'number' ? duration : service.duration);

    // Check if slot exists and is available (only if slotId is provided)
    let slot: any = null;
    if (slotId) {
      slot = await this.prisma.slot.findUnique({
        where: { id: slotId },
        include: { schedule: true }
      });
      if (!slot) {
        throw new NotFoundException('Slot not found');
      }
      if (!slot.isAvailable) {
        throw new BadRequestException('Slot is not available');
      }

      // Check if slot duration is sufficient for service
      const slotStart = new Date(`2000-01-01T${slot.startTime}`);
      const slotEnd = new Date(`2000-01-01T${slot.endTime}`);
      const slotDuration = (slotEnd.getTime() - slotStart.getTime()) / (1000 * 60);
      if (slotDuration < appointmentDuration) {
        throw new BadRequestException('Slot duration is insufficient for the selected services');
      }
    }

    // Check if appointment date is not in the past
    if (isDateTimeInPast(appointmentDate, appointmentTime)) {
      throw new BadRequestException('Appointment date and time cannot be in the past');
    }

    // Check for double booking (doctor) - only if doctorId is provided
    if (doctorId) {
      const existingDoctorAppointment = await this.prisma.appointment.findFirst({
        where: {
          doctorId,
          appointmentDate: dateStringToUTC(appointmentDate),
          appointmentTime,
          status: {
            in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS]
          }
        }
      });
      if (existingDoctorAppointment) {
        throw new ConflictException('Doctor already has an appointment at this time');
      }
    }

    // Create temporary appointment with PENDING status and mark slot as unavailable atomically
    const appointment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.appointment.create({
        data: {
          patientId,
          doctorId,
          serviceId,
          slotId,
          primaryServiceId,
          appointmentDate: dateStringToUTC(appointmentDate),
          appointmentTime,
          selectedSlotTime,
          duration: appointmentDuration,
          patientNotes,
          symptoms,
          amount,
          status: AppointmentStatus.PENDING,
          isPaid: false,
          additionalServices: additionalServicesData.length > 0 ? additionalServicesData : undefined,
        },
        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              primaryEmail: true,
            },
          },
          doctor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              specialization: true,
            },
          },
          service: {
            select: {
              id: true,
              name: true,
              description: true,
              duration: true,
            },
          },
          slot: {
            select: {
              id: true,
              startTime: true,
              endTime: true,
            },
          },
        },
      });

      // Mark slot as unavailable so no other patient can book it
      if (slotId) {
        await tx.slot.update({
          where: { id: slotId },
          data: { isAvailable: false },
        });
      }

      return created;
    });

    return appointment;
  }

  /**
   * Create a new appointment
   */
  async createAppointment(createAppointmentDto: CreateAppointmentDto): Promise<AppointmentResponseDto> {
    const { patientId, doctorId, serviceId, slotId, appointmentDate, appointmentTime, duration, patientNotes, symptoms, amount, primaryServiceId, patientTimezone } = createAppointmentDto;

    // Check if patient exists and is active
    const patient = await this.prisma.user.findUnique({
      where: { id: patientId },
      select: { id: true, isActive: true, hasCompletedMedicalForm: true, drivingLicensePath: true, photoPath: true }
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    // Check if patient has uploaded identity documents (driving license and photo)
    if (!patient.drivingLicensePath || !patient.photoPath) {
      const missingDocs: string[] = [];
      if (!patient.drivingLicensePath) missingDocs.push('driving license');
      if (!patient.photoPath) missingDocs.push('profile photo');
      throw new BadRequestException(
        `You must upload your ${missingDocs.join(' and ')} before booking an appointment. Please upload them from your profile settings.`
      );
    }

    // Check if patient has a confirmed lab order with results received
    const labOrders = await this.prisma.labOrder.findMany({
      where: {
        patientId: patientId,
        status: {
          in: ['confirmed', 'completed']
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (labOrders.length === 0) {
      throw new BadRequestException(
        'You must have a confirmed lab order before booking an appointment. Please ensure your lab order has been confirmed by the admin.'
      );
    }

    // Check if at least one lab order has results
    const orderWithResults = labOrders.find(order => 
      order.resultsPath !== null && order.resultsPath !== undefined
    );

    if (!orderWithResults) {
      throw new BadRequestException(
        'You must have received lab results before booking an appointment. Please ensure your lab results have been uploaded by the admin.'
      );
    }

    // Check if the last lab with results is older than 3 months
    // Sort orders by scheduled date (most recent first) and find the one with results
    const ordersWithResults = labOrders
      .filter(order => order.resultsPath !== null && order.resultsPath !== undefined)
      .sort((a, b) => new Date(b.scheduledDate).getTime() - new Date(a.scheduledDate).getTime());
    
    if (ordersWithResults.length > 0) {
      const lastLabWithResults = ordersWithResults[0];
      const lastLabDate = new Date(lastLabWithResults.scheduledDate);
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      
      if (lastLabDate < threeMonthsAgo) {
        throw new BadRequestException(
          `Your last lab was completed more than 3 months ago (${lastLabDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}). Please order a fresh lab before booking an appointment.`
        );
      }
    }

    if (!patient.isActive) {
      throw new BadRequestException('Patient account is not active');
    }
    if (!patient.hasCompletedMedicalForm) {
      throw new BadRequestException('Patient must complete the medical consultation form before booking appointments. Please complete the form and try again.');
    }

    // Check if doctor exists and is active
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, isActive: true, isAvailable: true }
    });
    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }
    if (!doctor.isActive || !doctor.isAvailable) {
      throw new BadRequestException('Doctor is not available');
    }

    // Check if service exists and is active
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { id: true, isActive: true, duration: true }
    });
    if (!service) {
      throw new NotFoundException('Service not found');
    }
    if (!service.isActive) {
      throw new BadRequestException('Service is not active');
    }

    // Check if slot exists and is available
    const slot = await this.prisma.slot.findUnique({
      where: { id: slotId },
      include: { schedule: true }
    });
    if (!slot) {
      throw new NotFoundException('Slot not found');
    }
    if (!slot.isAvailable) {
      throw new BadRequestException('Slot is not available');
    }

    // Check if slot duration is sufficient for service
    const slotStart = new Date(`2000-01-01T${slot.startTime}`);
    const slotEnd = new Date(`2000-01-01T${slot.endTime}`);
    const slotDuration = (slotEnd.getTime() - slotStart.getTime()) / (1000 * 60);
    if (slotDuration < service.duration) {
      throw new BadRequestException('Slot duration is insufficient for this service');
    }

    // Check if appointment date is not in the past
    if (isDateTimeInPast(appointmentDate, appointmentTime)) {
      throw new BadRequestException('Appointment date and time cannot be in the past');
    }

    // Check for double booking (doctor)
    const existingDoctorAppointment = await this.prisma.appointment.findFirst({
      where: {
        doctorId,
        appointmentDate: dateStringToUTC(appointmentDate),
        appointmentTime,
        status: {
          in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS]
        }
      }
    });
    if (existingDoctorAppointment) {
      throw new ConflictException('Doctor already has an appointment at this time');
    }

    console.log(`✅ Slot ${slotId} made available again after cancellation`);

    // Create appointment
    const appointment = await this.prisma.appointment.create({
      data: {
        patientId,
        doctorId,
        serviceId,
        slotId,
        primaryServiceId,
        appointmentDate: dateStringToUTC(appointmentDate),
        appointmentTime,
        duration,
        status: AppointmentStatus.PENDING,
        patientNotes,
        symptoms,
        amount,
        isPaid: false,
        scheduledAt: new Date()
      }
    });

    // Update slot availability
    await this.prisma.slot.update({
      where: { id: slotId },
      data: { isAvailable: false }
    });

    return appointment;
  }

  /**
   * Get appointment by ID with relations
   */
  async findById(id: string): Promise<AppointmentWithRelationsResponseDto> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryEmail: true,
            primaryPhone: true,
            gender: true,
            dateOfBirth: true,
            photoPath: true,
            drivingLicensePath: true,
            completeAddress: true,
            city: true,
            state: true,
            zipcode: true,
          }
        },
        doctor: {
          select: {
            id: true,
            licenseNumber: true,
            specialization: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        service: {
          select: {
            id: true,
            name: true,
            duration: true,
            category: true
          }
        },
        slot: {
          select: {
            id: true,
            startTime: true,
            endTime: true,
            schedule: {
              select: {
                date: true
              }
            }
          }
        },
        medicalForm: true, // Include medical form data
        medicationPrescriptions: true, // Include medication prescriptions
        rescheduleLogs: { orderBy: { createdAt: 'asc' } } // Reschedule audit history for the chart
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    return appointment;
  }

  /**
   * Parse a search term into a single-day UTC range if it looks like a date of birth.
   * Accepts YYYY-MM-DD, MM/DD/YYYY and M/D/YYYY. Returns null if not a date.
   */
  private parseDobRange(input: string): { gte: Date; lte: Date } | null {
    if (!input) return null;
    let iso: string | null = null;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(input)) {
      const [y, m, d] = input.split('-').map((n) => parseInt(n, 10));
      iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(input)) {
      const [m, d, y] = input.split('/').map((n) => parseInt(n, 10));
      iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    if (!iso) return null;
    const base = dateStringToUTC(iso);
    if (isNaN(base.getTime())) return null;
    return { gte: getUTCMidnight(base), lte: getUTCEndOfDay(base) };
  }

  /**
   * Get all appointments with filtering and pagination
   */
  async findAll(query: QueryAppointmentsDto): Promise<{ appointments: AppointmentWithRelationsResponseDto[], total: number }> {
    const { patientId, doctorId, serviceId, status, startDate, endDate, search, order, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;
    const sortDir: 'asc' | 'desc' = order === 'asc' ? 'asc' : 'desc';

    const where: any = {};

    if (patientId) where.patientId = patientId;
    if (doctorId) where.doctorId = doctorId;
    if (serviceId) where.serviceId = serviceId;
    if (status) where.status = status;
    if (startDate || endDate) {
      where.appointmentDate = {};
      if (startDate) {
        // Ensure we're comparing dates at the start of the day (UTC)
        where.appointmentDate.gte = getUTCMidnight(dateStringToUTC(startDate));
      }
      if (endDate) {
        // Ensure we're comparing dates at the end of the day (UTC)
        where.appointmentDate.lte = getUTCEndOfDay(dateStringToUTC(endDate));
      }
    }

    // Handle search functionality
    if (search) {
      const searchTerms = search.trim().split(/\s+/).filter(term => term.length > 0);
      
      if (searchTerms.length === 1) {
        // Single term search (name, email, service, or date of birth)
        where.OR = [
          {
            patient: {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { middleName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { primaryEmail: { contains: search, mode: 'insensitive' } }
              ]
            }
          },
          {
            doctor: {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } }
              ]
            }
          },
          {
            service: {
              name: { contains: search, mode: 'insensitive' }
            }
          }
        ];
        // If the term looks like a date, also match patient date of birth
        const dob = this.parseDobRange(search.trim());
        if (dob) {
          where.OR.push({ patient: { dateOfBirth: { gte: dob.gte, lte: dob.lte } } });
        }
      } else {
        // Multiple terms search
        const searchConditions: any[] = [];
        
        // Search for patient name combinations
        if (searchTerms.length === 2) {
          // Two terms: try different combinations
          searchConditions.push({
            patient: {
              AND: [
                { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
                { lastName: { contains: searchTerms[1], mode: 'insensitive' } }
              ]
            }
          });
          searchConditions.push({
            patient: {
              AND: [
                { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
                { middleName: { contains: searchTerms[1], mode: 'insensitive' } }
              ]
            }
          });
          searchConditions.push({
            patient: {
              AND: [
                { middleName: { contains: searchTerms[0], mode: 'insensitive' } },
                { lastName: { contains: searchTerms[1], mode: 'insensitive' } }
              ]
            }
          });
        } else if (searchTerms.length === 3) {
          // Three terms: try different combinations
          searchConditions.push({
            patient: {
              AND: [
                { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
                { middleName: { contains: searchTerms[1], mode: 'insensitive' } },
                { lastName: { contains: searchTerms[2], mode: 'insensitive' } }
              ]
            }
          });
          searchConditions.push({
            patient: {
              AND: [
                { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
                { lastName: { contains: searchTerms[2], mode: 'insensitive' } }
              ]
            }
          });
        } else if (searchTerms.length > 3) {
          // More than 3 terms: try first + last, and first + middle + last
          searchConditions.push({
            patient: {
              AND: [
                { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
                { lastName: { contains: searchTerms[searchTerms.length - 1], mode: 'insensitive' } }
              ]
            }
          });
          if (searchTerms.length >= 3) {
            searchConditions.push({
              patient: {
                AND: [
                  { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
                  { middleName: { contains: searchTerms[1], mode: 'insensitive' } },
                  { lastName: { contains: searchTerms[searchTerms.length - 1], mode: 'insensitive' } }
                ]
              }
            });
          }
        }
        
        // Search for doctor name combinations
        if (searchTerms.length >= 2) {
          searchConditions.push({
            doctor: {
              AND: [
                { firstName: { contains: searchTerms[0], mode: 'insensitive' } },
                { lastName: { contains: searchTerms.slice(1).join(' '), mode: 'insensitive' } }
              ]
            }
          });
        }
        
        // Search for service name
        searchConditions.push({
          service: {
            name: { contains: search, mode: 'insensitive' }
          }
        });
        
        // Individual term searches
        searchTerms.forEach(term => {
          searchConditions.push(
            {
              patient: {
                OR: [
                  { firstName: { contains: term, mode: 'insensitive' } },
                  { middleName: { contains: term, mode: 'insensitive' } },
                  { lastName: { contains: term, mode: 'insensitive' } },
                  { primaryEmail: { contains: term, mode: 'insensitive' } }
                ]
              }
            },
            {
              doctor: {
                OR: [
                  { firstName: { contains: term, mode: 'insensitive' } },
                  { lastName: { contains: term, mode: 'insensitive' } },
                  { email: { contains: term, mode: 'insensitive' } }
                ]
              }
            },
            {
              service: {
                name: { contains: term, mode: 'insensitive' }
              }
            }
          );
        });
        
        where.OR = searchConditions;
      }
    }

    const [appointments, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              primaryEmail: true,
              primaryPhone: true
            }
          },
          doctor: {
            select: {
              id: true,
              licenseNumber: true,
              specialization: true,
              firstName: true,
              lastName: true,
              email: true
            }
          },
          service: {
            select: {
              id: true,
              name: true,
              duration: true,
              category: true
            }
          },
          slot: {
            select: {
              id: true,
              startTime: true,
              endTime: true,
              schedule: {
                select: {
                  date: true
                }
              }
            }
          },
          rescheduleLogs: { orderBy: { createdAt: 'asc' } } // Reschedule audit history
        },
        skip,
        take: limit,
        orderBy: [
          { appointmentDate: sortDir },
          { appointmentTime: sortDir }
        ]
      }),
      this.prisma.appointment.count({ where })
    ]);

    return { appointments, total };
  }

  /**
   * Update appointment
   */
  async updateAppointment(id: string, updateAppointmentDto: UpdateAppointmentDto): Promise<AppointmentResponseDto> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Check if appointment can be updated
    if (appointment.status === AppointmentStatus.COMPLETED) {
      throw new BadRequestException('Completed appointments cannot be updated');
    }

    if (appointment.status === AppointmentStatus.CANCELLED) {
      throw new BadRequestException('Cancelled appointments cannot be updated');
    }

    // Update status-specific fields
    const updateData: any = { ...updateAppointmentDto };

    if (updateData.status) {
      if (updateData.status === AppointmentStatus.CONFIRMED && appointment.status !== AppointmentStatus.CONFIRMED) {
        updateData.confirmedAt = new Date();
      } else if (updateData.status === AppointmentStatus.COMPLETED && (appointment.status as AppointmentStatus) !== AppointmentStatus.COMPLETED) {
        updateData.completedAt = new Date();
      } else if (updateData.status === AppointmentStatus.CANCELLED && (appointment.status as AppointmentStatus) !== AppointmentStatus.CANCELLED) {
        updateData.cancelledAt = new Date();
      }
    }

    const updatedAppointment = await this.prisma.appointment.update({
      where: { id },
      data: updateData
    });

    return updatedAppointment;
  }

  /**
   * Set clinical visit status (doctor/staff). Single source of truth: mirrors the
   * booking `status` so the admin schedule/list filter stays consistent with the
   * recorded outcome. Has no time restriction (works for past appointments, e.g. no-show).
   */
  async updateVisitStatus(
    appointmentId: string,
    visitStatus: string | null | undefined,
    visitStatusNote: string | undefined,
    setByUserId: string,
  ): Promise<AppointmentResponseDto> {
    const appointment = await this.prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (!appointment) throw new NotFoundException('Appointment not found');

    // Mirror booking status from the recorded clinical outcome.
    const now = new Date();
    const bookingMirror: any = {};
    switch (visitStatus) {
      case 'COMPLETED':
        bookingMirror.status = AppointmentStatus.COMPLETED;
        bookingMirror.completedAt = now;
        break;
      case 'NO_SHOW':
        bookingMirror.status = AppointmentStatus.NO_SHOW;
        break;
      case 'CANCELLED_BY_PATIENT':
      case 'CANCELLED_BY_CLINIC':
        bookingMirror.status = AppointmentStatus.CANCELLED;
        bookingMirror.cancelledAt = now;
        break;
      case 'RESCHEDULED':
        bookingMirror.status = AppointmentStatus.RESCHEDULED;
        break;
      default:
        // Clearing the outcome — revert to CONFIRMED so it reappears as an active booking.
        bookingMirror.status = AppointmentStatus.CONFIRMED;
        break;
    }

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        visitStatus: (visitStatus ?? null) as any,
        visitStatusNote: visitStatus ? (visitStatusNote ?? null) : null,
        visitStatusSetAt: visitStatus ? now : null,
        visitStatusSetBy: visitStatus ? setByUserId : null,
        ...bookingMirror,
      },
    });
    return updated as any;
  }

  /**
   * Front-desk check-in (operational). Sets/clears the checkedInAt timestamp.
   */
  async checkInAppointment(
    appointmentId: string,
    setByUserId: string,
    checkedIn: boolean,
  ): Promise<AppointmentResponseDto> {
    const appointment = await this.prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (!appointment) throw new NotFoundException('Appointment not found');

    const updated = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        checkedInAt: checkedIn ? new Date() : null,
        checkedInBy: checkedIn ? setByUserId : null,
      },
    });
    return updated as any;
  }

  /**
   * Update internal notes for an appointment (doctor only)
   */
  async updateInternalNotes(appointmentId: string, internalNotes: string, doctorId: string): Promise<AppointmentResponseDto> {
    // Check if appointment exists and belongs to the doctor
    const appointment = await this.prisma.appointment.findFirst({
      where: { 
        id: appointmentId,
        doctorId: doctorId
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found or you do not have permission to update this appointment');
    }

    // Check if notes are already signed
    if (appointment.notesSignedAt) {
      throw new BadRequestException('Cannot update notes. Appointment has already been signed.');
    }

    // Update the internal notes
    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { internalNotes }
    });

    return updatedAppointment;
  }

  /**
   * Update subjective notes for an appointment (doctor only)
   */
  async updateCarePlan(appointmentId: string, carePlan: string, doctorId: string): Promise<AppointmentResponseDto> {
    // Check if appointment exists and belongs to the doctor
    const appointment = await this.prisma.appointment.findFirst({
      where: { 
        id: appointmentId,
        doctorId: doctorId
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found or you do not have permission to update this appointment');
    }

    // Check if notes are already signed
    if (appointment.notesSignedAt) {
      throw new BadRequestException('Cannot update notes. Appointment has already been signed.');
    }

    // Update the care plan
    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { carePlan },
    });

    return updatedAppointment;
  }

  async updateSubjectiveNotes(appointmentId: string, subjectiveNotes: string, doctorId: string): Promise<AppointmentResponseDto> {
    // Check if appointment exists and belongs to the doctor
    const appointment = await this.prisma.appointment.findFirst({
      where: { 
        id: appointmentId,
        doctorId: doctorId
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found or you do not have permission to update this appointment');
    }

    // Check if notes are already signed
    if (appointment.notesSignedAt) {
      throw new BadRequestException('Cannot update notes. Appointment has already been signed.');
    }

    // Update the subjective notes
    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { subjectiveNotes }
    });

    return updatedAppointment;
  }

  async updateDrAssessmentNotes(
    appointmentId: string,
    drAssessmentNotes: string,
    doctorId: string,
  ): Promise<AppointmentResponseDto> {
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        doctorId: doctorId,
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found or you do not have permission to update this appointment');
    }

    if (appointment.notesSignedAt) {
      throw new BadRequestException('Cannot update notes. Appointment has already been signed.');
    }

    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { drAssessmentNotes },
    });

    return updatedAppointment;
  }

  /**
   * Sign notes for an appointment (sets notesSignedAt timestamp)
   */
  async signNotes(appointmentId: string, doctorId: string): Promise<AppointmentResponseDto> {
    // Check if appointment exists and belongs to the doctor
    const appointment = await this.prisma.appointment.findFirst({
      where: { 
        id: appointmentId,
        doctorId: doctorId
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found or you do not have permission to sign this appointment');
    }

    // Check if notes are already signed
    if (appointment.notesSignedAt) {
      throw new BadRequestException('Notes have already been signed for this appointment.');
    }

    // Set notesSignedAt timestamp
    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { notesSignedAt: new Date() },
    });

    return updatedAppointment;
  }

  /**
   * Update medications JSON for an appointment (doctor only)
   * Supports both old format (string[]) and new format (MedicationObject[]) for backward compatibility
   */
  async updateMedications(
    appointmentId: string,
    medications: Record<string, string[] | any[]>, // Can be string[] (old) or MedicationObject[] (new)
    merge: boolean,
    doctorId: string,
  ): Promise<AppointmentResponseDto> {
    // Check if appointment exists and belongs to the doctor
    const appointment = await this.prisma.appointment.findFirst({
      where: { 
        id: appointmentId,
        doctorId: doctorId
      },
      include: {
        medicationPayment: true,
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found or you do not have permission to update this appointment');
    }

    // Check if medications have been paid/submitted
    if (appointment.medicationPayment && appointment.medicationPayment.status === 'SUCCEEDED') {
      throw new BadRequestException('Cannot modify medications. Medications have already been submitted and paid.');
    }

    console.log('=== Backend updateMedications Debug ===');
    console.log('Appointment ID:', appointmentId);
    console.log('Incoming medications:', JSON.stringify(medications, null, 2));
    console.log('Merge flag:', merge);

    let updatedMedications: any = medications;
    const appointmentAny = appointment as any;
    
    console.log('Existing medications in DB:', JSON.stringify(appointmentAny.medications, null, 2));
    
    if (merge && appointmentAny.medications) {
      // When merging, we keep existing services and replace/update the specified services
      const existing = appointmentAny.medications as Record<string, string[] | any[]>;
      updatedMedications = { ...existing };
      
      console.log('After copying existing:', JSON.stringify(updatedMedications, null, 2));
      
      // For each service in the incoming medications, REPLACE that service's medications
      // This allows updating a specific service while preserving all other services
      for (const [serviceName, meds] of Object.entries(medications)) {
        console.log(`Updating service "${serviceName}" with:`, meds);
        // Store medications as-is (can be string[] or MedicationObject[])
        updatedMedications[serviceName] = meds; // Replace medications for this service
      }
    }

    console.log('Final medications to save:', JSON.stringify(updatedMedications, null, 2));

    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { medications: updatedMedications } as any,
    });

    console.log('Saved medications:', JSON.stringify((updatedAppointment as any).medications, null, 2));
    console.log('=== End Backend Debug ===');

    return updatedAppointment;
  }

  /**
   * Cancel appointment
   */
  async cancelAppointment(id: string, cancelAppointmentDto: CancelAppointmentDto): Promise<AppointmentResponseDto> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: { 
        slot: true,
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryEmail: true,
          },
        },
        doctor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Check if appointment can be cancelled
    if (appointment.status === AppointmentStatus.COMPLETED) {
      throw new BadRequestException('Completed appointments cannot be cancelled');
    }

    if (appointment.status === AppointmentStatus.CANCELLED) {
      throw new BadRequestException('Appointment is already cancelled');
    }

    // Check cancellation window (1 hour before appointment as per requirements)
    const appointmentDateTime = new Date(`${appointment.appointmentDate.toISOString().split('T')[0]}T${appointment.appointmentTime}`);
    const now = new Date();
    const hoursUntilAppointment = (appointmentDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
    
    if (hoursUntilAppointment < 1) {
      throw new BadRequestException('Appointments can only be cancelled at least 1 hour in advance');
    }

    // Use transaction to ensure data consistency
    const result = await this.prisma.$transaction(async (prisma) => {
      // Cancel appointment
      const cancelledAppointment = await prisma.appointment.update({
        where: { id },
        data: {
          status: AppointmentStatus.CANCELLED,
          cancellationReason: cancelAppointmentDto.cancellationReason,
          cancelledAt: new Date()
        }
      });

      // Make slot available again (if slotId exists)
      if (appointment.slotId) {
        const updatedSlot = await prisma.slot.update({
          where: { id: appointment.slotId },
          data: { isAvailable: true }
        });
        console.log(`✅ Slot ${appointment.slotId} made available again after cancellation`);
        console.log(`📅 Slot details:`, {
          id: updatedSlot.id,
          startTime: updatedSlot.startTime,
          endTime: updatedSlot.endTime,
          isAvailable: updatedSlot.isAvailable
        });
      }

      return cancelledAppointment;
    });

    // Send email notifications
    try {
      const patientName = `${appointment.patient.firstName} ${appointment.patient.lastName}`;
      const doctorName = appointment.doctor ? `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}` : 'To be assigned';
      const appointmentDate = appointment.appointmentDate.toISOString().split('T')[0];
      const amount = appointment.amount.toString();

      // Send cancellation email to patient
      await this.mailerService.sendCancellationEmail(
        appointment.patient.primaryEmail || '',
        patientName,
        doctorName,
        appointmentDate,
        appointment.appointmentTime,
        amount
      );

      // Send cancellation notification to doctor with refund request (if doctor exists)
      if (appointment.doctor) {
        await this.mailerService.sendDoctorCancellationNotification(
          appointment.doctor.email,
          doctorName,
          patientName,
          appointment.patient.primaryEmail || '',
          appointmentDate,
          appointment.appointmentTime,
          amount,
          'America/Chicago'
        );
      }
    } catch (error) {
      console.error('Failed to send cancellation emails:', error);
      // Don't throw error to avoid breaking the cancellation process
    }

    return result;
  }

  /**
   * Reschedule appointment
   */
  async rescheduleAppointment(id: string, rescheduleAppointmentDto: RescheduleAppointmentDto, rescheduledBy?: string): Promise<AppointmentResponseDto> {
    const { newSlotId, reason, patientTimezone, newDate: customDate, newTime: customTime, duration: customDuration } = rescheduleAppointmentDto;

    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: { 
        slot: true,
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryEmail: true,
          },
        },
        doctor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Check if appointment can be rescheduled
    if (appointment.status === AppointmentStatus.COMPLETED) {
      throw new BadRequestException('Completed appointments cannot be rescheduled');
    }

    // Resolve the target time: either an existing slot, or a custom out-of-slot
    // time (admin front-desk reschedule). We compute a common (newScheduleDate,
    // newStartTime) so the rest of the flow is shared.
    const isCustomReschedule = !newSlotId;
    let newSlot: any = null;
    let newScheduleDate: Date;
    let newStartTime: string;

    if (!isCustomReschedule) {
      // Check if new slot exists and is available
      newSlot = await this.prisma.slot.findUnique({
        where: { id: newSlotId },
        include: { schedule: true }
      });
      if (!newSlot) {
        throw new NotFoundException('New slot not found');
      }
      if (!newSlot.isAvailable) {
        throw new BadRequestException('New slot is not available');
      }

      // Check if new slot duration is sufficient
      const service = await this.prisma.service.findUnique({
        where: { id: appointment.serviceId },
        select: { duration: true }
      });
      if (service) {
        const slotStart = new Date(`2000-01-01T${newSlot.startTime}`);
        const slotEnd = new Date(`2000-01-01T${newSlot.endTime}`);
        const slotDuration = (slotEnd.getTime() - slotStart.getTime()) / (1000 * 60);
        if (slotDuration < service.duration) {
          throw new BadRequestException('New slot duration is insufficient for this service');
        }
      }
      newScheduleDate = newSlot.schedule.date;
      newStartTime = newSlot.startTime;
    } else {
      // Custom (out-of-slot) reschedule — no slot required.
      if (!customDate || !customTime) {
        throw new BadRequestException('A new slot, or a custom date and time, is required');
      }
      newScheduleDate = dateStringToUTC(customDate);
      newStartTime = customTime;

      // Reject if the custom time overlaps a slot already in the doctor's
      // schedule for that day — the admin should book that slot instead
      // (mirrors the create-appointment guard, prevents double-booking).
      const toMin = (t: string) => {
        const [h, m] = (t || '0:0').split(':').map((n) => parseInt(n, 10));
        return (h || 0) * 60 + (m || 0);
      };
      const startMin = toMin(newStartTime);
      const endMin = startMin + (Number(customDuration) || appointment.duration || 0);
      const daySlots = await this.prisma.slot.findMany({
        where: { schedule: { doctorId: appointment.doctorId || undefined, date: newScheduleDate } },
        select: { startTime: true, endTime: true },
      });
      const clash = daySlots.find((s) => toMin(s.startTime) < endMin && startMin < toMin(s.endTime));
      if (clash) {
        throw new BadRequestException(
          `A slot already exists in the schedule for ${clash.startTime}–${clash.endTime} on this date. Please book that slot instead of a custom time.`,
        );
      }
    }

    // Store old appointment details for email
    const oldDate = appointment.appointmentDate.toISOString().split('T')[0];
    const oldTime = appointment.appointmentTime;
    const newDate = newScheduleDate.toISOString().split('T')[0];
    const newTime = newStartTime;

    // Prepare patient and doctor names
    const patientName = `${appointment.patient.firstName} ${appointment.patient.lastName}`;
    const doctorName = appointment.doctor ? `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}` : 'To be assigned';
    
    // Preserve existing Meet link if valid — updateEvent is currently skipped and returns
    // a randomly generated fake URL which would break the real link already stored.
    // Google Meet rooms persist independently of calendar event time, so the original
    // link remains valid after rescheduling.
    const appointmentAdditionalServices =
      (appointment as any).additionalServices as Array<{ id: string; name: string; duration: number }> | null;

    let meetResult: { meetLink: string; eventId?: string };

    if (appointment.googleMeetLink && appointment.googleMeetLink.startsWith('https://meet.google.com/')) {
      // Keep the existing real Meet link — only the calendar time changes, not the room
      console.log('📅 Preserving existing Google Meet link on reschedule:', appointment.googleMeetLink);
      meetResult = { meetLink: appointment.googleMeetLink, eventId: appointment.googleEventId || undefined };
    } else {
      // No valid Meet link yet — generate a fresh Google Calendar event
      console.log('📅 No existing Meet link, creating new Google Calendar event...');
      meetResult = await this.googleCalendarService.generateMeetLink(
        newScheduleDate,
        newStartTime,
        appointment.duration,
        doctorName,
        patientName,
        appointment.service.name,
        appointment.patient.primaryEmail || undefined,
        appointment.doctor?.email,
        patientTimezone,
        appointmentAdditionalServices || undefined,
        appointment.doctorId || undefined
      );
    }

    // Use transaction to ensure data consistency
    const result = await this.prisma.$transaction(async (prisma) => {
      // Make old slot available again (if slotId exists)
      if (appointment.slotId) {
        await prisma.slot.update({
          where: { id: appointment.slotId },
          data: { isAvailable: true }
        });
      }

      // Update appointment with new slot/custom time and Google Meet link + event ID
      const updatedAppointment = await prisma.appointment.update({
        where: { id },
        data: {
          slotId: isCustomReschedule ? null : newSlotId,
          appointmentDate: newScheduleDate,
          appointmentTime: newStartTime,
          status: AppointmentStatus.CONFIRMED, // Keep as confirmed since payment was already made
          googleMeetLink: meetResult.meetLink,
          googleEventId: meetResult.eventId || null,
        }
      });

      // Make new slot unavailable (slot-based reschedule only)
      if (!isCustomReschedule) {
        await prisma.slot.update({
          where: { id: newSlotId },
          data: { isAvailable: false }
        });
      }

      // Record the reschedule in the audit log so the original date/time stays
      // visible in the patient chart (the appointment row itself is mutated in place).
      await prisma.appointmentRescheduleLog.create({
        data: {
          appointmentId: id,
          fromDate: appointment.appointmentDate,
          fromTime: oldTime,
          toDate: newScheduleDate,
          toTime: newStartTime,
          reason: reason || null,
          rescheduledBy: rescheduledBy || null,
        },
      });

      return updatedAppointment;
    });

    // Send email notifications
    try {
      const patientName = `${appointment.patient.firstName} ${appointment.patient.lastName}`;
      const doctorName = appointment.doctor ? `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}` : 'To be assigned';

      // Send reschedule email to patient with new Google Meet link
      await this.mailerService.sendRescheduleEmail(
        appointment.patient.primaryEmail || '',
        patientName,
        doctorName,
        oldDate,
        oldTime,
        newDate,
        newTime,
        meetResult.meetLink,
        patientTimezone // Use patient's timezone from frontend
      );

      // Send reschedule notification to doctor with new Google Meet link (only if doctor is assigned)
      if (appointment.doctor) {
        await this.mailerService.sendDoctorRescheduleNotification(
          appointment.doctor.email,
          doctorName,
          patientName,
          oldDate,
          oldTime,
          newDate,
          newTime,
          meetResult.meetLink,
          'America/Chicago'
        );
      }
    } catch (error) {
      console.error('Failed to send reschedule emails:', error);
      // Don't throw error to avoid breaking the reschedule process
    }

    return result;
  }

  /**
   * Get patient appointments
   */
  async getPatientAppointments(patientId: string, query: QueryAppointmentsDto): Promise<{ appointments: AppointmentWithRelationsResponseDto[], total: number }> {
    const { status, startDate, endDate, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const where: any = { patientId };

    if (status) where.status = status;
    if (startDate || endDate) {
      where.appointmentDate = {};
      if (startDate) {
        // Ensure we're comparing dates at the start of the day (UTC)
        where.appointmentDate.gte = getUTCMidnight(dateStringToUTC(startDate));
      }
      if (endDate) {
        // Ensure we're comparing dates at the end of the day (UTC)
        where.appointmentDate.lte = getUTCEndOfDay(dateStringToUTC(endDate));
      }
    }

    const [appointments, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              primaryEmail: true,
              primaryPhone: true
            }
          },
          doctor: {
            select: {
              id: true,
              licenseNumber: true,
              specialization: true,
              firstName: true,
              lastName: true,
              email: true
            }
          },
          service: {
            select: {
              id: true,
              name: true,
              duration: true,
              category: true
            }
          },
          slot: {
            select: {
              id: true,
              startTime: true,
              endTime: true,
              schedule: {
                select: {
                  date: true
                }
              }
            }
          },
          medicalForm: true, // Include medical form data
          rescheduleLogs: { orderBy: { createdAt: 'asc' } } // Reschedule audit history
        },
        skip,
        take: limit,
        orderBy: [
          { appointmentDate: 'desc' },
          { appointmentTime: 'desc' }
        ]
      }),
      this.prisma.appointment.count({ where })
    ]);

    return { appointments, total };
  }

  /**
   * Get doctor appointments
   */
  async getDoctorAppointments(doctorId: string, query: QueryAppointmentsDto): Promise<{ appointments: AppointmentWithRelationsResponseDto[], total: number }> {
    const { status, startDate, endDate, search, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const where: any = { 
      doctorId,
      AND: []
    };

    if (status) where.AND.push({ status });
    if (startDate || endDate) {
      const dateFilter: any = {};
      if (startDate) {
        // Ensure we're comparing dates at the start of the day (UTC)
        dateFilter.gte = getUTCMidnight(dateStringToUTC(startDate));
      }
      if (endDate) {
        // Ensure we're comparing dates at the end of the day (UTC)
        dateFilter.lte = getUTCEndOfDay(dateStringToUTC(endDate));
      }
      if (Object.keys(dateFilter).length > 0) {
        where.AND.push({ appointmentDate: dateFilter });
      }
    }

    // Add search functionality
    if (search && search.trim()) {
      const s = search.trim();
      const terms = s.split(/\s+/).filter(t => t.length > 0);

      const orConditions: any[] = [
        // Full string matches (single word case)
        { patient: { firstName: { contains: s, mode: 'insensitive' } } },
        { patient: { lastName: { contains: s, mode: 'insensitive' } } },
        { patient: { primaryEmail: { contains: s, mode: 'insensitive' } } },
        { service: { name: { contains: s, mode: 'insensitive' } } },
      ];

      if (terms.length >= 2) {
        // "John Doe" → firstName=John AND lastName=Doe
        orConditions.push({
          patient: {
            AND: [
              { firstName: { contains: terms[0], mode: 'insensitive' } },
              { lastName: { contains: terms[terms.length - 1], mode: 'insensitive' } },
            ],
          },
        });
        // Also try reversed: "Doe John" → firstName=Doe AND lastName=John
        orConditions.push({
          patient: {
            AND: [
              { firstName: { contains: terms[terms.length - 1], mode: 'insensitive' } },
              { lastName: { contains: terms[0], mode: 'insensitive' } },
            ],
          },
        });
        // Each individual term against each field separately (flat, no nested OR on relation)
        terms.forEach(term => {
          orConditions.push(
            { patient: { firstName: { contains: term, mode: 'insensitive' } } },
            { patient: { lastName: { contains: term, mode: 'insensitive' } } },
            { patient: { primaryEmail: { contains: term, mode: 'insensitive' } } },
          );
        });
      }

      where.AND.push({ OR: orConditions });
    }

    // Clean up empty AND array
    if (where.AND.length === 0) {
      delete where.AND;
    }

    const [appointments, total] = await Promise.all([
      this.prisma.appointment.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              primaryEmail: true,
              primaryPhone: true
            }
          },
          doctor: {
            select: {
              id: true,
              licenseNumber: true,
              specialization: true,
              firstName: true,
              lastName: true,
              email: true
            }
          },
          service: {
            select: {
              id: true,
              name: true,
              duration: true,
              category: true
            }
          },
          primaryService: {
            select: {
              id: true,
              name: true,
            }
          },
          slot: {
            select: {
              id: true,
              startTime: true,
              endTime: true,
              schedule: {
                select: {
                  date: true
                }
              }
            }
          }
        },
        skip,
        take: limit,
        orderBy: [
          { appointmentDate: 'desc' },
          { appointmentTime: 'asc' }
        ]
      }),
      this.prisma.appointment.count({ where })
    ]);

    return { appointments, total };
  }

  /**
   * Get upcoming appointments
   */
  async getUpcomingAppointments(userId: string, userType: 'patient' | 'doctor'): Promise<AppointmentWithRelationsResponseDto[]> {
    const where: any = {
      appointmentDate: {
        gte: new Date()
      },
      status: {
        in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS]
      }
    };

    if (userType === 'patient') {
      where.patientId = userId;
    } else if (userType === 'doctor') {
      where.doctorId = userId;
    }

    const appointments = await this.prisma.appointment.findMany({
      where,
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryEmail: true,
            primaryPhone: true
          }
        },
        doctor: {
          select: {
            id: true,
            licenseNumber: true,
            specialization: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        service: {
          select: {
            id: true,
            name: true,
            duration: true,
            category: true
          }
        },
        slot: {
          select: {
            id: true,
            startTime: true,
            endTime: true,
            schedule: {
              select: {
                date: true
              }
            }
          }
        }
      },
      orderBy: [
        { appointmentDate: 'desc' },
        { appointmentTime: 'asc' }
      ]
    });

    return appointments;
  }

  /**
   * Get appointment statistics
   */
  async getAppointmentStats(doctorId?: string, startDate?: Date, endDate?: Date): Promise<any> {
    const where: any = {};
    
    if (doctorId) {
      where.doctorId = doctorId;
    }
    
    if (startDate || endDate) {
      where.appointmentDate = {};
      if (startDate) {
        where.appointmentDate.gte = startDate;
      }
      if (endDate) {
        where.appointmentDate.lte = endDate;
      }
    }

    const [
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      completedAppointments,
      cancelledAppointments,
      todayAppointments
    ] = await Promise.all([
      this.prisma.appointment.count({ where }),
      this.prisma.appointment.count({ where: { ...where, status: AppointmentStatus.PENDING } }),
      this.prisma.appointment.count({ where: { ...where, status: AppointmentStatus.CONFIRMED } }),
      this.prisma.appointment.count({ where: { ...where, status: AppointmentStatus.COMPLETED } }),
      this.prisma.appointment.count({ where: { ...where, status: AppointmentStatus.CANCELLED } }),
      this.prisma.appointment.count({
        where: {
          ...where,
          appointmentDate: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
            lt: new Date(new Date().setHours(23, 59, 59, 999))
          }
        }
      })
    ]);

    return {
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      completedAppointments,
      cancelledAppointments,
      todayAppointments
    };
  }

  /**
   * Get the patient's pending unpaid appointment (if any) created within the last 60 minutes.
   * Used to show the "complete your payment" banner on the booking page.
   */
  async getPendingUnpaidAppointment(patientId: string) {
    // Return any unpaid appointment created within the last 60 minutes,
    // OR any existing unpaid appointment that is upcoming (appointment date in the future or today).
    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const appointment = await this.prisma.appointment.findFirst({
      where: {
        patientId,
        isPaid: false,
        amount: { gt: 0 },   // exclude admin-created $0 appointments — those don't need payment
        status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
        OR: [
          { createdAt: { gte: sixtyMinutesAgo } },
          { appointmentDate: { gte: today } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        service: { select: { name: true } },
        primaryService: { select: { name: true } },
      },
    });

    return appointment;
  }

  /**
   * Delete appointment (admin only)
   */
  async deleteAppointment(id: string): Promise<void> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: { slot: true }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    // Check if appointment can be deleted
    if (appointment.status === AppointmentStatus.COMPLETED) {
      throw new BadRequestException('Completed appointments cannot be deleted');
    }

    // If there's an active medication subscription, cancel it in Stripe first
    if (this.stripe) {
      const medPayment = await this.prisma.medicationPayment.findUnique({
        where: { appointmentId: id },
      });
      if (medPayment?.stripeSubscriptionId) {
        try {
          const sub = await this.stripe.subscriptions.retrieve(medPayment.stripeSubscriptionId);
          if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
            await this.stripe.subscriptions.cancel(medPayment.stripeSubscriptionId);
            console.log(`✅ Cancelled Stripe subscription ${medPayment.stripeSubscriptionId} for appointment ${id}`);
          }
        } catch (stripeErr: any) {
          // Log but don't block deletion — subscription may already be gone in Stripe
          console.warn(`⚠️  Could not cancel Stripe subscription for appointment ${id}:`, stripeErr.message);
        }
      }
    }

    // Use transaction to ensure data consistency
    await this.prisma.$transaction(async (prisma) => {
      // MedicationPayment uses onDelete: Restrict, so must be deleted manually first
      await prisma.medicationPayment.deleteMany({ where: { appointmentId: id } });

      // Make slot available again (if slotId exists)
      if (appointment.slotId) {
        await prisma.slot.update({
          where: { id: appointment.slotId },
          data: { isAvailable: true }
        });
      }

      // Delete appointment
      await prisma.appointment.delete({
        where: { id }
      });
    });
  }

  async getDoctorSlots(doctorId: string, date: string): Promise<any[]> {
    const targetDate = dateStringToUTC(date);
    const startOfDay = getUTCMidnight(targetDate);
    const endOfDay = getUTCEndOfDay(targetDate);

    // First, find schedules for the doctor on the given date
    const schedules = await this.prisma.schedule.findMany({
      where: {
        doctorId,
        date: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: {
        slots: {
          include: {
            appointment: {
              include: {
                patient: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    primaryEmail: true,
                    primaryPhone: true,
                  },
                },
                service: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
          orderBy: {
            startTime: 'asc',
          },
        },
      },
    });

    // Flatten all slots from all schedules
    const allSlots = schedules.flatMap(schedule => schedule.slots);

    // Create a map to deduplicate slots by time range, prioritizing booked slots
    const slotMap = new Map<string, any>();

    allSlots.forEach(slot => {
      const timeKey = `${slot.startTime}-${slot.endTime}`;
      const isBooked = slot.appointment && slot.appointment.length > 0;
      
      // If slot doesn't exist in map, or if current slot is booked and existing is not, use current slot
      if (!slotMap.has(timeKey) || (isBooked && !slotMap.get(timeKey).isBooked)) {
        slotMap.set(timeKey, {
          ...slot,
          isBooked
        });
      }
    });

    // Convert map back to array and sort by start time
    return Array.from(slotMap.values())
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .map(slot => ({
        id: slot.id,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: slot.isBooked ? 'booked' : slot.isAvailable ? 'available' : 'blocked',
        appointment: slot.isBooked ? {
          id: slot.appointment[0].id,
          patientName: `${slot.appointment[0].patient?.firstName || ''} ${slot.appointment[0].patient?.lastName || ''}`.trim() || 'Unknown Patient',
          patientEmail: slot.appointment[0].patient?.primaryEmail || '',
          patientPhone: slot.appointment[0].patient?.primaryPhone || '',
          serviceName: slot.appointment[0].service?.name || 'General Consultation',
          notes: slot.appointment[0].patientNotes || '',
          status: slot.appointment[0].status,
          googleMeetLink: slot.appointment[0].googleMeetLink || null,
        } : undefined,
      }));
  }

  async adminCreateConfirmed(dto: any): Promise<any> {
    const { patientId, doctorId, serviceId, primaryServiceId, slotId, appointmentDate, appointmentTime, duration, patientNotes, patientTimezone } = dto;

    // Basic validations
    const patient = await this.prisma.user.findUnique({ where: { id: patientId }, select: { id: true, isActive: true } });
    if (!patient || !patient.isActive) {
      throw new BadRequestException('Invalid or inactive patient');
    }

    const doctor = await this.prisma.doctor.findUnique({ where: { id: doctorId }, select: { id: true, isActive: true, isAvailable: true } });
    if (!doctor || !doctor.isActive || !doctor.isAvailable) {
      throw new BadRequestException('Invalid or unavailable doctor');
    }

    const service = await this.prisma.service.findUnique({ where: { id: serviceId }, select: { id: true, isActive: true } });
    if (!service || !service.isActive) {
      throw new BadRequestException('Invalid or inactive service');
    }

    // Validate primary service
    const primaryService = await this.prisma.primaryService.findUnique({ where: { id: primaryServiceId }, select: { id: true, isActive: true } });
    if (!primaryService || !primaryService.isActive) {
      throw new BadRequestException('Invalid or inactive primary service');
    }

    // Optional: verify slot availability
    if (slotId) {
      const slot = await this.prisma.slot.findUnique({ where: { id: slotId }, select: { id: true, isAvailable: true } });
      if (!slot || !slot.isAvailable) {
        throw new BadRequestException('Selected slot is not available');
      }
    } else {
      // Custom / out-of-slot time: reject if it overlaps a slot that already
      // exists in the doctor's schedule for that day. If a slot is already there,
      // the admin should book that slot instead of creating an overlapping custom
      // appointment (prevents double-booking from the appointment side).
      const toMin = (t: string) => {
        const [h, m] = (t || '0:0').split(':').map((n) => parseInt(n, 10));
        return (h || 0) * 60 + (m || 0);
      };
      const startMin = toMin(appointmentTime);
      const endMin = startMin + (Number(duration) || 0);
      const daySlots = await this.prisma.slot.findMany({
        where: { schedule: { doctorId, date: dateStringToUTC(appointmentDate) } },
        select: { startTime: true, endTime: true },
      });
      const clash = daySlots.find((s) => toMin(s.startTime) < endMin && startMin < toMin(s.endTime));
      if (clash) {
        throw new BadRequestException(
          `A slot already exists in the schedule for ${clash.startTime}–${clash.endTime} on this date. Please book that slot instead of creating a custom time.`,
        );
      }
    }

    // Default care plan for new appointments
    const defaultCarePlan = `1. Continue current treatment regimen as prescribed
2. Monitor symptoms and report any changes
3. Follow up with lab work as scheduled
4. Maintain healthy lifestyle habits (diet, exercise, sleep)`;

    const created = await this.prisma.appointment.create({
      data: {
        patient: { connect: { id: patientId } },
        doctor: { connect: { id: doctorId } },
        service: { connect: { id: serviceId } },
        primaryService: { connect: { id: primaryServiceId } },
        slot: slotId ? { connect: { id: slotId } } : undefined,
        appointmentDate: dateStringToUTC(appointmentDate),
        appointmentTime,
        duration,
        status: 'CONFIRMED',
        patientNotes: patientNotes ?? null,
        carePlan: defaultCarePlan,
        isPaid: false,
        amount: '0.00',
      },
      include: {
        patient: {
          select: { firstName: true, lastName: true, primaryEmail: true }
        },
        doctor: {
          select: { firstName: true, lastName: true, email: true }
        },
        service: {
          select: { name: true }
        },
        slot: true,
      },
    });

    // Clone latest medical form to new one bound to this appointment
    try {
      const lastForm = await this.prisma.medicalForm.findFirst({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
      });
      if (lastForm) {
        const { id: _id, createdAt: _ca, updatedAt: _ua, appointmentId: _oldAptId, ...rest } = lastForm as any;
        await this.prisma.medicalForm.create({
          data: {
            ...rest,
            patientId,
            appointmentId: created.id,
          } as any,
        });
      } else {
        // Ensure there is at least an empty medical form record for this appointment
        await this.prisma.medicalForm.create({
          data: {
            patientId,
            appointmentId: created.id,
          },
        });
      }
    } catch (err) {
      console.error('Failed to clone/create medical form for appointment:', err);
    }

    // Mark slot unavailable if provided
    if (slotId) {
      await this.prisma.slot.update({ where: { id: slotId }, data: { isAvailable: false } });
    }

    // Generate Google Meet link (best-effort)
    try {
      const patientName = `${created.patient.firstName} ${created.patient.lastName}`;
      const doctorName = created.doctor ? `Dr. ${created.doctor.firstName} ${created.doctor.lastName}` : 'To be assigned';
      const additionalServices = (created as any).additionalServices as Array<{ id: string; name: string; duration: number }> | null;
      const meetResult = await this.googleCalendarService.generateMeetLink(
        created.appointmentDate,
        created.appointmentTime,
        created.duration,
        doctorName,
        patientName,
        created.service.name,
        created.patient.primaryEmail || undefined,
        created.doctor?.email,
        patientTimezone, // Pass patient's timezone for correct event time
        additionalServices || undefined,
        doctorId || undefined
      );

      if (meetResult?.meetLink) {
        await this.prisma.appointment.update({
          where: { id: created.id },
          data: { 
            googleMeetLink: meetResult.meetLink,
            googleEventId: meetResult.eventId || null,
            confirmedAt: new Date() 
          },
        });

        // Send emails (best-effort)
        const dateStr = created.appointmentDate.toISOString().split('T')[0];
        const amountStr = typeof (created as any).amount === 'string' ? (created as any).amount : '0.00';
        try {
          if (created.patient?.primaryEmail) {
            const additionalServices = (created as any).additionalServices as Array<{ id: string; name: string; duration: number }> | null;
            await this.mailerService.sendAppointmentConfirmationEmail(
              created.patient.primaryEmail || '',
              patientName,
              doctorName,
              created.service.name,
              dateStr,
              created.appointmentTime,
              amountStr,
              meetResult.meetLink,
              patientTimezone, // Use patient's timezone from frontend
              additionalServices || undefined
            );
          }
        } catch (err) {
          console.error('Failed to send patient confirmation email:', err);
        }

        try {
          if (created.doctor?.email) {
            const additionalServices = (created as any).additionalServices as Array<{ id: string; name: string; duration: number }> | null;
            await this.mailerService.sendDoctorAppointmentNotification(
              created.doctor.email,
              doctorName,
              patientName,
              created.service.name,
              dateStr,
              created.appointmentTime,
              amountStr,
              meetResult.meetLink,
              'America/Chicago',
              additionalServices || undefined
            );
          }
        } catch (err) {
          console.error('Failed to send doctor notification email:', err);
        }
      }
    } catch (err) {
      console.error('Failed to generate Google Meet link or send emails:', err);
    }

    return created as any;
  }

  async getUnassignedAppointments(params: { page?: number; limit?: number; status?: string }): Promise<any[]> {
    const page = params.page && params.page > 0 ? params.page : 1;
    const limit = params.limit && params.limit > 0 ? params.limit : 50;
    const skip = (page - 1) * limit;

    const where: any = {
      doctorId: null,
      slotId: null,
    };
    if (params.status) {
      where.status = params.status.toUpperCase();
    }

    const items = await this.prisma.appointment.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        patient: {
          select: { id: true, firstName: true, lastName: true, primaryEmail: true, primaryPhone: true }
        },
        service: { select: { id: true, name: true, duration: true } },
      },
    });

    return items;
  }
  /**
   * Regenerate and store a fresh Google Meet link for an existing appointment.
   */
  async refreshMeetLink(appointmentId: string): Promise<{ googleMeetLink: string }> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: { select: { firstName: true, lastName: true, primaryEmail: true } },
        doctor: { select: { firstName: true, lastName: true, email: true } },
        service: { select: { name: true } },
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    const patientName = `${appointment.patient.firstName} ${appointment.patient.lastName}`;
    const doctorName = appointment.doctor
      ? `Dr. ${appointment.doctor.firstName} ${appointment.doctor.lastName}`
      : 'To be assigned';

    const meetResult = await this.googleCalendarService.generateMeetLink(
      appointment.appointmentDate,
      appointment.appointmentTime,
      appointment.duration,
      doctorName,
      patientName,
      appointment.service.name,
      appointment.patient.primaryEmail || undefined,
      appointment.doctor?.email,
    );

    if (!meetResult?.meetLink) {
      throw new BadRequestException('Failed to generate a new Google Meet link');
    }

    await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        googleMeetLink: meetResult.meetLink,
        googleEventId: meetResult.eventId || appointment.googleEventId,
      },
    });

    return { googleMeetLink: meetResult.meetLink };
  }

  /**
   * Get all available slots from all doctors for a specific date
   */
  async getGlobalSlots(date: string): Promise<any[]> {
    const targetDate = dateStringToUTC(date);
    
    // Get all slots for the specified date from all doctors
    const slots = await this.prisma.slot.findMany({
      where: {
        isAvailable: true,
        schedule: {
          date: targetDate
        }
      },
      include: {
        schedule: {
          include: {
            doctor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                specialization: true,
                licenseNumber: true
              }
            }
          }
        },
        appointment: {
          include: {
            patient: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                primaryPhone: true
              }
            },
            service: {
              select: {
                name: true
              }
            }
          }
        }
      },
      orderBy: {
        startTime: 'asc'
      }
    });

    // Create a map to deduplicate slots by time
    const slotMap = new Map<string, any>();
    
    slots.forEach(slot => {
      const timeKey = slot.startTime;
      
      // If this time slot doesn't exist or if current slot is booked (prioritize booked slots)
      if (!slotMap.has(timeKey) || (slot.appointment.length > 0 && slotMap.get(timeKey).appointment.length === 0)) {
        slotMap.set(timeKey, {
          id: slot.id,
          startTime: slot.startTime,
          endTime: slot.endTime,
          isAvailable: slot.isAvailable,
          doctor: {
            id: slot.schedule.doctor.id,
            name: `${slot.schedule.doctor.firstName} ${slot.schedule.doctor.lastName}`,
            specialization: slot.schedule.doctor.specialization,
            licenseNumber: slot.schedule.doctor.licenseNumber
          },
          appointment: slot.appointment.length > 0 ? {
            id: slot.appointment[0].id,
            patientName: `${slot.appointment[0].patient?.firstName || ''} ${slot.appointment[0].patient?.lastName || ''}`.trim(),
            patientPhone: slot.appointment[0].patient?.primaryPhone || '',
            serviceName: slot.appointment[0].service?.name || 'General Consultation',
            notes: slot.appointment[0].patientNotes || '',
            status: slot.appointment[0].status,
          } : undefined,
        });
      }
    });

    // Convert map to array
    const slotArray = Array.from(slotMap.values());
    
    // Detect if we have midnight crossover (early morning slots < 12:00 and late night slots >= 12:00)
    // This happens when UTC times cross midnight (e.g., 16:00-01:00 UTC from 10 AM-7 PM CST)
    const hasEarlyMorning = slotArray.some(s => {
      const [h] = s.startTime.split(':').map(Number);
      return h < 12;
    });
    const hasLateNight = slotArray.some(s => {
      const [h] = s.startTime.split(':').map(Number);
      return h >= 12;
    });
    const crossesMidnight = hasEarlyMorning && hasLateNight;
    
    // Custom sort function to handle midnight crossover
    // Times that cross midnight (e.g., 00:00, 00:30) should come after late night times (e.g., 23:00, 23:30)
    const sortSlots = (a: any, b: any) => {
      const timeToMinutes = (time: string): number => {
        const [hours, minutes] = time.split(':').map(Number);
        return hours * 60 + minutes;
      };
      
      const aMinutes = timeToMinutes(a.startTime);
      const bMinutes = timeToMinutes(b.startTime);
      
      if (crossesMidnight) {
        // If crossing midnight, treat early morning times (< 12:00) as next day (add 24 hours)
        // This ensures 14:00, 15:00, ..., 23:00, 23:30, 00:00, 00:30 order
        const aSortMinutes = aMinutes < 12 * 60 ? aMinutes + 24 * 60 : aMinutes;
        const bSortMinutes = bMinutes < 12 * 60 ? bMinutes + 24 * 60 : bMinutes;
        return aSortMinutes - bSortMinutes;
      } else {
        // Normal sort (no midnight crossover)
        return aMinutes - bMinutes;
      }
    };
    
    return slotArray.sort(sortSlots);
  }

  /**
   * Get available doctors for a specific appointment's slot time
   */
  async getAvailableDoctorsForAppointment(appointmentId: string): Promise<any[]> {
    // Get the appointment details
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        appointmentDate: true,
        selectedSlotTime: true,
        doctorId: true,
        status: true
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    if (appointment.doctorId) {
      throw new BadRequestException('Appointment already has a doctor assigned');
    }

    if (!appointment.selectedSlotTime) {
      throw new BadRequestException('Appointment does not have a selected slot time');
    }

    // Find all available slots for the appointment date and time
    const availableSlots = await this.prisma.slot.findMany({
      where: {
        isAvailable: true,
        startTime: appointment.selectedSlotTime,
        schedule: {
          date: appointment.appointmentDate
        }
      },
      include: {
        schedule: {
          include: {
            doctor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                specialization: true,
                licenseNumber: true,
                isActive: true,
                isAvailable: true
              }
            }
          }
        }
      }
    });

    // Filter out inactive or unavailable doctors and format the response
    const availableDoctors = availableSlots
      .filter(slot => slot.schedule.doctor.isActive && slot.schedule.doctor.isAvailable)
      .map(slot => ({
        id: slot.schedule.doctor.id,
        firstName: slot.schedule.doctor.firstName,
        lastName: slot.schedule.doctor.lastName,
        specialization: slot.schedule.doctor.specialization,
        licenseNumber: slot.schedule.doctor.licenseNumber,
        slotId: slot.id,
        slotStartTime: slot.startTime,
        slotEndTime: slot.endTime
      }));

    return availableDoctors;
  }

  /**
   * Assign doctor and slot to an appointment
   */
  async assignDoctorToAppointment(assignDoctorDto: any): Promise<AppointmentResponseDto> {
    const { appointmentId, doctorId, slotId } = assignDoctorDto;

    // Get the appointment with all relations
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            primaryEmail: true
          }
        },
        service: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    if (appointment.doctorId) {
      throw new BadRequestException('Appointment already has a doctor assigned');
    }

    // Verify the slot exists and is available
    const slot = await this.prisma.slot.findUnique({
      where: { id: slotId },
      include: {
        schedule: {
          include: {
            doctor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                isActive: true,
                isAvailable: true
              }
            }
          }
        }
      }
    });

    if (!slot) {
      throw new NotFoundException('Slot not found');
    }

    if (!slot.isAvailable) {
      throw new BadRequestException('Slot is not available');
    }

    if (slot.schedule.doctor.id !== doctorId) {
      throw new BadRequestException('Slot does not belong to the specified doctor');
    }

    if (!slot.schedule.doctor.isActive || !slot.schedule.doctor.isAvailable) {
      throw new BadRequestException('Doctor is not available');
    }

    // Update the appointment with doctor and slot.
    // Keep status as PENDING — it becomes CONFIRMED only after payment is confirmed.
    const updatedAppointment = await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        doctorId: doctorId,
        slotId: slotId,
        // Do not change status here; payment confirmation sets it to CONFIRMED
      },
      include: {
        patient: true,
        doctor: true,
        service: true,
        slot: {
          include: {
            schedule: true
          }
        },
        medicalForm: true
      }
    });

    // Update slot availability to false
    await this.prisma.slot.update({
      where: { id: slotId },
      data: {
        isAvailable: false
      }
    });

    // Do not send email on assignment; emails are sent after payment confirmation

    return updatedAppointment;
  }

  /**
   * Build a default appointment reminder email (subject + HTML body) populated
   * with the appointment's actual details. Returned so the admin UI can preview
   * and optionally edit before sending.
   */
  async getManualReminderPreview(
    appointmentId: string,
  ): Promise<{
    subject: string;
    html: string;
    text: string;
    recipientEmail: string;
    patientName: string;
    appointmentSummary: {
      doctor: string;
      service: string;
      date: string;
      time: string;
      timezone: string;
      googleMeetLink: string | null;
    };
  }> {
    const appt: any = await this.findById(appointmentId);
    if (!appt) {
      throw new NotFoundException('Appointment not found');
    }

    const patient = appt.patient || {};
    const doctor = appt.doctor || {};
    const service = appt.service || {};
    const patientName = `${patient.firstName ?? ''} ${patient.lastName ?? ''}`.trim() || 'Patient';
    const doctorName = `Dr. ${doctor.firstName ?? ''} ${doctor.lastName ?? ''}`.trim();
    const serviceName = service.name || 'your appointment';
    const recipientEmail = patient.email || '';

    // Date / time formatting — mirror the confirmation email logic for consistency
    // appointmentDate may come back as a Date object (Prisma) OR a string; normalize to YYYY-MM-DD.
    const apptDateRaw = appt.appointmentDate;
    const apptDate: string =
      apptDateRaw instanceof Date
        ? apptDateRaw.toISOString().slice(0, 10)
        : typeof apptDateRaw === 'string'
          ? apptDateRaw.slice(0, 10)
          : '';
    const apptTime: string = typeof appt.appointmentTime === 'string' ? appt.appointmentTime : '';
    const [yy, mo, dd] = apptDate.split('-').map(Number);
    const [hh, mm] = apptTime.split(':').map(Number);
    const utcDate = new Date(Date.UTC(yy || 1970, (mo || 1) - 1, dd || 1, hh || 0, mm || 0, 0));
    const tz = doctor?.timezone || 'America/Chicago';

    const timeFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true,
    });
    const dateFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const displayTime = timeFmt.format(utcDate);
    const displayDate = dateFmt.format(utcDate);
    const tzAbbr = (this.mailerService as any).getTimezoneAbbreviation?.(tz, utcDate) || '';

    const meetLink: string | null = appt.googleMeetLink || null;

    const subject = `Reminder: Your appointment with ${doctorName || 'your provider'} — ${displayDate}`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:Arial,sans-serif;line-height:1.6;margin:0;padding:20px;background:#f4f4f4;color:#333;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);overflow:hidden;">
    <div style="background:#000;padding:25px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:24px;">OptimaleMD</h1>
      <p style="color:#ef4444;margin:8px 0 0;font-size:14px;letter-spacing:1px;">APPOINTMENT REMINDER</p>
    </div>
    <div style="padding:30px;">
      <p>Hi <strong>${patientName}</strong>,</p>
      <p>This is a friendly reminder of your upcoming appointment with OptimaleMD.</p>
      <div style="background:#f9f9f9;border-left:4px solid #ef4444;padding:16px 20px;margin:20px 0;border-radius:4px;">
        <p style="margin:0 0 8px;"><strong>Provider:</strong> ${doctorName || '—'}</p>
        <p style="margin:0 0 8px;"><strong>Service:</strong> ${serviceName}</p>
        <p style="margin:0 0 8px;"><strong>Date:</strong> ${displayDate}</p>
        <p style="margin:0;"><strong>Time:</strong> ${displayTime}${tzAbbr ? ` (${tzAbbr})` : ''}</p>
      </div>
      ${meetLink ? `<p style="text-align:center;margin:24px 0;"><a href="${meetLink}" style="display:inline-block;background:#ef4444;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Join Video Visit</a></p>` : ''}
      <p>If you need to reschedule or have any questions, please reach out to us right away.</p>
      <p style="margin-top:30px;">See you soon,<br><strong>The OptimaleMD Team</strong></p>
    </div>
    <div style="background:#f4f4f4;padding:16px;text-align:center;color:#999;font-size:12px;">
      <p style="margin:0;">This is an automated reminder. Please do not reply directly to this email.</p>
    </div>
  </div>
</body></html>`;

    const text = `Hi ${patientName},

This is a friendly reminder of your upcoming appointment with OptimaleMD.

Provider: ${doctorName || '—'}
Service: ${serviceName}
Date: ${displayDate}
Time: ${displayTime}${tzAbbr ? ` (${tzAbbr})` : ''}
${meetLink ? `\nJoin link: ${meetLink}\n` : ''}
If you need to reschedule or have questions, please reach out to us right away.

See you soon,
The OptimaleMD Team`;

    return {
      subject,
      html,
      text,
      recipientEmail,
      patientName,
      appointmentSummary: {
        doctor: doctorName,
        service: serviceName,
        date: displayDate,
        time: `${displayTime}${tzAbbr ? ` (${tzAbbr})` : ''}`,
        timezone: tz,
        googleMeetLink: meetLink,
      },
    };
  }

  /**
   * Send a manual reminder email. Admin can override recipient/subject/html/text.
   */
  async sendManualReminder(
    appointmentId: string,
    overrides: { recipientEmail?: string; subject?: string; html?: string; text?: string },
  ): Promise<{ sentTo: string; subject: string }> {
    const preview = await this.getManualReminderPreview(appointmentId);

    const to = (overrides.recipientEmail || preview.recipientEmail || '').trim();
    if (!to) {
      throw new BadRequestException('Recipient email is required');
    }
    const subject = (overrides.subject || preview.subject).trim();
    if (!subject) {
      throw new BadRequestException('Subject is required');
    }
    const html = overrides.html || preview.html;
    const text = overrides.text || preview.text;

    await this.mailerService.sendEmail(to, subject, text, html);

    return { sentTo: to, subject };
  }
}
