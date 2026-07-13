import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateWorkingHoursDto,
  CreateMultipleWorkingHoursDto,
  UpdateWorkingHoursDto,
  QueryWorkingHoursDto,
  WorkingHoursResponseDto,
  WorkingHoursWithDoctorDto,
  GenerateScheduleFromWorkingHoursDto,
} from './dto';
import { dateStringToUTC, isDateInPast, addDaysUTC, getUTCDayOfWeek, toISODateString } from '../common/utils/timezone.utils';
import { localTimeToUTC, utcToLocalTime, isValidTimezone } from '../common/utils/timezone-converter.utils';

@Injectable()
export class WorkingHoursService {
  constructor(
    private prisma: PrismaService
  ) {}

  /**
   * Create working hours for a specific day
   * Times are converted from doctor's local timezone to UTC before storing
   */
  async createWorkingHours(createWorkingHoursDto: CreateWorkingHoursDto): Promise<WorkingHoursResponseDto> {
    const { doctorId, dayOfWeek, startTime, endTime, slotDuration, breakDuration, isActive = true, timezone } = createWorkingHoursDto;

    // Check if doctor exists and is active
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, isActive: true, isAvailable: true }
    });
    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }
    if (!doctor.isActive || !doctor.isAvailable) {
      throw new BadRequestException('Doctor is not available for scheduling');
    }

    // Validate timezone if provided
    const doctorTimezone = timezone || 'UTC';
    if (timezone && !isValidTimezone(timezone)) {
      throw new BadRequestException(`Invalid timezone: ${timezone}`);
    }

    // Validate time format and logic
    if (!this.isValidTimeFormat(startTime) || !this.isValidTimeFormat(endTime)) {
      throw new BadRequestException('Invalid time format. Use HH:MM format');
    }

    // Allow time ranges that cross midnight (endTime < startTime indicates next day in UTC)
    // This happens when local time converts to UTC and crosses midnight
    // Example: 10 AM - 7 PM CST = 16:00 - 01:00 UTC (next day)
    if (!this.isValidTimeRange(startTime, endTime, true)) {
      throw new BadRequestException('Invalid time range');
    }

    // Convert local time to UTC
    let utcStartTime = startTime;
    let utcEndTime = endTime;
    
    // if (timezone && timezone !== 'UTC') {
    //   try {
    //     utcStartTime = localTimeToUTC(startTime, doctorTimezone);
    //     utcEndTime = localTimeToUTC(endTime, doctorTimezone);
        
    //     console.log(`📅 Working Hours Timezone Conversion:`);
    //     console.log(`   Doctor timezone: ${doctorTimezone}`);
    //     console.log(`   Local time: ${startTime} - ${endTime}`);
    //     console.log(`   UTC time: ${utcStartTime} - ${utcEndTime}`);
    //   } catch (error) {
    //     throw new BadRequestException(`Timezone conversion failed: ${error.message}`);
    //   }
    // }

    // Check if working hours already exist for this day
    const existingWorkingHours = await this.prisma.workingHours.findUnique({
      where: {
        doctorId_dayOfWeek: {
          doctorId,
          dayOfWeek
        }
      }
    });

    if (existingWorkingHours) {
      throw new ConflictException('Working hours already exist for this day');
    }

    // Create working hours with UTC times
    const workingHours = await this.prisma.workingHours.create({
      data: {
        doctorId,
        dayOfWeek,
        startTime: utcStartTime,  // Store UTC time
        endTime: utcEndTime,      // Store UTC time
        slotDuration,
        breakDuration,
        isActive
      }
    });

    return workingHours;
  }

  /**
   * Create working hours for multiple days
   */
  async createMultipleWorkingHours(createMultipleWorkingHoursDto: CreateMultipleWorkingHoursDto): Promise<WorkingHoursResponseDto[]> {
    const { doctorId, workingHours } = createMultipleWorkingHoursDto;

    // Check if doctor exists and is active
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, isActive: true, isAvailable: true }
    });
    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }
    if (!doctor.isActive || !doctor.isAvailable) {
      throw new BadRequestException('Doctor is not available for scheduling');
    }

    // Validate all working hours
    for (const wh of workingHours) {
      if (!this.isValidTimeFormat(wh.startTime) || !this.isValidTimeFormat(wh.endTime)) {
        throw new BadRequestException(`Invalid time format for day ${wh.dayOfWeek}. Use HH:MM format`);
      }

      // Allow time ranges that cross midnight
      if (!this.isValidTimeRange(wh.startTime, wh.endTime, true)) {
        throw new BadRequestException(`Invalid time range for day ${wh.dayOfWeek}`);
      }
    }

    // Check for existing working hours
    const existingWorkingHours = await this.prisma.workingHours.findMany({
      where: {
        doctorId,
        dayOfWeek: { in: workingHours.map(wh => wh.dayOfWeek) }
      }
    });

    if (existingWorkingHours.length > 0) {
      const existingDays = existingWorkingHours.map(wh => wh.dayOfWeek);
      throw new ConflictException(`Working hours already exist for days: ${existingDays.join(', ')}`);
    }

    // Create all working hours
    const createdWorkingHours = await Promise.all(
      workingHours.map(wh =>
        this.prisma.workingHours.create({
          data: {
            doctorId,
            dayOfWeek: wh.dayOfWeek,
            startTime: wh.startTime,
            endTime: wh.endTime,
            slotDuration: wh.slotDuration,
            breakDuration: wh.breakDuration,
            isActive: wh.isActive ?? true
          }
        })
      )
    );

    return createdWorkingHours;
  }

  /**
   * Get working hours by ID
   */
  async findById(id: string): Promise<WorkingHoursResponseDto> {
    const workingHours = await this.prisma.workingHours.findUnique({
      where: { id }
    });

    if (!workingHours) {
      throw new NotFoundException('Working hours not found');
    }

    return workingHours;
  }

  /**
   * Get working hours with doctor info
   */
  async findByIdWithDoctorInfo(id: string): Promise<WorkingHoursWithDoctorDto> {
    const workingHours = await this.prisma.workingHours.findUnique({
      where: { id },
      include: {
        doctor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            specialization: true
          }
        }
      }
    });

    if (!workingHours) {
      throw new NotFoundException('Working hours not found');
    }

    return workingHours;
  }

  /**
   * Get working hours with filtering and pagination
   */
  async findAll(query: QueryWorkingHoursDto): Promise<{ workingHours: WorkingHoursResponseDto[], total: number }> {
    const { doctorId, dayOfWeek, isActive, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (doctorId) where.doctorId = doctorId;
    if (dayOfWeek !== undefined) where.dayOfWeek = dayOfWeek;
    if (isActive !== undefined) where.isActive = isActive;

    const [workingHours, total] = await Promise.all([
      this.prisma.workingHours.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { doctorId: 'asc' },
          { dayOfWeek: 'asc' }
        ]
      }),
      this.prisma.workingHours.count({ where })
    ]);

    return { workingHours, total };
  }

  /**
   * Update working hours
   */
  async updateWorkingHours(id: string, updateWorkingHoursDto: UpdateWorkingHoursDto): Promise<WorkingHoursResponseDto> {
    const workingHours = await this.prisma.workingHours.findUnique({
      where: { id }
    });

    if (!workingHours) {
      throw new NotFoundException('Working hours not found');
    }

    // Validate time format and logic if provided
    if (updateWorkingHoursDto.startTime && !this.isValidTimeFormat(updateWorkingHoursDto.startTime)) {
      throw new BadRequestException('Invalid start time format. Use HH:MM format');
    }

    if (updateWorkingHoursDto.endTime && !this.isValidTimeFormat(updateWorkingHoursDto.endTime)) {
      throw new BadRequestException('Invalid end time format. Use HH:MM format');
    }

    if (updateWorkingHoursDto.startTime && updateWorkingHoursDto.endTime) {
      // Allow time ranges that cross midnight
      if (!this.isValidTimeRange(updateWorkingHoursDto.startTime, updateWorkingHoursDto.endTime, true)) {
        throw new BadRequestException('Invalid time range');
      }
    }

    // Convert times to UTC if timezone is provided
    const updateData = { ...updateWorkingHoursDto };
    const timezone = updateWorkingHoursDto.timezone;
    
    if (timezone && timezone !== 'UTC') {
      // Validate timezone
      if (!isValidTimezone(timezone)) {
        throw new BadRequestException(`Invalid timezone: ${timezone}`);
      }

      // Convert times to UTC if they're being updated
      // if (updateWorkingHoursDto.startTime) {
      //   try {
      //     const utcStartTime = localTimeToUTC(updateWorkingHoursDto.startTime, timezone);
      //     updateData.startTime = utcStartTime;
      //     console.log(`🔄 Update: ${updateWorkingHoursDto.startTime} (${timezone}) → ${utcStartTime} (UTC)`);
      //   } catch (error) {
      //     throw new BadRequestException(`Failed to convert start time: ${error.message}`);
      //   }
      // }

      // if (updateWorkingHoursDto.endTime) {
      //   try {
      //     const utcEndTime = localTimeToUTC(updateWorkingHoursDto.endTime, timezone);
      //     updateData.endTime = utcEndTime;
      //     console.log(`🔄 Update: ${updateWorkingHoursDto.endTime} (${timezone}) → ${utcEndTime} (UTC)`);
      //   } catch (error) {
      //     throw new BadRequestException(`Failed to convert end time: ${error.message}`);
      //   }
      // }
      
      // Remove timezone from update data (it's not a database field)
      delete updateData.timezone;
    }

    const updatedWorkingHours = await this.prisma.workingHours.update({
      where: { id },
      data: updateData
    });

    return updatedWorkingHours;
  }

  /**
   * Delete working hours
   */
  async deleteWorkingHours(id: string): Promise<void> {
    const workingHours = await this.prisma.workingHours.findUnique({
      where: { id },
      include: {
        generatedSchedules: {
          include: {
            slots: {
              include: {
                appointment: true
              }
            }
          }
        }
      }
    });

    if (!workingHours) {
      throw new NotFoundException('Working hours not found');
    }

    // Check if there are any appointments in generated schedules
    const hasAppointments = workingHours.generatedSchedules.some(schedule =>
      schedule.slots.some(slot => slot.appointment)
    );

    if (hasAppointments) {
      throw new BadRequestException('Cannot delete working hours with existing appointments');
    }

    // Use transaction to ensure data consistency
    await this.prisma.$transaction(async (prisma) => {
      // Delete all generated schedules and their slots
      for (const schedule of workingHours.generatedSchedules) {
        await prisma.slot.deleteMany({
          where: { scheduleId: schedule.id }
        });
        await prisma.schedule.delete({
          where: { id: schedule.id }
        });
      }

      // Delete working hours
      await prisma.workingHours.delete({
        where: { id }
      });
    });
  }

  /**
   * Generate schedules from working hours for a date range
   * IMPORTANT: If timezone is provided, assumes working hours times are in LOCAL time and converts to UTC
   * If no timezone provided, assumes working hours times are already in UTC
   */
  async generateSchedulesFromWorkingHours(generateDto: GenerateScheduleFromWorkingHoursDto): Promise<any> {
    const { doctorId, startDate, endDate, regenerateExisting = false, timezone } = generateDto;

    // Check if doctor exists and is active
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { id: true, isActive: true, isAvailable: true }
    });
    if (!doctor) {
      throw new NotFoundException('Doctor not found');
    }
    if (!doctor.isActive || !doctor.isAvailable) {
      throw new BadRequestException('Doctor is not available for scheduling');
    }

    // Validate timezone if provided
    if (timezone && !isValidTimezone(timezone)) {
      throw new BadRequestException(`Invalid timezone: ${timezone}`);
    }

    // Validate date range
    const start = dateStringToUTC(startDate);
    const end = dateStringToUTC(endDate);
    if (start >= end) {
      throw new BadRequestException('Start date must be before end date');
    }

    if (isDateInPast(startDate)) {
      throw new BadRequestException('Start date cannot be in the past');
    }

    // Get all active working hours for the doctor
    const workingHours = await this.prisma.workingHours.findMany({
      where: {
        doctorId,
        isActive: true
      },
      orderBy: { dayOfWeek: 'asc' }
    });

    if (workingHours.length === 0) {
      throw new BadRequestException('No active working hours found for this doctor');
    }

    console.log(`📅 Generating schedules with timezone: ${timezone || 'UTC (no conversion)'}`);

    const generatedSchedules: any[] = [];
    let currentDate = new Date(start);

    while (currentDate <= end) {
      const dayOfWeek = getUTCDayOfWeek(currentDate);
      const workingHour = workingHours.find(wh => wh.dayOfWeek === dayOfWeek);

      if (workingHour) {
        try {
          // Check if schedule already exists for this date
          const existingSchedule = await this.prisma.schedule.findFirst({
            where: {
              doctorId,
              date: currentDate,
              workingHoursId: workingHour.id
            }
          });

          if (existingSchedule && !regenerateExisting) {
            console.log(`Schedule already exists for ${toISODateString(currentDate)}, skipping...`);
            currentDate = addDaysUTC(currentDate, 1);
            continue;
          }

          // Working hours are already stored in UTC, so use them directly
          // DO NOT convert again - they were converted when created
          const startTimeUTC = workingHour.startTime;
          const endTimeUTC = workingHour.endTime;

          // Check if times cross midnight (endTime < startTime in UTC)
          const [startHours, startMinutes] = startTimeUTC.split(':').map(Number);
          const [endHours, endMinutes] = endTimeUTC.split(':').map(Number);
          const crossesMidnight = endHours < startHours || (endHours === startHours && endMinutes < startMinutes);

          if (crossesMidnight) {
            console.log(`   Day ${dayOfWeek}: Working hours cross midnight in UTC: ${startTimeUTC}-${endTimeUTC} (will generate slots from ${startTimeUTC} to 23:59, then 00:00 to ${endTimeUTC})`);
          } else {
          console.log(`   Day ${dayOfWeek}: Using working hours times: ${startTimeUTC}-${endTimeUTC} (already in UTC)`);
          }

          // --- Double-booking guard --------------------------------------------
          // Load every active appointment for this doctor on this date, INCLUDING
          // custom / out-of-slot bookings (slotId = null). We must never generate
          // an available slot on top of a real booking.
          const dayAppointments = await this.prisma.appointment.findMany({
            where: {
              doctorId,
              appointmentDate: currentDate,
              status: { notIn: ['CANCELLED'] as any },
            },
            select: { appointmentTime: true, duration: true },
          });
          const bookedIntervals = dayAppointments
            .filter((a) => !!a.appointmentTime)
            .map((a) => {
              const s = this.timeToMinutes(a.appointmentTime as string);
              return { start: s, end: s + (a.duration || workingHour.slotDuration) };
            });

          // Prepare the target schedule. On regenerate we REUSE the schedule row
          // and delete only UNbooked slots — a Slot delete cascades to its
          // Appointment (onDelete: Cascade), so blindly deleting slots would
          // silently destroy confirmed/booked appointments.
          let scheduleId: string;
          const keptSlotStarts = new Set<string>();
          if (existingSchedule && regenerateExisting) {
            const bookedSlots = await this.prisma.slot.findMany({
              where: { scheduleId: existingSchedule.id, appointment: { some: {} } },
              select: { startTime: true },
            });
            bookedSlots.forEach((s) => keptSlotStarts.add(s.startTime));
            await this.prisma.slot.deleteMany({
              where: { scheduleId: existingSchedule.id, appointment: { none: {} } },
            });
            const updated = await this.prisma.schedule.update({
              where: { id: existingSchedule.id },
              data: { startTime: startTimeUTC, endTime: endTimeUTC, isAvailable: true },
            });
            scheduleId = updated.id;
          } else {
            const created = await this.prisma.schedule.create({
              data: {
                doctorId,
                workingHoursId: workingHour.id,
                date: currentDate,
                startTime: startTimeUTC,
                endTime: endTimeUTC,
                isAvailable: true,
                maxAppointments: 10,
                isAutoGenerated: true,
              },
            });
            scheduleId = created.id;
          }

          // Generate slots, then drop any that overlap an existing booking or
          // collide with a kept (booked) slot's start time.
          const candidateSlots = this.generateSlots(startTimeUTC, endTimeUTC, workingHour.slotDuration, workingHour.breakDuration);
          const slotsToCreate = candidateSlots.filter((s) => {
            if (keptSlotStarts.has(s.startTime)) return false; // booked slot already occupies this start
            const ss = this.timeToMinutes(s.startTime);
            const se = this.timeToMinutes(s.endTime);
            return !bookedIntervals.some((b) => ss < b.end && b.start < se);
          });

          if (slotsToCreate.length > 0) {
            await this.prisma.slot.createMany({
              data: slotsToCreate.map((slot) => ({
                scheduleId,
                startTime: slot.startTime,
                endTime: slot.endTime,
                isAvailable: true,
              })),
              skipDuplicates: true,
            });
          }

          const protectedCount = candidateSlots.length - slotsToCreate.length;
          if (protectedCount > 0) {
            console.log(`   Protected ${protectedCount} slot(s) from overlapping existing bookings on ${toISODateString(currentDate)}`);
          }
          if (crossesMidnight) {
            console.log(`   Generated ${slotsToCreate.length} slots (including midnight crossover)`);
          }

          const schedule = await this.prisma.schedule.findUnique({
            where: { id: scheduleId },
            include: { slots: true },
          });

          generatedSchedules.push(schedule);
        } catch (error) {
          console.warn(`Error generating schedule for ${toISODateString(currentDate)}: ${error.message}`);
        }
      }

      currentDate = addDaysUTC(currentDate, 1);
    }

    // Google Calendar sync removed - no longer needed
    const calendarSyncResult = {
      success: true,
      eventsCreated: 0,
      errors: []
    };

    return {
      doctorId,
      startDate,
      endDate,
      generatedSchedules,
      totalGenerated: generatedSchedules.length,
      calendarSync: calendarSyncResult
    };
  }

  /**
   * Generate time slots based on working hours
   * Handles the case where endTime < startTime (crosses midnight in UTC)
   * Example: 16:00 - 01:00 means 16:00 to 01:00 next day
   */
  // "HH:MM" -> minutes since midnight. Used for slot/appointment overlap checks.
  private timeToMinutes(time: string): number {
    const [h, m] = (time || '0:0').split(':').map((n) => parseInt(n, 10));
    return (h || 0) * 60 + (m || 0);
  }

  private generateSlots(startTime: string, endTime: string, slotDuration: number, breakDuration: number): Array<{ startTime: string; endTime: string }> {
    const slots: Array<{ startTime: string; endTime: string }> = [];
    
    // Parse times
    const [startHours, startMinutes] = startTime.split(':').map(Number);
    const [endHours, endMinutes] = endTime.split(':').map(Number);
    
    // Check if endTime is earlier than startTime (crosses midnight)
    const crossesMidnight = endHours < startHours || (endHours === startHours && endMinutes < startMinutes);
    
    if (crossesMidnight) {
      // Handle midnight crossover: generate slots from startTime to 23:59, then 00:00 to endTime
      // Example: 16:00 - 01:00 means slots from 16:00 to 23:59, then 00:00 to 01:00
      // All slots are created for the same schedule date (they represent one continuous working period)
      
      // Part 1: From startTime to end of day (23:59)
      const endOfDay = new Date(`2000-01-01T23:59:00`);
      let currentTime = new Date(`2000-01-01T${startTime}`);
      
      while (currentTime <= endOfDay) {
        const slotStart = currentTime.toTimeString().slice(0, 5);
        const nextTime = new Date(currentTime);
        nextTime.setMinutes(nextTime.getMinutes() + slotDuration);
        
        // If slot would go past end of day, cap it at 23:59
        if (nextTime > endOfDay) {
          slots.push({ startTime: slotStart, endTime: '23:59' });
          break;
        }
        
        const slotEnd = nextTime.toTimeString().slice(0, 5);
        slots.push({ startTime: slotStart, endTime: slotEnd });
        
        // Move to next slot start (after break if applicable)
        currentTime = new Date(nextTime);
        if (breakDuration > 0) {
          currentTime.setMinutes(currentTime.getMinutes() + breakDuration);
          if (currentTime > endOfDay) break;
        }
      }
      
      // Part 2: From start of day (00:00) to endTime
      const end = new Date(`2000-01-01T${endTime}`);
      currentTime = new Date(`2000-01-01T00:00:00`);
      
      while (currentTime < end) {
        const slotStart = currentTime.toTimeString().slice(0, 5);
        const nextTime = new Date(currentTime);
        nextTime.setMinutes(nextTime.getMinutes() + slotDuration);
        
        if (nextTime >= end) {
          // Last slot ends at endTime
          slots.push({ startTime: slotStart, endTime: endTime });
          break;
        }
        
        const slotEnd = nextTime.toTimeString().slice(0, 5);
        slots.push({ startTime: slotStart, endTime: slotEnd });
        
        // Move to next slot start (after break if applicable)
        currentTime = new Date(nextTime);
        if (breakDuration > 0) {
          currentTime.setMinutes(currentTime.getMinutes() + breakDuration);
          if (currentTime >= end) break;
        }
      }
    } else {
      // Normal case: startTime < endTime (same day)
      const start = new Date(`2000-01-01T${startTime}`);
      const end = new Date(`2000-01-01T${endTime}`);
    let currentTime = new Date(start);

    while (currentTime < end) {
      const slotStart = currentTime.toTimeString().slice(0, 5);
      const nextTime = new Date(currentTime);
      nextTime.setMinutes(nextTime.getMinutes() + slotDuration);
      
      if (nextTime >= end) {
          // Last slot ends at endTime
          slots.push({ startTime: slotStart, endTime: endTime });
        break;
      }
      
      const slotEnd = nextTime.toTimeString().slice(0, 5);
      slots.push({ startTime: slotStart, endTime: slotEnd });

        // Move to next slot start (after break if applicable)
      currentTime = new Date(nextTime);
      if (breakDuration > 0) {
        currentTime.setMinutes(currentTime.getMinutes() + breakDuration);
          if (currentTime >= end) break;
        }
      }
    }

    return slots;
  }

  /**
   * Validate time format (HH:MM)
   */
  private isValidTimeFormat(time: string): boolean {
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    return timeRegex.test(time);
  }

  /**
   * Validate time range
   * @param startTime Start time in HH:MM format
   * @param endTime End time in HH:MM format
   * @param allowMidnightCrossover If true, allows endTime < startTime (crosses midnight)
   *                               This is needed when UTC times cross midnight (e.g., 16:00 - 01:00)
   */
  private isValidTimeRange(startTime: string, endTime: string, allowMidnightCrossover: boolean = false): boolean {
    const [startHours, startMinutes] = startTime.split(':').map(Number);
    const [endHours, endMinutes] = endTime.split(':').map(Number);
    
    // Check if times are valid
    if (isNaN(startHours) || isNaN(startMinutes) || isNaN(endHours) || isNaN(endMinutes)) {
      return false;
    }
    
    // If allowing midnight crossover, any valid time range is acceptable
    // (endTime < startTime means it crosses midnight, which is valid)
    if (allowMidnightCrossover) {
      return true; // Both times are valid, range is acceptable
    }
    
    // Normal validation: start must be before end on the same day
    const start = new Date(`2000-01-01T${startTime}`);
    const end = new Date(`2000-01-01T${endTime}`);
    return start < end;
  }
}
