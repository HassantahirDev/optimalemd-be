import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') || '',
    });
  }

  async validate(payload: any) {
    const { sub: id, userType } = payload;
    
    if (!id || !userType) {
      throw new UnauthorizedException('Invalid token payload');
    }

    let account;

    if (userType === 'assistant') {
      // Validate assistant doctor and resolve the linked doctor (act-as)
      const assistant = await this.prisma.doctorAssistant.findUnique({
        where: { id },
        include: { linkedDoctor: true },
      });

      if (!assistant || !assistant.isActive) {
        throw new UnauthorizedException('Assistant not found or inactive');
      }
      if (!assistant.linkedDoctor || !assistant.linkedDoctor.isActive) {
        throw new UnauthorizedException('Linked doctor not available');
      }

      const permissions = {
        canCreate: assistant.canCreate,
        canRead: assistant.canRead,
        canUpdate: assistant.canUpdate,
        canDelete: assistant.canDelete,
      };

      const { password, linkedDoctor, ...assistantSafe } = assistant;
      // Expose linkedDoctorId + permissions for the AssistantPermissionGuard,
      // and effectiveDoctorId so "act as doctor" endpoints resolve correctly.
      return {
        ...assistantSafe,
        userType: 'assistant',
        assistantId: assistant.id,
        linkedDoctorId: assistant.linkedDoctorId,
        effectiveDoctorId: assistant.linkedDoctorId,
        permissions,
      };
    }

    if (userType === 'user') {
      // Validate user (patient)
      account = await this.prisma.user.findUnique({
        where: { id },
      });
      
      if (!account || !account.isActive) {
        throw new UnauthorizedException('User not found or inactive');
      }
      
      // Remove password from response
      const { password, ...userWithoutPassword } = account;
      return { ...userWithoutPassword, userType: 'user' };
      
    } else if (userType === 'doctor') {
      // Validate doctor
      account = await this.prisma.doctor.findUnique({
        where: { id },
      });
      
      if (!account || !account.isActive) {
        throw new UnauthorizedException('Doctor not found or inactive');
      }
      
      // Remove password from response
      const { password, ...doctorWithoutPassword } = account;
      return { ...doctorWithoutPassword, userType: 'doctor' };
      
    } else if (userType === 'admin') {
      // Validate admin
      account = await this.prisma.admin.findUnique({
        where: { id },
      });
      
      if (!account || !account.isActive) {
        throw new UnauthorizedException('Admin not found or inactive');
      }
      
      // Remove password from response
      const { password, ...adminWithoutPassword } = account;
      return { ...adminWithoutPassword, userType: 'admin' };
      
    } else {
      throw new UnauthorizedException('Invalid user type in token');
    }
  }
}
