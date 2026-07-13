import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateScheduleDto,
  CreateMultipleSchedulesDto,
  UpdateScheduleDto,
  QuerySchedulesDto,
  ScheduleResponseDto,
  ScheduleWithSlotsDto,
  ScheduleWithDoctorInfoDto,
  CreateSlotDto,
  CreateMultipleSlotsDto,
  UpdateSlotDto,
  SlotResponseDto,
  SlotWithScheduleInfoDto,
  AvailableSlotsQueryDto,
} from './dto';
import { dateStringToUTC, isDateInPast, addDaysUTC, getUTCDayOfWeek, toISODateString, getUTCMidnight, getUTCEndOfDay } from '../common/utils/timezone.utils';

@Injectable()
export class SchedulesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a single schedule
   */
  async createSchedule(createScheduleDto: CreateScheduleDto): Promise<ScheduleResponseDto> {
    const { doctorId, date, startTime, endTime, maxAppointments } = createScheduleDto;

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

    // Validate date is not in the past
    const scheduleDate = dateStringToUTC(date);
    if (isDateInPast(date)) {
      throw new BadRequestException('Schedule date cannot be in the past');
    }

    // Validate time format and logic
    if (!this.isValidTimeFormat(startTime) || !this.isValidTimeFormat(endTime)) {
      throw new BadRequestException('Invalid time format. Use HH:MM format');
    }

    if (!this.isValidTimeRange(startTime, endTime)) {
      throw new BadRequestException('Start time must be before end time');
    }

    // Check for schedule conflicts
    const conflictingSchedule = await this.prisma.schedule.findFirst({
      where: {
        doctorId,
        date: scheduleDate,
        OR: [
          {
            AND: [
              { startTime: { lte: startTime } },
              { endTime: { gt: startTime } }
            ]
          },
          {
            AND: [
              { startTime: { lt: endTime } },
              { endTime: { gte: endTime } }
            ]
          },
          {
            AND: [
              { startTime: { gte: startTime } },
              { endTime: { lte: endTime } }
            ]
          }
        ]
      }
    });

    if (conflictingSchedule) {
      throw new ConflictException('Schedule conflicts with existing schedule');
    }

    // Create schedule
    const schedule = await this.prisma.schedule.create({
      data: {
        doctorId,
        date: scheduleDate,
        startTime,
        endTime,
        maxAppointments,
        isAvailable: true
      }
    });

    return schedule;
  }

  /**
   * Create multiple schedules for a date range
   */
  async createMultipleSchedules(createMultipleSchedulesDto: CreateMultipleSchedulesDto): Promise<ScheduleResponseDto[]> {
    const { doctorId, startDate, endDate, workingDays, startTime, endTime, maxAppointments, breakTime = 0 } = createMultipleSchedulesDto;

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

    // Validate date range
    const start = dateStringToUTC(startDate);
    const end = dateStringToUTC(endDate);
    if (start >= end) {
      throw new BadRequestException('Start date must be before end date');
    }

    if (isDateInPast(startDate)) {
      throw new BadRequestException('Start date cannot be in the past');
    }

    // Validate working days
    if (!workingDays || workingDays.length === 0) {
      throw new BadRequestException('At least one working day must be specified');
    }

    if (!workingDays.every(day => day >= 0 && day <= 6)) {
      throw new BadRequestException('Working days must be between 0 (Sunday) and 6 (Saturday)');
    }

    // Validate time format and logic
    if (!this.isValidTimeFormat(startTime) || !this.isValidTimeFormat(endTime)) {
      throw new BadRequestException('Invalid time format. Use HH:MM format');
    }

    if (!this.isValidTimeRange(startTime, endTime)) {
      throw new BadRequestException('Start time must be before end time');
    }

    const schedules: ScheduleResponseDto[] = [];
    let currentDate = new Date(start);

    while (currentDate <= end) {
      const dayOfWeek = getUTCDayOfWeek(currentDate);
      
      if (workingDays.includes(dayOfWeek)) {
        try {
          const schedule = await this.createSchedule({
            doctorId,
            date: toISODateString(currentDate),
            startTime,
            endTime,
            maxAppointments
          });
          schedules.push(schedule);
        } catch (error) {
          // Log conflict but continue with other dates
          console.warn(`Schedule conflict for ${toISODateString(currentDate)}: ${error.message}`);
        }
      }

      currentDate = addDaysUTC(currentDate, 1);
    }

    return schedules;
  }

  /**
   * Get schedule by ID
   */
  async findById(id: string): Promise<ScheduleResponseDto> {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id }
    });

    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    return schedule;
  }

  /**
   * Get schedule with slots
   */
  async findByIdWithSlots(id: string): Promise<ScheduleWithSlotsDto> {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id },
      include: {
        slots: {
          orderBy: { startTime: 'asc' }
        }
      }
    });

    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    return schedule;
  }

  /**
   * Get schedule with doctor info
   */
  async findByIdWithDoctorInfo(id: string): Promise<ScheduleWithDoctorInfoDto> {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id },
      include: {
        doctor: {
          select: {
            id: true,
            specialization: true,
            firstName: true,
            lastName: true,
          }
        }
      }
    });

    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    return schedule;
  }

  /**
   * Get schedules with filtering and pagination
   */
  async findAll(query: QuerySchedulesDto): Promise<{ schedules: ScheduleResponseDto[], total: number }> {
    const { doctorId, startDate, endDate, isAvailable, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (doctorId) where.doctorId = doctorId;
    if (isAvailable !== undefined) where.isAvailable = isAvailable === 'true';
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = dateStringToUTC(startDate);
      if (endDate) where.date.lte = dateStringToUTC(endDate);
    }

    const [schedules, total] = await Promise.all([
      this.prisma.schedule.findMany({
        where,
        skip,
        take: limit,
        orderBy: [
          { date: 'asc' },
          { startTime: 'asc' }
        ]
      }),
      this.prisma.schedule.count({ where })
    ]);

    return { schedules, total };
  }

  /**
   * Day view for front desk: every physician's slots (open + booked) with the booked
   * patient/appointment summary. Supports a date range and returns results grouped by
   * day, then by physician — so the front desk can see a whole week at once.
   */
  async getDayView(startDate: string, endDate?: string, doctorId?: string) {
    const where: any = {
      date: {
        gte: getUTCMidnight(dateStringToUTC(startDate)),
        lte: getUTCEndOfDay(dateStringToUTC(endDate || startDate)),
      },
    };
    if (doctorId) where.doctorId = doctorId;

    const schedules = await this.prisma.schedule.findMany({
      where,
      include: {
        doctor: { select: { id: true, firstName: true, lastName: true, specialization: true } },
        slots: {
          orderBy: { startTime: 'asc' },
          include: {
            appointment: {
              where: { status: { not: 'CANCELLED' as any } },
              select: {
                id: true,
                status: true,
                visitStatus: true,
                checkedInAt: true,
                appointmentTime: true,
                patient: { select: { id: true, firstName: true, lastName: true } },
                service: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });

    // Group: date → physician → slots (a doctor may have several blocks per day)
    const byDate = new Map<string, Map<string, any>>();
    for (const s of schedules) {
      const dateKey = toISODateString(s.date);
      if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
      const byDoctor = byDate.get(dateKey)!;
      if (!byDoctor.has(s.doctorId)) {
        byDoctor.set(s.doctorId, { doctor: s.doctor, slots: [] });
      }
      for (const slot of s.slots) {
        const appt = (slot.appointment && slot.appointment[0]) || null;
        byDoctor.get(s.doctorId).slots.push({
          id: slot.id,
          startTime: slot.startTime,
          endTime: slot.endTime,
          isAvailable: slot.isAvailable,
          appointment: appt,
        });
      }
    }

    // Merge in CUSTOM (out-of-slot) appointments — these have no slot, so they
    // wouldn't otherwise appear on the schedule. Surface them as booked entries
    // (with patient + service) so a custom booking shows just like a booked slot.
    const customAppointments = await this.prisma.appointment.findMany({
      where: {
        slotId: null,
        status: { not: 'CANCELLED' as any },
        appointmentDate: {
          gte: getUTCMidnight(dateStringToUTC(startDate)),
          lte: getUTCEndOfDay(dateStringToUTC(endDate || startDate)),
        },
        ...(doctorId ? { doctorId } : {}),
      },
      select: {
        id: true,
        doctorId: true,
        appointmentDate: true,
        appointmentTime: true,
        duration: true,
        status: true,
        visitStatus: true,
        checkedInAt: true,
        doctor: { select: { id: true, firstName: true, lastName: true, specialization: true } },
        patient: { select: { id: true, firstName: true, lastName: true } },
        service: { select: { name: true } },
      },
    });
    const addMinutes = (time: string, mins: number): string => {
      const [h, m] = (time || '0:0').split(':').map((n) => parseInt(n, 10));
      const total = (h || 0) * 60 + (m || 0) + (mins || 0);
      const hh = Math.floor((total % 1440) / 60);
      const mm = total % 60;
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };
    for (const a of customAppointments) {
      if (!a.doctorId || !a.doctor) continue;
      const dateKey = toISODateString(a.appointmentDate);
      if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
      const byDoctor = byDate.get(dateKey)!;
      if (!byDoctor.has(a.doctorId)) byDoctor.set(a.doctorId, { doctor: a.doctor, slots: [] });
      byDoctor.get(a.doctorId).slots.push({
        id: `custom-${a.id}`,
        startTime: a.appointmentTime,
        endTime: addMinutes(a.appointmentTime, a.duration),
        isAvailable: false,
        isCustom: true,
        appointment: {
          id: a.id,
          status: a.status,
          visitStatus: a.visitStatus,
          checkedInAt: a.checkedInAt,
          appointmentTime: a.appointmentTime,
          patient: a.patient,
          service: a.service,
        },
      });
    }

    return Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, byDoctor]) => ({
        date,
        physicians: Array.from(byDoctor.values()).map((d) => ({
          doctor: d.doctor,
          slots: d.slots.sort((a: any, b: any) => (a.startTime || '').localeCompare(b.startTime || '')),
        })),
      }));
  }

  /**
   * Update schedule
   */
  async updateSchedule(id: string, updateScheduleDto: UpdateScheduleDto): Promise<ScheduleResponseDto> {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id }
    });

    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    // Validate time format and logic if provided
    if (updateScheduleDto.startTime && !this.isValidTimeFormat(updateScheduleDto.startTime)) {
      throw new BadRequestException('Invalid start time format. Use HH:MM format');
    }

    if (updateScheduleDto.endTime && !this.isValidTimeFormat(updateScheduleDto.endTime)) {
      throw new BadRequestException('Invalid end time format. Use HH:MM format');
    }

    if (updateScheduleDto.startTime && updateScheduleDto.endTime) {
      if (!this.isValidTimeRange(updateScheduleDto.startTime, updateScheduleDto.endTime)) {
        throw new BadRequestException('Start time must be before end time');
      }
    }

    // Check for conflicts if time is being updated
    if (updateScheduleDto.startTime || updateScheduleDto.endTime) {
      const startTime = updateScheduleDto.startTime || schedule.startTime;
      const endTime = updateScheduleDto.endTime || schedule.endTime;

      const conflictingSchedule = await this.prisma.schedule.findFirst({
        where: {
          doctorId: schedule.doctorId,
          date: schedule.date,
          id: { not: id },
          OR: [
            {
              AND: [
                { startTime: { lte: startTime } },
                { endTime: { gt: startTime } }
              ]
            },
            {
              AND: [
                { startTime: { lt: endTime } },
                { endTime: { gte: endTime } }
              ]
            },
            {
              AND: [
                { startTime: { gte: startTime } },
                { endTime: { lte: endTime } }
              ]
            }
          ]
        }
      });

      if (conflictingSchedule) {
        throw new ConflictException('Updated schedule conflicts with existing schedule');
      }
    }

    const updatedSchedule = await this.prisma.schedule.update({
      where: { id },
      data: updateScheduleDto
    });

    return updatedSchedule;
  }

  /**
   * Delete schedule
   */
  async deleteSchedule(id: string): Promise<void> {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id },
      include: {
        slots: {
          include: {
            appointment: true
          }
        }
      }
    });

    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    // Check if schedule has appointments
    const hasAppointments = schedule.slots.some(slot => slot.appointment);
    if (hasAppointments) {
      throw new BadRequestException('Cannot delete schedule with existing appointments');
    }

    // Use transaction to ensure data consistency
    await this.prisma.$transaction(async (prisma) => {
      // Delete all slots
      await prisma.slot.deleteMany({
        where: { scheduleId: id }
      });

      // Delete schedule
      await prisma.schedule.delete({
        where: { id }
      });
    });
  }

  /**
   * Create a single slot
   */
  async createSlot(createSlotDto: CreateSlotDto): Promise<SlotResponseDto> {
    const { scheduleId, startTime, endTime } = createSlotDto;

    // Check if schedule exists
    const schedule = await this.prisma.schedule.findUnique({
      where: { id: scheduleId }
    });
    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    // Validate time format and logic
    if (!this.isValidTimeFormat(startTime) || !this.isValidTimeFormat(endTime)) {
      throw new BadRequestException('Invalid time format. Use HH:MM format');
    }

    if (!this.isValidTimeRange(startTime, endTime)) {
      throw new BadRequestException('Start time must be before end time');
    }

    // Check if slot time is within schedule time
    if (startTime < schedule.startTime || endTime > schedule.endTime) {
      throw new BadRequestException('Slot time must be within schedule time');
    }

    // Check for slot conflicts
    const conflictingSlot = await this.prisma.slot.findFirst({
      where: {
        scheduleId,
        OR: [
          {
            AND: [
              { startTime: { lte: startTime } },
              { endTime: { gt: startTime } }
            ]
          },
          {
            AND: [
              { startTime: { lt: endTime } },
              { endTime: { gte: endTime } }
            ]
          },
          {
            AND: [
              { startTime: { gte: startTime } },
              { endTime: { lte: endTime } }
            ]
          }
        ]
      }
    });

    if (conflictingSlot) {
      throw new ConflictException('Slot conflicts with existing slot');
    }

    // Create slot
    const slot = await this.prisma.slot.create({
      data: {
        scheduleId,
        startTime,
        endTime,
        isAvailable: true
      }
    });

    return slot;
  }

  /**
   * Create multiple slots for a schedule
   */
  async createMultipleSlots(createMultipleSlotsDto: CreateMultipleSlotsDto): Promise<SlotResponseDto[]> {
    const { scheduleId, slotDuration, breakTime = 0 } = createMultipleSlotsDto;

    // Check if schedule exists
    const schedule = await this.prisma.schedule.findUnique({
      where: { id: scheduleId }
    });
    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    // Validate slot duration
    if (slotDuration < 15 || slotDuration > 120) {
      throw new BadRequestException('Slot duration must be between 15 and 120 minutes');
    }

    // Validate break time
    if (breakTime < 0 || breakTime > 60) {
      throw new BadRequestException('Break time must be between 0 and 60 minutes');
    }

    const slots: SlotResponseDto[] = [];
    const scheduleStart = new Date(`2000-01-01T${schedule.startTime}`);
    const scheduleEnd = new Date(`2000-01-01T${schedule.endTime}`);
    let currentTime = new Date(scheduleStart);

    while (currentTime < scheduleEnd) {
      const slotStart = currentTime.toTimeString().slice(0, 5);
      currentTime.setMinutes(currentTime.getMinutes() + slotDuration);
      
      if (currentTime > scheduleEnd) break;
      
      const slotEnd = currentTime.toTimeString().slice(0, 5);

      try {
        const slot = await this.createSlot({
          scheduleId,
          startTime: slotStart,
          endTime: slotEnd
        });
        slots.push(slot);
      } catch (error) {
        // Log conflict but continue with other slots
        console.warn(`Slot conflict for ${slotStart}-${slotEnd}: ${error.message}`);
      }

      // Add break time
      if (breakTime > 0) {
        currentTime.setMinutes(currentTime.getMinutes() + breakTime);
      }
    }

    return slots;
  }

  /**
   * Get slot by ID
   */
  async findSlotById(id: string): Promise<SlotResponseDto> {
    const slot = await this.prisma.slot.findUnique({
      where: { id }
    });

    if (!slot) {
      throw new NotFoundException('Slot not found');
    }

    return slot;
  }

  /**
   * Get slot with schedule info
   */
  async findSlotByIdWithScheduleInfo(id: string): Promise<SlotWithScheduleInfoDto> {
    const slot = await this.prisma.slot.findUnique({
      where: { id },
      include: {
        schedule: {
          select: {
            id: true,
            date: true,
            doctorId: true
          }
        }
      }
    });

    if (!slot) {
      throw new NotFoundException('Slot not found');
    }

    return slot;
  }

  /**
   * Update slot
   */
  async updateSlot(id: string, updateSlotDto: UpdateSlotDto): Promise<SlotResponseDto> {
    const slot = await this.prisma.slot.findUnique({
      where: { id },
      include: { schedule: true }
    });

    if (!slot) {
      throw new NotFoundException('Slot not found');
    }

    // Validate time format and logic if provided
    if (updateSlotDto.startTime && !this.isValidTimeFormat(updateSlotDto.startTime)) {
      throw new BadRequestException('Invalid start time format. Use HH:MM format');
    }

    if (updateSlotDto.endTime && !this.isValidTimeFormat(updateSlotDto.endTime)) {
      throw new BadRequestException('Invalid end time format. Use HH:MM format');
    }

    if (updateSlotDto.startTime && updateSlotDto.endTime) {
      if (!this.isValidTimeRange(updateSlotDto.startTime, updateSlotDto.endTime)) {
        throw new BadRequestException('Start time must be before end time');
      }

      // Check if updated slot time is within schedule time
      if (updateSlotDto.startTime < slot.schedule.startTime || updateSlotDto.endTime > slot.schedule.endTime) {
        throw new BadRequestException('Slot time must be within schedule time');
      }
    }

    // Check for conflicts if time is being updated
    if (updateSlotDto.startTime || updateSlotDto.endTime) {
      const startTime = updateSlotDto.startTime || slot.startTime;
      const endTime = updateSlotDto.endTime || slot.endTime;

      const conflictingSlot = await this.prisma.slot.findFirst({
        where: {
          scheduleId: slot.scheduleId,
          id: { not: id },
          OR: [
            {
              AND: [
                { startTime: { lte: startTime } },
                { endTime: { gt: startTime } }
              ]
            },
            {
              AND: [
                { startTime: { lt: endTime } },
                { endTime: { gte: endTime } }
              ]
            },
            {
              AND: [
                { startTime: { gte: startTime } },
                { endTime: { lte: endTime } }
              ]
            }
          ]
        }
      });

      if (conflictingSlot) {
        throw new ConflictException('Updated slot conflicts with existing slot');
      }
    }

    const updatedSlot = await this.prisma.slot.update({
      where: { id },
      data: updateSlotDto
    });

    return updatedSlot;
  }

  /**
   * Delete slot
   */
  async deleteSlot(id: string): Promise<void> {
    const slot = await this.prisma.slot.findUnique({
      where: { id },
      include: { appointment: true }
    });

    if (!slot) {
      throw new NotFoundException('Slot not found');
    }

    // Check if slot has appointment
    if (slot.appointment) {
      throw new BadRequestException('Cannot delete slot with existing appointment');
    }

    await this.prisma.slot.delete({
      where: { id }
    });
  }

  /**
   * Get available slots for a doctor on a specific date
   */
  async getAvailableSlots(query: AvailableSlotsQueryDto): Promise<any> {
    const { doctorId, date, serviceId } = query;

    console.log("queryyyyyyyy", query);

    // Check if doctor exists and is available
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

    console.log("query", query);

    // Get schedules for the specified date
    const schedules = await this.prisma.schedule.findMany({
      where: {
        doctorId,
        date: dateStringToUTC(date),
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

    // Filter slots based on service duration if provided
    let availableSlots = schedules.flatMap(schedule => schedule.slots);
    
    if (serviceId) {
      const service = await this.prisma.service.findUnique({
        where: { id: serviceId },
        select: { duration: true }
      });
      
      if (service) {
        availableSlots = availableSlots.filter(slot => {
          const slotStart = new Date(`2000-01-01T${slot.startTime}`);
          const slotEnd = new Date(`2000-01-01T${slot.endTime}`);
          const slotDuration = (slotEnd.getTime() - slotStart.getTime()) / (1000 * 60);
          return slotDuration >= service.duration;
        });
      }
    }

    return {
      doctorId,
      date,
      schedules,
      availableSlots
    };
  }

  /**
   * Validate time format (HH:MM)
   */
  private isValidTimeFormat(time: string): boolean {
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    return timeRegex.test(time);
  }

  /**
   * Validate time range (start < end)
   */
  private isValidTimeRange(startTime: string, endTime: string): boolean {
    const start = new Date(`2000-01-01T${startTime}`);
    const end = new Date(`2000-01-01T${endTime}`);
    return start < end;
  }
}
