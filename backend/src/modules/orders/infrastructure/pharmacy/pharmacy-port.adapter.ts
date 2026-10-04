import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IPharmacyPort } from '../../application/ports/outbound/pharmacy.port';

/**
 * Module 06's own `IPharmacyPort` adapter (`06-orders-spec.md` §5) — direct, in-process
 * `PrismaService.pharmacy` reads of Module 04's `pharmacies` table, never a Prisma relation
 * (ADR-002), exactly like this module's `CatalogPortAdapter`/`AddressPortAdapter`/
 * `IdentityPortAdapter` read Modules 03/02/01.
 *
 * Projects only `organizationId`/`id` — never licence, transacting-status or any other Module 04
 * column — so this stays an ownership-resolution seam and cannot drift into duplicating Module
 * 04's eligibility rules.
 *
 * Soft-deleted pharmacies are treated as absent, consistent with `CatalogPortAdapter`'s handling
 * of deleted products: a fulfillment pointing at a deleted pharmacy resolves to the same generic
 * not-found as an unauthorized one.
 */
@Injectable()
export class PharmacyPortAdapter implements IPharmacyPort {
  constructor(private readonly prisma: PrismaService) {}

  async getOrganizationId(pharmacyId: string): Promise<string | null> {
    const pharmacy = await this.prisma.pharmacy.findFirst({
      where: { id: pharmacyId, deletedAt: null },
      select: { organizationId: true },
    });
    return pharmacy?.organizationId ?? null;
  }

  async findPharmacyIdsByOrganizationIds(organizationIds: string[]): Promise<string[]> {
    if (organizationIds.length === 0) {
      return [];
    }
    const pharmacies = await this.prisma.pharmacy.findMany({
      where: { organizationId: { in: organizationIds }, deletedAt: null },
      select: { id: true },
    });
    return pharmacies.map((p) => p.id);
  }
}
