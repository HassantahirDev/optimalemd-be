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

      const { password, ...doctorSafe } = assistant.linkedDoctor;
      // "Act fully as the doctor": present req.user as the linked DOCTOR so every
      // existing doctor endpoint (which checks userType === 'doctor' and
      // appointment.doctorId === req.user.id) works unchanged — no per-endpoint
      // edits, so the real doctor's flow is completely untouched.
      // Assistant context is carried alongside for the guard, /auth/me and audit.
      return {
        ...doctorSafe,
        userType: 'doctor',
        // Identity = the linked doctor
        id: assistant.linkedDoctorId,
        sub: assistant.linkedDoctorId,
        // Assistant markers (do not affect doctor endpoints)
        isAssistant: true,
        assistantId: assistant.id,
        assistantEmail: assistant.email,
        assistantName: `${assistant.firstName} ${assistant.lastName}`,
        linkedDoctorId: assistant.linkedDoctorId,
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

    } else if (userType === 'payment') {
      // Validate payment-portal user. This role can ONLY reach the payments
      // portal — it is never an admin/doctor/patient.
      account = await this.prisma.paymentUser.findUnique({
        where: { id },
      });

      if (!account || !account.isActive) {
        throw new UnauthorizedException('Payment user not found or inactive');
      }

      const { password, ...paymentUserSafe } = account;
      return { ...paymentUserSafe, userType: 'payment', paymentUserId: account.id };

    } else {
      throw new UnauthorizedException('Invalid user type in token');
    }
  }
}
