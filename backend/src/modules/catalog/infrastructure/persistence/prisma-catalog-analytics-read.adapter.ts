import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CatalogAnalyticsView,
  ICatalogAnalyticsReadPort,
  ProductStatus,
} from '../../application/ports/inbound/catalog-analytics-read.port';

/**
 * `ICatalogAnalyticsReadPort` over Prisma — one `GROUP BY` in PostgreSQL, with the same
 * `deletedAt IS NULL` predicate `PrismaProductRepository` applies to every read.
 */
@Injectable()
export class PrismaCatalogAnalyticsReadAdapter implements ICatalogAnalyticsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeCatalog(): Promise<CatalogAnalyticsView> {
    const groups = await this.prisma.product.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    const counts = new Map(groups.map((g) => [g.status as string, g._count._all]));
    const byStatus = Object.values(ProductStatus).map((status) => ({
      status,
      count: counts.get(status) ?? 0,
    }));
    return {
      products: {
        total: byStatus.reduce((sum, bucket) => sum + bucket.count, 0),
        byStatus,
      },
    };
  }
}
