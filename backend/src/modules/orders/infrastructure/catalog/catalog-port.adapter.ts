import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CatalogProductView, ICatalogPort } from '../../application/ports/outbound/catalog.port';

/**
 * Module 06's own `ICatalogPort` adapter (`06-orders-spec.md` §5/§197) — a direct, in-process
 * `PrismaService.product.findUnique` read, never a Prisma relation (ADR-002). Own copy, mirroring
 * `modules/pharmacy-inventory/infrastructure/catalog/catalog-port.adapter.ts` and
 * `modules/prescription-matching/infrastructure/catalog/catalog-port.adapter.ts` rather than
 * importing either — `CatalogModule` exports nothing, so every consumer builds its own.
 *
 * A soft-deleted (`deletedAt` set) product is treated as not found, identical to Modules 04/05's
 * adapters, so the checkout saga never prices a deleted product.
 *
 * **Unpriced products are reported as not found.** Module 06's `CatalogProductView` is the first
 * to require `price` (Modules 04/05 need only `status`/`rxClassification`), and `Product.price` is
 * nullable — a product nobody has priced yet cannot be converted into an `OrderLine.unitPrice`.
 * Returning `null` routes it into `CheckoutCommand`'s existing `catalogProductUnavailable()`
 * (`CATALOG_PRODUCT_NOT_FOUND`) branch — the same branch a non-`ACTIVE` product already takes — so
 * no new error code is introduced and no order is ever placed at an invented price.
 *
 * `name` is resolved `nameEn -> genericName -> brandName`, the display-name precedence
 * `productSnapshot`/`PriceSnapshot` (§3.10) needs; `Product` has no single `name` column.
 */
@Injectable()
export class CatalogPortAdapter implements ICatalogPort {
  constructor(private readonly prisma: PrismaService) {}

  async getProduct(productId: string): Promise<CatalogProductView | null> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.deletedAt || product.price === null) {
      return null;
    }
    return {
      id: product.id,
      status: product.status,
      rxClassification: product.rxClassification,
      price: product.price,
      name: product.nameEn ?? product.genericName ?? product.brandName ?? '',
    };
  }
}
