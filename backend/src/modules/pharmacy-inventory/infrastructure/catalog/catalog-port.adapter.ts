import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CatalogProductView, ICatalogPort } from '../../application/ports/outbound/catalog.port';

/**
 * `ICatalogPort` adapter (module-04 §2) — a direct, in-process `PrismaService.product.findUnique`
 * read, never a Prisma relation (ADR-002). The transport is a query today and could become an
 * HTTP/gRPC client after a future extraction with no change to `application/`.
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
      type: product.type,
      status: product.status,
      rxClassification: product.rxClassification,
      controlledSchedule: product.controlledSchedule,
      onlineSaleProhibited: product.onlineSaleProhibited,
      storageRequirement: product.storageRequirement,
    };
  }
}
