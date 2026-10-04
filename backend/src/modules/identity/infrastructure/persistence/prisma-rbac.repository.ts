import { Injectable } from '@nestjs/common';
import { Prisma, Role as PrismaRole, Permission as PrismaPermission } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IRbacRepository,
  NewUserRoleAssignment,
  PermissionRecord,
  RoleRecord,
  RoleScope,
  RoleWithPermissions,
  UserRoleRecord,
} from '../../domain/repositories/rbac.repository';

type UserRoleRow = Prisma.UserRoleGetPayload<{ include: { role: true } }>;

function toRole(row: PrismaRole): RoleRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    scope: row.scope as unknown as RoleScope,
    isSystem: row.isSystem,
    description: row.description,
  };
}

function toPermission(row: PrismaPermission): PermissionRecord {
  return {
    id: row.id,
    key: row.key,
    resource: row.resource,
    action: row.action,
    scope: (row.scope as string | null) ?? null,
    description: row.description,
  };
}

function toAssignment(row: UserRoleRow): UserRoleRecord {
  return {
    id: row.id,
    userId: row.userId,
    roleId: row.roleId,
    roleKey: row.role.key,
    roleName: row.role.name,
    organizationId: row.organizationId,
    assignedBy: row.assignedBy,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaRbacRepository implements IRbacRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listRoles(): Promise<RoleWithPermissions[]> {
    const rows = await this.prisma.role.findMany({
      orderBy: { key: 'asc' },
      include: { rolePermissions: { include: { permission: true } } },
    });
    return rows.map((row) => ({
      ...toRole(row),
      permissionKeys: row.rolePermissions.map((rp) => rp.permission.key).sort(),
    }));
  }

  async findRoleById(roleId: string): Promise<RoleRecord | null> {
    const row = await this.prisma.role.findUnique({ where: { id: roleId } });
    return row ? toRole(row) : null;
  }

  async findRoleByKey(roleKey: string): Promise<RoleRecord | null> {
    const row = await this.prisma.role.findUnique({ where: { key: roleKey } });
    return row ? toRole(row) : null;
  }

  async listPermissions(): Promise<PermissionRecord[]> {
    const rows = await this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
    return rows.map(toPermission);
  }

  async findPermissionsByKeys(keys: string[]): Promise<PermissionRecord[]> {
    if (keys.length === 0) {
      return [];
    }
    const rows = await this.prisma.permission.findMany({ where: { key: { in: keys } } });
    return rows.map(toPermission);
  }

  async replaceRolePermissions(roleId: string, permissionIds: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
        });
      }
    });
  }

  async listUserIdsWithRole(roleId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { roleId },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((r) => r.userId);
  }

  async listAssignmentsForUser(userId: string): Promise<UserRoleRecord[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAssignment);
  }

  async findAssignmentById(assignmentId: string): Promise<UserRoleRecord | null> {
    const row = await this.prisma.userRole.findUnique({
      where: { id: assignmentId },
      include: { role: true },
    });
    return row ? toAssignment(row) : null;
  }

  async findAssignment(
    userId: string,
    roleId: string,
    organizationId: string | null,
  ): Promise<UserRoleRecord | null> {
    const row = await this.prisma.userRole.findFirst({
      where: { userId, roleId, organizationId },
      include: { role: true },
    });
    return row ? toAssignment(row) : null;
  }

  async createAssignment(data: NewUserRoleAssignment): Promise<UserRoleRecord> {
    const row = await this.prisma.userRole.create({ data, include: { role: true } });
    return toAssignment(row);
  }

  async deleteAssignment(assignmentId: string): Promise<void> {
    await this.prisma.userRole.delete({ where: { id: assignmentId } });
  }

  async organizationExists(organizationId: string): Promise<boolean> {
    const row = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    return row !== null;
  }

  async bumpPermVersion(userIds: string[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    await this.prisma.user.updateMany({
      where: { id: { in: userIds } },
      data: { permVersion: { increment: 1 } },
    });
  }
}
