import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  BootstrapInspection,
  FIRST_SUPER_ADMIN_BOOTSTRAP_KEY,
  IPlatformBootstrapRepository,
} from '../../domain/repositories/platform-bootstrap.repository';

type Client = PrismaService | Prisma.TransactionClient;

const SUPER_ADMIN = 'SUPER_ADMIN';
const WILDCARD = '*';

@Injectable()
export class PrismaPlatformBootstrapRepository implements IPlatformBootstrapRepository {
  constructor(private readonly prisma: PrismaService) {}

  async inspect(tx?: unknown): Promise<BootstrapInspection> {
    const client = (tx as Client) ?? this.prisma;
    const [marker, superAdminUsers, superAdminAssignments, role] = await Promise.all([
      client.platformBootstrap.findUnique({ where: { key: FIRST_SUPER_ADMIN_BOOTSTRAP_KEY } }),
      // Deleted or suspended accounts count too: any existing Super Admin needs operator review.
      client.user.count({ where: { primaryRole: SUPER_ADMIN } }),
      client.userRole.count({ where: { role: { key: SUPER_ADMIN } } }),
      client.role.findUnique({
        where: { key: SUPER_ADMIN },
        select: { id: true, scope: true, rolePermissions: { select: { permission: { select: { key: true } } } } },
      }),
    ]);
    return {
      completed: marker !== null,
      superAdminExists: superAdminUsers + superAdminAssignments > 0,
      superAdminRole: role
        ? {
            id: role.id,
            scope: role.scope,
            hasWildcard: role.rolePermissions.some((rp) => rp.permission.key === WILDCARD),
          }
        : null,
    };
  }

  async assignSuperAdminRole(userId: string, roleId: string, tx: unknown): Promise<{ assignmentId: string }> {
    const assignment = await (tx as Client).userRole.create({
      data: { userId, roleId, organizationId: null, assignedBy: null },
      select: { id: true },
    });
    return { assignmentId: assignment.id };
  }

  async markCompleted(superAdminUserId: string, tx: unknown): Promise<void> {
    await (tx as Client).platformBootstrap.create({
      data: { key: FIRST_SUPER_ADMIN_BOOTSTRAP_KEY, superAdminUserId },
    });
  }
}
