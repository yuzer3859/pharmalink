import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IPharmacyPort } from '../../application/ports/outbound/pharmacy.port';

/**
 * Module 07's own `IPharmacyPort` adapter — a direct, in-process `PrismaService.pharmacy` read of
 * Module 04's `pharmacies` table (ADR-002), projecting `id` alone.
 *
 * Soft-deleted pharmacies are treated as absent, consistently with Module 06's adapter. The
 * consequence is worth stating plainly, because this is a money surface: a deleted pharmacy's
 * statements become unreadable over HTTP. They are not deleted — the ledger and the statements
 * they were derived from are untouched, and finance's in-process path still reaches them. What
 * stops is one owner's ability to read them through an org membership that no longer resolves.
 */
@Injectable()
export class PharmacyPortAdapter implements IPharmacyPort {
  constructor(private readonly prisma: PrismaService) {}

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
