import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ICatalogPort } from '../../application/ports/outbound/catalog.port';

/** Module 03's `StorageRequirement` value that makes a delivery cold-chain (BRULE-30). */
const COLD_CHAIN = 'COLD_CHAIN';

/**
 * Module 08's own `ICatalogPort` adapter — a direct, in-process `PrismaService.product` read of
 * Module 03's `products` (ADR-002), never a Prisma relation. Own copy, mirroring Modules 04, 05
 * and 06.
 *
 * It selects `id` alone and filters on `storageRequirement` in the query, so the only information
 * that crosses the boundary is the answer to the one question asked. A product's name, price and
 * Rx classification never enter the delivery module through this path.
 */
@Injectable()
export class CatalogPortAdapter implements ICatalogPort {
  constructor(private readonly prisma: PrismaService) {}

  async findColdChainProductIds(catalogProductIds: string[]): Promise<string[]> {
    if (catalogProductIds.length === 0) {
      // Never issue an unscoped query: `in: []` would be correct here, but an empty input is a
      // caller with nothing to ask, and answering it without a round trip is both faster and
      // impossible to get wrong.
      return [];
    }
    const rows = await this.prisma.product.findMany({
      where: { id: { in: catalogProductIds }, storageRequirement: COLD_CHAIN },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}
