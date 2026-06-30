import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Global guard that enforces assistant-doctor access rules.
 *
 * It is self-contained: it reads and verifies the Bearer token itself, so it
 * works regardless of whether a given route also runs JwtAuthGuard. It ONLY
 * ever restricts assistant tokens — every other request passes straight through.
 *
 * IMPORTANT: permissions are read LIVE from the database on every request (not
 * from the token), so super-admin changes (including revocation/deactivation)
 * take effect immediately without requiring the assistant to log out.
 *
 * For assistant tokens it enforces:
 *  - Global CRUD permissions inferred from the HTTP method:
 *      GET -> read, POST -> create, PUT/PATCH -> update, DELETE -> delete
 *  - Lock to the linked doctor: any explicit doctorId in params/query/body
 *    must equal the assistant's linkedDoctorId.
 */
@Injectable()
export class AssistantPermissionGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const auth: string | undefined = req.headers?.authorization;
    if (!auth?.startsWith('Bearer ')) return true; // no token → not our concern

    let payload: any;
    try {
      payload = this.jwtService.verify(auth.slice(7), {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      return true; // invalid/expired token → let the route's own guard reject it
    }

    if (!payload || payload.userType !== 'assistant') return true; // only assistants restricted

    // Live permissions from DB — never trust the token's snapshot.
    const assistant = await this.prisma.doctorAssistant.findUnique({
      where: { id: payload.sub },
      select: {
        isActive: true,
        linkedDoctorId: true,
        canCreate: true,
        canRead: true,
        canUpdate: true,
        canDelete: true,
        linkedDoctor: { select: { isActive: true } },
      },
    });

    if (!assistant || !assistant.isActive) {
      throw new ForbiddenException('Assistant account is inactive');
    }
    if (!assistant.linkedDoctor?.isActive) {
      throw new ForbiddenException('Linked doctor is not available');
    }

    const method = (req.method || 'GET').toUpperCase();
    const allowedByMethod: Record<string, boolean> = {
      GET: assistant.canRead,
      POST: assistant.canCreate,
      PUT: assistant.canUpdate,
      PATCH: assistant.canUpdate,
      DELETE: assistant.canDelete,
    };

    if (!allowedByMethod[method]) {
      const action =
        { GET: 'read', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' }[method] ||
        'perform this action';
      throw new ForbiddenException(`Your assistant account does not have ${action} permission`);
    }

    // Lock to the linked doctor.
    const explicitDoctorIds = [
      req.params?.doctorId,
      req.query?.doctorId,
      req.body?.doctorId,
    ].filter(Boolean);

    if (explicitDoctorIds.some((ref: string) => ref !== assistant.linkedDoctorId)) {
      throw new ForbiddenException("Assistants can only access their linked doctor's data");
    }

    return true;
  }
}
