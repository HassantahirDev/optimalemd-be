import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateMedicationDto,
  UpdateMedicationDto,
  MedicationResponseDto,
} from './dto';

@Injectable()
export class MedicationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a new medication
   */
  async createMedication(createMedicationDto: CreateMedicationDto): Promise<MedicationResponseDto> {
    const { 
      name,
      categoryName,
      strength,
      dose,
      route,
      frequency,
      directions,
      therapyCategory,
      standardPrice,
      membershipPrice,
      pricingNotes,
      prescription,
      isActive = true,
      // Legacy fields
      price,
      discountedPrice
    } = createMedicationDto;

    // Check if exact medication combination already exists (name + strength + dose + frequency + route)
    const existingMedication = await this.prisma.medication.findFirst({
      where: {
        name,
        strength: strength || null,
        dose: dose || null,
        frequency: frequency || null,
        route: route || null,
      }
    });
    if (existingMedication) {
      throw new ConflictException('Medication with this exact combination (name, strength, dose, frequency, route) already exists');
    }

    // Use standardPrice if provided, otherwise fall back to legacy price field
    const finalStandardPrice = standardPrice || price;
    const finalMembershipPrice = membershipPrice || discountedPrice;

    if (!finalStandardPrice) {
      throw new BadRequestException('Standard price is required');
    }

    // Validate standard price
    const standardPriceValue = parseFloat(finalStandardPrice);
    if (isNaN(standardPriceValue) || standardPriceValue <= 0) {
      throw new BadRequestException('Standard price must be a positive number');
    }

    // Validate membership price if provided
    if (finalMembershipPrice) {
      const membershipPriceValue = parseFloat(finalMembershipPrice);
      if (isNaN(membershipPriceValue) || membershipPriceValue <= 0) {
        throw new BadRequestException('Membership price must be a positive number');
      }
      if (membershipPriceValue >= standardPriceValue) {
        throw new BadRequestException('Membership price must be less than standard price');
      }
    }

    // Create medication with all fields
    const medication = await this.prisma.medication.create({
      data: {
        name,
        categoryName: categoryName || null,
        strength: strength || null,
        dose: dose || null,
        route: route || null,
        frequency: frequency || null,
        directions: directions || null,
        therapyCategory: therapyCategory || null,
        standardPrice: finalStandardPrice,
        membershipPrice: finalMembershipPrice || null,
        pricingNotes: pricingNotes || null,
        prescription: prescription || null,
        // Legacy fields for backward compatibility
        price: finalStandardPrice,
        discountedPrice: finalMembershipPrice || null,
        isActive
      }
    });

    return medication;
  }

  /**
   * Get medication by ID
   */
  async findById(id: string): Promise<MedicationResponseDto> {
    const medication = await this.prisma.medication.findUnique({
      where: { id }
    });

    if (!medication) {
      throw new NotFoundException('Medication not found');
    }

    return medication;
  }

  /**
   * Get all medications with optional filtering
   */
  async findAll(isActive?: boolean, therapyCategory?: string): Promise<MedicationResponseDto[]> {
    const where: any = {};
    
    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (therapyCategory) {
      where.therapyCategory = therapyCategory;
    }

    return this.prisma.medication.findMany({
      where,
      orderBy: [
        { isActive: 'desc' },
        { name: 'asc' }
      ]
    });
  }

  /**
   * Get medications grouped by therapy category
   */
  async findByCategory(): Promise<Record<string, MedicationResponseDto[]>> {
    const medications = await this.prisma.medication.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' }
    });

    const grouped: Record<string, MedicationResponseDto[]> = {};
    
    medications.forEach(med => {
      const category = med.therapyCategory || 'Other';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(med);
    });

    return grouped;
  }

  /**
   * Update medication
   */
  async updateMedication(id: string, updateMedicationDto: UpdateMedicationDto): Promise<MedicationResponseDto> {
    const medication = await this.prisma.medication.findUnique({
      where: { id }
    });

    if (!medication) {
      throw new NotFoundException('Medication not found');
    }

    // Check if new combination conflicts with existing medication
    const newName = updateMedicationDto.name || medication.name;
    const newStrength = updateMedicationDto.strength !== undefined ? updateMedicationDto.strength : medication.strength;
    const newDose = updateMedicationDto.dose !== undefined ? updateMedicationDto.dose : medication.dose;
    const newFrequency = updateMedicationDto.frequency !== undefined ? updateMedicationDto.frequency : medication.frequency;
    const newRoute = updateMedicationDto.route !== undefined ? updateMedicationDto.route : medication.route;

    // Check if this exact combination exists for a different medication
    const existingMedication = await this.prisma.medication.findFirst({
      where: {
        name: newName,
        strength: newStrength || null,
        dose: newDose || null,
        frequency: newFrequency || null,
        route: newRoute || null,
        NOT: { id: medication.id } // Exclude the current medication
      }
    });
    if (existingMedication) {
      throw new ConflictException('Medication with this exact combination (name, strength, dose, frequency, route) already exists');
    }

    // Handle backward compatibility: standardPrice or price
    const finalStandardPrice = updateMedicationDto.standardPrice || updateMedicationDto.price;
    const finalMembershipPrice = updateMedicationDto.membershipPrice !== undefined 
      ? updateMedicationDto.membershipPrice 
      : updateMedicationDto.discountedPrice;

    // Validate standard price if provided
    const currentStandardPrice = finalStandardPrice 
      ? parseFloat(finalStandardPrice)
      : parseFloat(medication.standardPrice.toString());
    
    if (finalStandardPrice) {
      const newStandardPrice = parseFloat(finalStandardPrice);
      if (isNaN(newStandardPrice) || newStandardPrice <= 0) {
        throw new BadRequestException('Standard price must be a positive number');
      }
    }

    // Validate membership price if provided
    if (finalMembershipPrice !== undefined) {
      if (finalMembershipPrice === null || finalMembershipPrice === '') {
        // Allow clearing the membership price
        updateMedicationDto.membershipPrice = undefined;
        updateMedicationDto.discountedPrice = undefined;
      } else {
        const membershipPriceValue = parseFloat(finalMembershipPrice);
        if (isNaN(membershipPriceValue) || membershipPriceValue <= 0) {
          throw new BadRequestException('Membership price must be a positive number');
        }
        if (membershipPriceValue >= currentStandardPrice) {
          throw new BadRequestException('Membership price must be less than standard price');
        }
      }
    }

    // Prepare update data with backward compatibility
    const updateData: any = {};
    
    // Map new fields
    if (updateMedicationDto.name !== undefined) updateData.name = updateMedicationDto.name;
    if (updateMedicationDto.categoryName !== undefined) updateData.categoryName = updateMedicationDto.categoryName;
    if (updateMedicationDto.strength !== undefined) updateData.strength = updateMedicationDto.strength;
    if (updateMedicationDto.dose !== undefined) updateData.dose = updateMedicationDto.dose;
    if (updateMedicationDto.route !== undefined) updateData.route = updateMedicationDto.route;
    if (updateMedicationDto.frequency !== undefined) updateData.frequency = updateMedicationDto.frequency;
    if (updateMedicationDto.directions !== undefined) updateData.directions = updateMedicationDto.directions;
    if (updateMedicationDto.therapyCategory !== undefined) updateData.therapyCategory = updateMedicationDto.therapyCategory;
    if (updateMedicationDto.pricingNotes !== undefined) updateData.pricingNotes = updateMedicationDto.pricingNotes;
    if (updateMedicationDto.prescription !== undefined) updateData.prescription = updateMedicationDto.prescription;
    if (updateMedicationDto.isActive !== undefined) updateData.isActive = updateMedicationDto.isActive;
    
    // Handle pricing fields with backward compatibility
    if (finalStandardPrice) {
      updateData.standardPrice = finalStandardPrice;
      updateData.price = finalStandardPrice; // Keep legacy field in sync
    }
    if (finalMembershipPrice !== undefined) {
      updateData.membershipPrice = finalMembershipPrice || null;
      updateData.discountedPrice = finalMembershipPrice || null; // Keep legacy field in sync
    }

    // Update medication
    const updatedMedication = await this.prisma.medication.update({
      where: { id },
      data: updateData
    });

    return updatedMedication;
  }

  /**
   * Delete medication
   */
  async deleteMedication(id: string): Promise<void> {
    const medication = await this.prisma.medication.findUnique({
      where: { id }
    });

    if (!medication) {
      throw new NotFoundException('Medication not found');
    }

    // Delete the medication
    await this.prisma.medication.delete({
      where: { id }
    });
  }
}

