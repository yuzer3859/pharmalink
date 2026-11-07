import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ICatalogSearchSourcePort, SearchProductSource } from '../../application/ports/inbound/catalog-search-source.port';

/** Work 98: Module 03's search source, over its own tables. */
@Injectable()
export class PrismaCatalogSearchSourceAdapter implements ICatalogSearchSourcePort {
  constructor(private readonly prisma: PrismaService) {}

  async product(productId: string): Promise<SearchProductSource | null> {
    const row = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { manufacturer: { select: { name: true } }, categories: { include: { category: true } } },
    });
    if (!row) return null;
    const strength = row.strengthValue !== null ? `${row.strengthValue}${row.strengthUnit ?? ''}` : null;
    return {
      productId: row.id,
      type: row.type,
      status: row.status,
      searchable: row.deletedAt === null && row.status === 'ACTIVE',
      nameEn: row.nameEn,
      nameAm: row.nameAm,
      genericName: row.genericName,
      brandName: row.brandName,
      manufacturer: row.manufacturer?.name ?? null,
      dosageForm: row.dosageForm,
      strength,
      rxClassification: row.rxClassification,
      controlledSchedule: row.controlledSchedule,
      onlineSaleProhibited: row.onlineSaleProhibited,
      categories: row.categories.map((pc) => ({
        categoryId: pc.category.id,
        slug: pc.category.slug,
        nameEn: pc.category.nameEn,
        nameAm: pc.category.nameAm,
      })),
    };
  }

  async productIds(): Promise<string[]> {
    return (await this.prisma.product.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } })).map((p) => p.id);
  }

  async productsInCategory(categoryId: string): Promise<string[]> {
    return (await this.prisma.productCategory.findMany({ where: { categoryId }, select: { productId: true } })).map((r) => r.productId);
  }
}
