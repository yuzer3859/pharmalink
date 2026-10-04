import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IPermissionResolver } from '../../../../shared/rbac/rbac.types';

/**
 * Real IPermissionResolver implementation for the shared PermissionsGuard (module-01 §6, §12).
 * Effective permissions = union of every role assigned to the user (platform + all org-scoped
 * memberships) — scope (`own`/`org`/`any`) enforcement against a specific resource happens in
 * the application layer per shared-conventions §2, not here.
 */
@Injectable()
export class PrismaPermissionResolver implements IPermissionResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolvePermissions(userId: string): Promise<string[]> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
    });

    const permissions = new Set<string>();
    for (const userRole of userRoles) {
      for (const rolePermission of userRole.role.rolePermissions) {
        permissions.add(rolePermission.permission.key);
      }
    }
    return [...permissions];
  }
}
