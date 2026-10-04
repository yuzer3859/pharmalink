import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IIdentityPort } from '../../application/ports/outbound/identity.port';

/**
 * Module 06's own `IIdentityPort` adapter (`06-orders-spec.md` §5) — direct, in-process
 * `PrismaService.userRole` reads of Module 01's `user_roles`/`roles`, never a Prisma relation
 * (ADR-002). Own copy, mirroring
 * `modules/prescription-matching/infrastructure/identity/identity-port.adapter.ts` and Module
 * 04's equivalent rather than importing either — the shape is reused, the implementation is not.
 *
 * Both methods speak in **`Organization.id`**, which is what `user_roles.organizationId` stores.
 * Translating between an `Organization.id` and a `Pharmacy.id` is deliberately not this adapter's
 * job — that mapping lives in `IPharmacyPort`, because it is Module 04 data, not Module 01 data.
 *
 * Read-only: Module 06 never writes role assignments. This answers only the port's data question;
 * the authorization rule itself stays in `assertFulfillmentOrgScope` (§7.1), exactly as Module 05
 * keeps its rule in `VerificationPolicy`.
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

  async hasRoleAtOrganization(
    userId: string,
    organizationId: string,
    roleKey: string,
  ): Promise<boolean> {
    const match = await this.prisma.userRole.findFirst({
      where: { userId, organizationId, role: { key: roleKey } },
      select: { id: true },
    });
    return match !== null;
  }
}
