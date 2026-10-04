import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CouponProductView,
  ICouponCatalogPort,
} from '../../application/ports/outbound/coupon-catalog.port';

/**
 * Module 07's own `ICouponCatalogPort` adapter — a direct, in-process `PrismaService` read of
 * Module 03's `products` and `product_categories`, never a Prisma relation (ADR-002). Own copy,
 * mirroring `modules/orders/infrastructure/catalog/catalog-port.adapter.ts`: `CatalogModule`
 * exports nothing, so every consumer builds its own.
 *
 * Read-only by construction. One query for the whole batch — a cart has many lines and a coupon
 * evaluation needs all of them, so a per-line lookup would put N round trips inside a money path.
 *
 * `categoryIds` is the reason this port exists at all: §7's coupon scope has a **category**
 * dimension, and the only sound source for "is this product in that category" is Module 03's own
 * join table. Taking a category claim from the request would let a client widen a coupon's scope.
 */
@Injectable()
export class CouponCatalogPortAdapter implements ICouponCatalogPort {
  constructor(private readonly prisma: PrismaService) {}

  async getProducts(productIds: readonly string[]): Promise<CouponProductView[]> {
    if (productIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.product.findMany({
      where: { id: { in: [...productIds] } },
      select: {
        id: true,
        status: true,
        price: true,
        categories: { select: { categoryId: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      price: row.price,
      categoryIds: row.categories.map((link) => link.categoryId),
    }));
  }
}
