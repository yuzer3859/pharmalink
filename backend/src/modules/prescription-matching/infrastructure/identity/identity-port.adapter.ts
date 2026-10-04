import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IIdentityPort } from '../../application/ports/outbound/identity.port';

/**
 * `IIdentityPort` adapter (module-05 §2.1) — direct, in-process `PrismaService.userRole`/`role`
 * reads, never a Prisma relation (ADR-002). Own copy per ADR-002, mirroring
 * `modules/pharmacy-inventory/infrastructure/identity/identity-port.adapter.ts` (Module 04's own
 * `IIdentityPort` adapter) rather than importing it. Module 05 never writes to `user_roles`/
 * `roles` — this is a read-only boundary, answering the port's data question only; the actual
 * business authorization rule (self-review guard, pharmacy scope) remains
 * `VerificationPolicy`'s job (§3.9).
 */
@Injectable()
export class IdentityPortAdapter implements IIdentityPort {
  constructor(private readonly prisma: PrismaService) {}

  async getUserOrganizationIds(userId: string): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, organizationId: { not: null } },
      select: { organizationId: true },
    });
    return [...new Set(roles.map((r) => r.organizationId).filter((id): id is string => id !== null))];
  }

  async hasRoleAtOrganization(userId: string, organizationId: string, roleKey: string): Promise<boolean> {
    const match = await this.prisma.userRole.findFirst({
      where: { userId, organizationId, role: { key: roleKey } },
      select: { id: true },
    });
    return match !== null;
  }
}
