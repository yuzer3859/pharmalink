import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IIdentityPort, OrganizationView } from '../../application/ports/outbound/identity.port';

/**
 * `IIdentityPort` adapter (module-04 §2) — direct, in-process `PrismaService.organization`
 * reads, never a Prisma relation (ADR-002). Module 04 never writes to `organizations`.
 */
@Injectable()
export class IdentityPortAdapter implements IIdentityPort {
  constructor(private readonly prisma: PrismaService) {}

  async getOrganization(organizationId: string): Promise<OrganizationView | null> {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org || org.deletedAt) {
      return null;
    }
    return {
      id: org.id,
      type: org.type,
      status: org.status,
      licenseNumber: org.licenseNumber,
      licenseExpiresAt: org.licenseExpiresAt,
    };
  }

  async getOrganizationOwner(organizationId: string): Promise<{ userId: string } | null> {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    return org ? { userId: org.ownerUserId } : null;
  }

  async getUserOrganizationIds(userId: string): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, organizationId: { not: null } },
      select: { organizationId: true },
    });
    return [...new Set(roles.map((r) => r.organizationId).filter((id): id is string => id !== null))];
  }
}
