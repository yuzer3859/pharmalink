import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CatalogProductView, ICatalogPort } from '../../application/ports/outbound/catalog.port';

/**
 * `ICatalogPort` adapter (module-05 §2.1) — a direct, in-process `PrismaService.product.findUnique`
 * read, never a Prisma relation (ADR-002). Own copy per ADR-002, mirroring
 * `modules/pharmacy-inventory/infrastructure/catalog/catalog-port.adapter.ts` (Module 04's own
 * `ICatalogPort` adapter) rather than importing it — the shape is reused (`CatalogProductView`),
 * the implementation is not.
 *
 * A soft-deleted (`deletedAt` set) product is treated as not found, same as Module 04's adapter,
 * so `ApprovePrescriptionCommand`'s `catalogProductId` resolution (§5.2) and the Rx gate's
 * `rxClassification` lookup (§3.9/§8.2) never see a deleted product.
 */
@Injectable()
export class CatalogPortAdapter implements ICatalogPort {
  constructor(private readonly prisma: PrismaService) {}

  async getProduct(productId: string): Promise<CatalogProductView | null> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.deletedAt) {
      return null;
    }
    return {
      id: product.id,
      status: product.status,
      rxClassification: product.rxClassification,
    };
  }
}
