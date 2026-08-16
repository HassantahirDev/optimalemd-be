import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateDoctorDto,
  UpdateDoctorDto,
  QueryDoctorsDto,
  DoctorResponseDto,
  DoctorWithUserResponseDto,
  DoctorWithServicesResponseDto,
} from './dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class DoctorsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create doctor profile
   */
  async createDoctor(createDoctorDto: CreateDoctorDto): Promise<DoctorResponseDto> {
    const {
      email,
      password,
      title,
      firstName,
      middleName,
      lastName,
      dateOfBirth,
      gender,
      completeAddress,
      city,
      state,
      zipcode,
      alternativeEmail,
      primaryPhone,
      alternativePhone,
      licenseNumber,
      specialization,
      qualifications,
      experience,
      bio,
      consultationFee
      // workingHours - removed, now using WorkingHours model
    } = createDoctorDto;

    // Check if email is already taken
    const existingDoctor = await this.prisma.doctor.findUnique({
      where: { email }
    });
    if (existingDoctor) {
      throw new ConflictException('Email is already registered');
    }

    // Check if license number is already taken
    const existingLicense = await this.prisma.doctor.findUnique({
      where: { licenseNumber }
    });
    if (existingLicense) {
      throw new ConflictException('License number is already registered');
    }

    // Working hours validation removed - now using WorkingHours model

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create doctor profile
    const doctor = await this.prisma.doctor.create({
      data: {
        email,
        password: hashedPassword,
        title,
        firstName,
        middleName,
        lastName,
        dateOfBirth: new Date(dateOfBirth),
        gender,
        completeAddress,
        city,
        state,
        zipcode,
        alternativeEmail,
        primaryPhone,
        alternativePhone,
        licenseNumber,
        specialization,
        qualifications,
        experience,
        bio,
        consultationFee: parseFloat(consultationFee),
        // workingHours removed - now using WorkingHours model
        isAvailable: true,
        isActive: true,
        isVerified: false
      }
    });

    return doctor;
  }

  /**
   * Get doctor by ID
   */
  async findById(id: string): Promise<DoctorWithUserResponseDto> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id }
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    return doctor;
  }

  /**
   * Get doctor with services
   */
  async findByIdWithServices(id: string): Promise<DoctorWithServicesResponseDto> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id },
      include: {
        services: {
          include: {
            service: {
              select: {
                id: true,
                name: true,
                category: true,
                duration: true,
                basePrice: true,
              }
            }
          }
        }
      }
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    return doctor;
  }

  /**
   * Get doctors with filtering and pagination
   */
  async findAll(query: QueryDoctorsDto): Promise<{ doctors: DoctorWithUserResponseDto[], total: number }> {
    const { specialization, city, state, isAvailable, isVerified, serviceId, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (specialization) where.specialization = { contains: specialization, mode: 'insensitive' };
    if (isAvailable !== undefined) where.isAvailable = isAvailable === 'true';
    if (isVerified !== undefined) where.isVerified = isVerified === 'true';

    // Filter by location
    if (city || state) {
      if (city) where.city = { contains: city, mode: 'insensitive' };
      if (state) where.state = { contains: state, mode: 'insensitive' };
    }

    // Filter by service
    if (serviceId) {
      where.services = {
        some: {
          serviceId,
          isAvailable: true
        }
      };
    }

    const [doctors, total] = await Promise.all([
      this.prisma.doctor.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { isVerified: 'desc' },
          { experience: 'desc' },
          { createdAt: 'desc' }
        ]
      }),
      this.prisma.doctor.count({ where })
    ]);

    return { doctors, total };
  }

  /**
   * Update doctor profile
   */
  async updateDoctor(id: string, updateDoctorDto: UpdateDoctorDto): Promise<DoctorResponseDto> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id }
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    // Prepare update data
    const updateData: any = { ...updateDoctorDto };

    // Convert date string to Date object if provided
    if (updateDoctorDto.dateOfBirth) {
      updateData.dateOfBirth = new Date(updateDoctorDto.dateOfBirth);
    }

    // Convert consultation fee to number if provided
    if (updateDoctorDto.consultationFee) {
      updateData.consultationFee = parseFloat(updateDoctorDto.consultationFee);
    }

    // Working hours validation removed - now using WorkingHours model

    const updatedDoctor = await this.prisma.doctor.update({
      where: { id },
      data: updateData
    });

    return updatedDoctor;
  }

  /**
   * Get doctor availability for a specific date
   */
  async getDoctorAvailability(doctorId: string, date: string, serviceId?: string): Promise<any> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      include: {
        services: serviceId ? {
          where: { serviceId, isAvailable: true },
          include: {
            service: {
              select: {
                id: true,
                name: true,
                duration: true,
              }
            }
          }
        } : false
      }
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    if (!doctor.isAvailable || !doctor.isActive) {
      throw new BadRequestException('Doctor is not available');
    }

    // Get schedules for the specified date
    const schedules = await this.prisma.schedule.findMany({
      where: {
        doctorId,
        date: new Date(date),
        isAvailable: true
      },
      include: {
        slots: {
          where: { isAvailable: true },
          orderBy: { startTime: 'asc' }
        }
      },
      orderBy: { startTime: 'asc' }
    });

    // Working hours logic removed - now using WorkingHours model
    // This method should be updated to use the new working hours system

    return {
      doctor: {
        id: doctor.id,
        specialization: doctor.specialization,
        consultationFee: doctor.consultationFee,
        // workingHours removed - now using WorkingHours model
        services: doctor.services
      },
      schedules,
      availableSlots: schedules.flatMap(schedule => schedule.slots)
    };
  }

  /**
   * Get doctor schedule for a date range
   */
  async getDoctorSchedule(doctorId: string, startDate: string, endDate: string): Promise<any> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId }
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    const schedules = await this.prisma.schedule.findMany({
      where: {
        doctorId,
        date: {
          gte: new Date(startDate),
          lte: new Date(endDate)
        }
      },
      include: {
        slots: {
          orderBy: { startTime: 'asc' }
        }
      },
      orderBy: { date: 'asc' }
    });

    return {
      doctor: {
        id: doctor.id,
        specialization: doctor.specialization,
        // workingHours removed - now using WorkingHours model
      },
      schedules
    };
  }

  /**
   * Search doctors by specialization or location
   */
  async searchDoctors(searchTerm: string, filters?: any): Promise<DoctorWithUserResponseDto[]> {
    const where: any = {
      OR: [
        { specialization: { contains: searchTerm, mode: 'insensitive' } },
        { city: { contains: searchTerm, mode: 'insensitive' } },
        { state: { contains: searchTerm, mode: 'insensitive' } }
      ],
      isActive: true,
      isAvailable: true
    };

    if (filters?.specialization) {
      where.specialization = { contains: filters.specialization, mode: 'insensitive' };
    }

    if (filters?.city) {
      where.city = { contains: filters.city, mode: 'insensitive' };
    }

    if (filters?.state) {
      where.state = { contains: filters.state, mode: 'insensitive' };
    }

    if (filters?.serviceId) {
      where.services = {
        some: {
          serviceId: filters.serviceId,
          isAvailable: true
        }
      };
    }

    return this.prisma.doctor.findMany({
      where,
      orderBy: [
        { isVerified: 'desc' },
        { experience: 'desc' }
      ],
      take: 20
    });
  }

  /**
   * Get doctor statistics
   */
  async getDoctorStats(doctorId?: string): Promise<any> {
    const where: any = {};
    if (doctorId) where.id = doctorId;

    const [totalDoctors, verifiedDoctors, availableDoctors] = await Promise.all([
      this.prisma.doctor.count(),
      this.prisma.doctor.count({ where: { isVerified: true } }),
      this.prisma.doctor.count({ where: { isAvailable: true, isActive: true } })
    ]);

    // Get specialization distribution
    const specializations = await this.prisma.doctor.groupBy({
      by: ['specialization'],
      _count: { specialization: true },
      orderBy: { _count: { specialization: 'desc' } },
      take: 10
    });

    return {
      total: totalDoctors,
      verified: verifiedDoctors,
      available: availableDoctors,
      verificationRate: totalDoctors > 0 ? (verifiedDoctors / totalDoctors) * 100 : 0,
      availabilityRate: totalDoctors > 0 ? (availableDoctors / totalDoctors) * 100 : 0,
      specializations: specializations.map(s => ({
        specialization: s.specialization,
        count: s._count.specialization
      }))
    };
  }

  /**
   * Verify doctor profile
   */
  async verifyDoctor(id: string): Promise<DoctorResponseDto> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id }
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    if (doctor.isVerified) {
      throw new BadRequestException('Doctor is already verified');
    }

    const updatedDoctor = await this.prisma.doctor.update({
      where: { id },
      data: { isVerified: true }
    });

    return updatedDoctor;
  }

  /**
   * Delete doctor profile
   */
  async deleteDoctor(id: string): Promise<void> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id },
      include: {
        appointments: { where: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } },
        schedules: { include: { slots: true } }
      }
    });

    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }

    // Check if doctor has active appointments
    if (doctor.appointments.length > 0) {
      throw new BadRequestException('Cannot delete doctor with active appointments');
    }

    // Use transaction to ensure data consistency
    await this.prisma.$transaction(async (prisma) => {
      // Delete all schedules and slots
      for (const schedule of doctor.schedules) {
        await prisma.slot.deleteMany({
          where: { scheduleId: schedule.id }
        });
      }
      await prisma.schedule.deleteMany({
        where: { doctorId: id }
      });

      // Delete doctor services
      await prisma.doctorService.deleteMany({
        where: { doctorId: id }
      });

      // Delete doctor profile
      await prisma.doctor.delete({
        where: { id }
      });
    });
  }

  // validateWorkingHours method removed - now using WorkingHours model

  /**
   * Get dashboard statistics for a doctor
   */
  async getDashboardStats(doctorId: string): Promise<any> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get today's appointments
    const todaysAppointments = await this.prisma.appointment.count({
      where: {
        doctorId,
        appointmentDate: {
          gte: today,
          lt: tomorrow
        }
      }
    });

    // Get upcoming appointments (next 7 days)
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const upcomingAppointments = await this.prisma.appointment.count({
      where: {
        doctorId,
        appointmentDate: {
          gte: tomorrow,
          lt: nextWeek
        },
        status: {
          in: ['CONFIRMED', 'PENDING']
        }
      }
    });

    // Get no-show appointments today
    const noShowToday = await this.prisma.appointment.count({
      where: {
        doctorId,
        appointmentDate: {
          gte: today,
          lt: tomorrow
        },
        status: 'NO_SHOW'
      }
    });

    // Get patients in queue (appointments with status IN_PROGRESS or CHECKED_IN)
    const patientsInQueue = await this.prisma.appointment.count({
      where: {
        doctorId,
        appointmentDate: {
          gte: today,
          lt: tomorrow
        },
        status: {
          in: ['IN_PROGRESS']
        }
      }
    });

    // Get labs to review (this would need to be implemented based on your lab results system)
    const labsToReview = 0; // Placeholder - implement based on your lab results system

    // Get messages awaiting reply
    const messagesAwaitingReply = await this.prisma.message.count({
      where: {
        receiverId: doctorId,
        receiverType: 'doctor',
        isRead: false
      }
    });

    // Calculate urgent tasks
    const urgentTasks: string[] = [];
    if (labsToReview > 0) urgentTasks.push(`${labsToReview} overdue labs`);
    if (noShowToday > 0) urgentTasks.push(`${noShowToday} no-show`);
    if (messagesAwaitingReply > 0) urgentTasks.push(`${messagesAwaitingReply} unread messages`);

    const urgentTasksSummary = urgentTasks.length > 0 ? urgentTasks.join(', ') : 'No urgent tasks';
    const hasUrgentTasks = urgentTasks.length > 0;

    return {
      todaysAppointments,
      labsToReview,
      messagesAwaitingReply,
      upcomingAppointments,
      patientsInQueue,
      noShowToday,
      urgentTasksSummary,
      hasUrgentTasks
    };
  }

  /**
   * Unified "Action Center" for the doctor dashboard. Server-aggregated task
   * queue — one call returns every actionable bucket with a count and a small
   * preview list, so the dashboard renders a single prioritized to-do surface
   * instead of stitching many endpoints together on the client.
   */
  async getActionCenter(doctorId: string): Promise<any> {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);

    const patientSelect = {
      select: { id: true, firstName: true, lastName: true, photoPath: true },
    };
    const apptSelect = {
      id: true,
      appointmentDate: true,
      appointmentTime: true,
      status: true,
      notesSignedAt: true,
      googleMeetLink: true,
      patient: patientSelect,
      service: { select: { name: true } },
    };

    const [
      visitsToDocument,
      unassignedCompleted,
      pendingBookings,
      unreadMessages,
      todaySchedule,
      inQueue,
    ] = await Promise.all([
      // 1) My completed visits whose notes aren't signed yet (need documentation).
      this.prisma.appointment.findMany({
        where: {
          doctorId,
          status: 'COMPLETED',
          notesSignedAt: null,
        },
        select: apptSelect,
        orderBy: { appointmentDate: 'desc' },
        take: 50,
      }),
      // 2) Completed appointments sitting UNASSIGNED (no doctor) — need pickup.
      this.prisma.appointment.findMany({
        where: {
          doctorId: null,
          status: 'COMPLETED',
        },
        select: apptSelect,
        orderBy: { appointmentDate: 'desc' },
        take: 50,
      }),
      // 3) Booking requests awaiting my response.
      this.prisma.booking.findMany({
        where: { doctorId, status: 'PENDING' as any },
        select: {
          id: true,
          preferredDate: true,
          preferredTime: true,
          urgency: true,
          requestedAt: true,
          patient: patientSelect,
          service: { select: { name: true } },
        },
        orderBy: { requestedAt: 'desc' },
        take: 50,
      }),
      // 4) Unread messages addressed to me.
      this.prisma.message.count({
        where: { receiverId: doctorId, receiverType: 'doctor', isRead: false },
      }),
      // 5) Today's schedule.
      this.prisma.appointment.findMany({
        where: {
          doctorId,
          appointmentDate: { gte: startOfToday, lt: endOfToday },
          status: { in: ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'] as any },
        },
        select: apptSelect,
        orderBy: { appointmentTime: 'asc' },
        take: 50,
      }),
      // 6) Patients currently checked-in / in progress.
      this.prisma.appointment.findMany({
        where: {
          doctorId,
          appointmentDate: { gte: startOfToday, lt: endOfToday },
          status: 'IN_PROGRESS',
        },
        select: apptSelect,
        orderBy: { appointmentTime: 'asc' },
        take: 20,
      }),
    ]);

    const bucket = (items: any[], limit = 8, count?: number) => ({
      count: count ?? items.length,
      items: items.slice(0, limit),
    });

    return {
      // Notes-to-sign is the dashboard's primary surface — return a longer list.
      visitsToDocument: bucket(visitsToDocument, 50),
      unassignedCompleted: bucket(unassignedCompleted),
      pendingBookings: bucket(pendingBookings as any[]),
      unreadMessages: { count: unreadMessages, items: [] },
      todaySchedule: bucket(todaySchedule, 50),
      inQueue: bucket(inQueue),
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Helper method to get DOB search conditions - same as admin
   */
  private getDobSearchConditions(searchTerm: string): any[] {
    const conditions: any[] = [];
    
    // Try to parse different date formats
    const dateFormats = [
      // MM-DD-YYYY or MM/DD/YYYY or DD-MM-YYYY or DD/MM/YYYY
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
            // MM-DD-YYYY or DD-MM-YYYY - try both interpretations
            const firstNum = parseInt(match[1]);
            const secondNum = parseInt(match[2]);
            year = parseInt(match[3]);
            
            // Try both MM-DD and DD-MM
            const date1Valid = firstNum >= 1 && firstNum <= 12 && secondNum >= 1 && secondNum <= 31;
            const date2Valid = secondNum >= 1 && secondNum <= 12 && firstNum >= 1 && firstNum <= 31;
            
            if (date1Valid) {
              // Try MM-DD-YYYY
              month = firstNum;
              day = secondNum;
              
              if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
                try {
                  const searchDate = new Date(year, month - 1, day);
                  if (searchDate.getFullYear() === year && searchDate.getMonth() === month - 1 && searchDate.getDate() === day) {
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
                  // Invalid date, try next
                }
              }
            }
            
            if (date2Valid && firstNum !== secondNum) {
              // Try DD-MM-YYYY
              month = secondNum;
              day = firstNum;
              
              if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
                try {
                  const searchDate = new Date(year, month - 1, day);
                  if (searchDate.getFullYear() === year && searchDate.getMonth() === month - 1 && searchDate.getDate() === day) {
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
            }
            break; // Exit format loop after trying both interpretations
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

        // Validate the date (for non-ambiguous formats)
        if (!format.source.includes('[-/].*[-/]')) {
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
            try {
              const searchDate = new Date(year, month - 1, day);
              if (searchDate.getFullYear() === year && searchDate.getMonth() === month - 1 && searchDate.getDate() === day) {
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
   * Get patients for a doctor
   */
  async getDoctorPatients(doctorId: string, query: { search?: string; page: number; limit: number }): Promise<any> {
    const { search, page, limit } = query;
    const skip = (page - 1) * limit;

    // Build search conditions for appointments
    const where: any = {
      doctorId
    };

    if (search) {
      const searchConditions = [
        {
          patient: {
            firstName: {
              contains: search,
              mode: 'insensitive'
            }
          }
        },
        {
          patient: {
            lastName: {
              contains: search,
              mode: 'insensitive'
            }
          }
        },
        {
          patient: {
            primaryEmail: {
              contains: search,
              mode: 'insensitive'
            }
          }
        },
        {
          patient: {
            primaryPhone: {
              contains: search,
              mode: 'insensitive'
            }
          }
        }
      ];

      // Add DOB search conditions
      const dobSearchConditions = this.getDobSearchConditions(search);
      if (dobSearchConditions.length > 0) {
        dobSearchConditions.forEach(dobCondition => {
          searchConditions.push({
            patient: dobCondition
          });
        });
      }

      where.OR = searchConditions;
    }

    // Get all appointments with patient info and medical forms
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
              primaryPhone: true,
              dateOfBirth: true,
            }
          },
          doctor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true
            }
          },
          service: {
            select: {
              name: true
            }
          },
          medicalForm: true
        },
        orderBy: [
          { appointmentDate: 'desc' },
          { appointmentTime: 'desc' }
        ]
      }),
      this.prisma.appointment.count({ where })
    ]);

    // Helper function to check if appointment has passed
    const hasAppointmentPassed = (appointmentDate: Date, appointmentTime: string): boolean => {
      const now = new Date();
      const aptDate = new Date(appointmentDate);
      
      // Parse the time (HH:MM format)
      const [hours, minutes] = appointmentTime.split(':').map(Number);
      aptDate.setHours(hours, minutes, 0, 0);
      
      return aptDate < now;
    };

    // Group appointments by patient
    const patientMap = new Map<string, any>();
    
    appointments.forEach((appointment) => {
      const patient = appointment.patient;
      const patientId = patient.id;

      if (!patientMap.has(patientId)) {
        const age = patient.dateOfBirth ? this.calculateAge(patient.dateOfBirth) : 0;
        
        patientMap.set(patientId, {
          id: patient.id,
          name: `${patient.firstName} ${patient.lastName}`,
          age,
          mrn: patient.id.substring(0, 8),
          email: patient.primaryEmail,
          phone: patient.primaryPhone,
          dateOfBirth: patient.dateOfBirth,
          appointments: [],
          totalAppointments: 0,
          lastVisit: '-',
          lastVisitTime: 'N/A',
          lastVisitStatus: 'N/A',
          lastVisitPurpose: 'N/A',
          appointmentId: null,
          appointmentDate: null,
          appointmentTime: null,
          appointmentStatus: null,
          medicalForm: null,
        });
      }

      const patientData = patientMap.get(patientId);
      // Format services (primary + additional)
      const additionalServices = (appointment as any).additionalServices as Array<{ id: string; name: string; duration: number }> | null;
      const allServices = appointment.service?.name 
        ? (additionalServices && Array.isArray(additionalServices) && additionalServices.length > 0
            ? `${appointment.service.name}, ${additionalServices.map(s => s.name).join(', ')}`
            : appointment.service.name)
        : 'N/A';
      
      patientData.appointments.push({
        id: appointment.id,
        date: this.formatDate(appointment.appointmentDate),
        time: appointment.appointmentTime || 'N/A',
        status: appointment.status || 'N/A',
        purpose: allServices,
        appointmentDate: appointment.appointmentDate,
        appointmentTime: appointment.appointmentTime,
        medicalForm: appointment.medicalForm,
        additionalServices: additionalServices || null, // Include additional services in response
        googleMeetLink: appointment.googleMeetLink || null,
        doctor: appointment.doctor ? {
          id: appointment.doctor.id,
          firstName: appointment.doctor.firstName,
          lastName: appointment.doctor.lastName,
          email: appointment.doctor.email
        } : null,
        notesSignedAt: (appointment as any).notesSignedAt || null,
        medications: (appointment as any).medications || null,
        service: appointment.service ? {
          name: appointment.service.name
        } : null,
      });
      patientData.totalAppointments = patientData.appointments.length;

      // Check if this appointment has passed and update last visit if it's the first (most recent) past appointment
      // Since appointments are ordered DESC, the first one that has passed is the most recent past appointment
      const appointmentHasPassed = hasAppointmentPassed(appointment.appointmentDate, appointment.appointmentTime);
      
      if (appointmentHasPassed && patientData.lastVisit === '-') {
        // This is the most recent past appointment (first one in DESC order that has passed)
        // Format services (primary + additional) for last visit purpose
        const lastVisitAdditionalServices = (appointment as any).additionalServices as Array<{ id: string; name: string; duration: number }> | null;
        const lastVisitAllServices = appointment.service?.name 
          ? (lastVisitAdditionalServices && Array.isArray(lastVisitAdditionalServices) && lastVisitAdditionalServices.length > 0
              ? `${appointment.service.name}, ${lastVisitAdditionalServices.map(s => s.name).join(', ')}`
              : appointment.service.name)
          : 'N/A';
        
        patientData.lastVisit = this.formatDate(appointment.appointmentDate);
        patientData.lastVisitTime = appointment.appointmentTime || 'N/A';
        patientData.lastVisitStatus = appointment.status || 'N/A';
        patientData.lastVisitPurpose = lastVisitAllServices;
        patientData.appointmentId = appointment.id;
        patientData.appointmentDate = appointment.appointmentDate;
        patientData.appointmentTime = appointment.appointmentTime;
        patientData.appointmentStatus = appointment.status;
        patientData.medicalForm = appointment.medicalForm;
        
        console.log(`Set last visit for ${patientData.name}: ${patientData.lastVisit} at ${patientData.lastVisitTime}`);
      }
    });

    // Convert map to array and paginate
    const allPatients = Array.from(patientMap.values());
    const totalUniquePatients = allPatients.length;
    const paginatedPatients = allPatients.slice(skip, skip + limit);

    console.log('Total unique patients:', totalUniquePatients);
    console.log('Patients with last visits:', paginatedPatients.map(p => ({
      name: p.name,
      lastVisit: p.lastVisit,
      totalAppointments: p.totalAppointments
    })));

    return {
      patients: paginatedPatients,
      total: totalUniquePatients,
      page,
      limit,
      totalPages: Math.ceil(totalUniquePatients / limit)
    };
  }

  async changeOwnPassword(doctorId: string, currentPassword: string, newPassword: string) {
    const doctor = await this.prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) throw new NotFoundException('Doctor not found');

    const isValid = await bcrypt.compare(currentPassword, doctor.password);
    if (!isValid) throw new BadRequestException('Current password is incorrect');

    const errors: string[] = [];
    if (newPassword.length < 8) errors.push('at least 8 characters');
    if (!/[A-Z]/.test(newPassword)) errors.push('an uppercase letter');
    if (!/[a-z]/.test(newPassword)) errors.push('a lowercase letter');
    if (!/[0-9]/.test(newPassword)) errors.push('a number');
    if (!/[^A-Za-z0-9]/.test(newPassword)) errors.push('a special character');
    if (errors.length > 0) throw new BadRequestException(`Password must contain: ${errors.join(', ')}`);

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.doctor.update({ where: { id: doctorId }, data: { password: hashed } });
    return { message: 'Password changed successfully' };
  }

  private calculateAge(dateOfBirth: Date): number {
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  }

  private formatDate(date: Date): string {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }
}
