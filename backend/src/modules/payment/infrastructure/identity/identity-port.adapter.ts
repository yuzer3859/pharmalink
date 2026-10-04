import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IIdentityPort } from '../../application/ports/outbound/identity.port';

/**
 * Module 07's own `IIdentityPort` adapter — a direct, in-process `PrismaService.userRole` read of
 * Module 01's `user_roles`, never a Prisma relation (ADR-002). Own copy, mirroring Module 06's
 * and Module 04's equivalents rather than importing either.
 *
 * Read-only, and it will stay that way: Module 07 has no reason to write a role assignment.
 */
@Injectable()
export class IdentityPortAdapter implements IIdentityPort {
  constructor(private readonly prisma: PrismaService) {}

  async getUserOrganizationIds(userId: string): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, organizationId: { not: null } },
      select: { organizationId: true },
    });
    return [
      ...new Set(roles.map((r) => r.organizationId).filter((id): id is string => id !== null)),
    ];
  }
}
