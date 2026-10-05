import { Injectable } from '@nestjs/common';
import { Prisma, Product as PrismaProduct } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ProductStatusPolicy } from '../../domain/services/product-status-policy';
import {
  CatalogAdminProductFilter,
  CatalogAdminProductPage,
  CatalogAdminProductRow,
  ICatalogAdminReadPort,
  ProductStatus,
  ProductType,
} from '../../application/ports/inbound/catalog-admin-read.port';

const ADMIN_ROW_SELECT = {
  id: true,
  type: true,
  genericName: true,
  brandName: true,
  nameAm: true,
  nameEn: true,
  dosageForm: true,
  strengthValue: true,
  strengthUnit: true,
  rxClassification: true,
  controlledSchedule: true,
  onlineSaleProhibited: true,
  price: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  manufacturer: { select: { name: true } },
} as const satisfies Prisma.ProductSelect;

type AdminRow = Prisma.ProductGetPayload<{ select: typeof ADMIN_ROW_SELECT }>;

/** The targets `ProductStatusPolicy` allows from `from`, in declaration order. */
function allowedFrom(from: ProductStatus): ProductStatus[] {
  return Object.values(ProductStatus).filter((to) => ProductStatusPolicy.isLegalTransition(from, to));
}

function toRow(row: AdminRow): CatalogAdminProductRow {
  const status = row.status as unknown as ProductStatus;
  return {
    id: row.id,
    type: row.type as unknown as ProductType,
    genericName: row.genericName,
    brandName: row.brandName,
    nameAm: row.nameAm,
    nameEn: row.nameEn,
    dosageForm: row.dosageForm,
    strengthValue: row.strengthValue,
    strengthUnit: row.strengthUnit,
    rxClassification: row.rxClassification,
    controlledSchedule: row.controlledSchedule,
    onlineSaleProhibited: row.onlineSaleProhibited,
    manufacturerName: row.manufacturer?.name ?? null,
    price: row.price,
    status,
    allowedTransitions: allowedFrom(status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * `ICatalogAdminReadPort` over Prisma — the same `deletedAt IS NULL` predicate and the same `q`
 * match `PrismaProductRepository.search` applies, without its `status = ACTIVE` restriction.
 * Oldest first, so a `DRAFT` page reads as a queue; `id` breaks ties so pages are stable.
 */
@Injectable()
export class PrismaCatalogAdminReadAdapter implements ICatalogAdminReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(
    filter: CatalogAdminProductFilter,
    page: number,
    size: number,
  ): Promise<CatalogAdminProductPage> {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      status: filter.status as unknown as PrismaProduct['status'],
      type: filter.type as unknown as PrismaProduct['type'] | undefined,
    };
    if (filter.q) {
      where.OR = [
        { genericName: { contains: filter.q, mode: 'insensitive' } },
        { brandName: { contains: filter.q, mode: 'insensitive' } },
        { nameEn: { contains: filter.q, mode: 'insensitive' } },
        { nameAm: { contains: filter.q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: ADMIN_ROW_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items: rows.map(toRow), total, page, size };
  }
}
