import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IRoleAssignmentRepository } from '../../domain/repositories/role-assignment.repository';

type Client = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PrismaRoleAssignmentRepository implements IRoleAssignmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async assignByRoleKey(
    userId: string,
    roleKey: string,
    organizationId: string | null,
    tx?: unknown,
  ): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const role = await client.role.findUnique({ where: { key: roleKey } });
    if (!role) {
      // Seed data not yet applied — do not fail registration over a missing catalog row.
      return;
    }
    const existing = await client.userRole.findFirst({
      where: { userId, roleId: role.id, organizationId },
    });
    if (!existing) {
      await client.userRole.create({ data: { userId, roleId: role.id, organizationId } });
    }
  }
}
