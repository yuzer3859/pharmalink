import { Injectable } from '@nestjs/common';
import { Prisma, Product as PrismaProduct } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CatalogErrors } from '../../domain/errors';
import { Product } from '../../domain/entities/product.entity';
import {
  ControlledSchedule,
  ProductStatus,
  ProductType,
  RxClassification,
  StorageRequirement,
} from '../../domain/enums';
import {
  DedupCriteria,
  IProductRepository,
  ProductSummaryRow,
  SearchProductsCriteria,
} from '../../domain/repositories/product.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toDomain(row: PrismaProduct): Product {
  return Product.rehydrate({
    id: row.id,
    type: row.type as unknown as ProductType,
    genericName: row.genericName,
    brandName: row.brandName,
    manufacturerId: row.manufacturerId,
    dosageForm: row.dosageForm,
    strengthValue: row.strengthValue,
    strengthUnit: row.strengthUnit,
    packSize: row.packSize,
    atcCode: row.atcCode,
    rxClassification: row.rxClassification as unknown as RxClassification | null,
    controlledSchedule: row.controlledSchedule as unknown as ControlledSchedule,
    onlineSaleProhibited: row.onlineSaleProhibited,
    storageRequirement: row.storageRequirement as unknown as StorageRequirement,
    equivalenceGroupId: row.equivalenceGroupId,
    nameAm: row.nameAm,
    nameEn: row.nameEn,
    descriptionAm: row.descriptionAm,
    descriptionEn: row.descriptionEn,
    warnings: row.warnings,
    price: row.price,
    status: row.status as unknown as ProductStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}

type SummaryRow = PrismaProduct & {
  manufacturer: { name: string } | null;
  categories: { categoryId: string }[];
};

function toSummaryView(row: SummaryRow): ProductSummaryRow {
  return {
    id: row.id,
    type: row.type,
    brandName: row.brandName,
    genericName: row.genericName,
    nameAm: row.nameAm,
    nameEn: row.nameEn,
    dosageForm: row.dosageForm,
    strengthValue: row.strengthValue,
    strengthUnit: row.strengthUnit,
    rxClassification: row.rxClassification,
    manufacturerName: row.manufacturer?.name ?? null,
    primaryCategoryId: row.categories[0]?.categoryId ?? null,
  };
}

const SUMMARY_INCLUDE = {
  manufacturer: { select: { name: true } },
  categories: { take: 1, select: { categoryId: true } },
} as const;

@Injectable()
export class PrismaProductRepository implements IProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: unknown): Promise<Product | null> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.product.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async create(product: Product, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = product.toProps();
    await client.product.create({
      data: {
        id: props.id,
        type: props.type as unknown as PrismaProduct['type'],
        genericName: props.genericName,
        brandName: props.brandName,
        manufacturerId: props.manufacturerId,
        dosageForm: props.dosageForm,
        strengthValue: props.strengthValue,
        strengthUnit: props.strengthUnit,
        packSize: props.packSize,
        atcCode: props.atcCode,
        rxClassification: props.rxClassification as unknown as PrismaProduct['rxClassification'],
        controlledSchedule: props.controlledSchedule as unknown as PrismaProduct['controlledSchedule'],
        onlineSaleProhibited: props.onlineSaleProhibited,
        storageRequirement: props.storageRequirement as unknown as PrismaProduct['storageRequirement'],
        equivalenceGroupId: props.equivalenceGroupId,
        nameAm: props.nameAm,
        nameEn: props.nameEn,
        descriptionAm: props.descriptionAm,
        descriptionEn: props.descriptionEn,
        warnings: props.warnings,
        price: props.price,
        status: props.status as unknown as PrismaProduct['status'],
        createdBy: props.createdBy,
      },
    });
  }

  async save(product: Product, tx?: unknown, expectedStatus?: ProductStatus): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = product.toProps();
    const data = {
      genericName: props.genericName,
      brandName: props.brandName,
      manufacturerId: props.manufacturerId,
      dosageForm: props.dosageForm,
      strengthValue: props.strengthValue,
      strengthUnit: props.strengthUnit,
      packSize: props.packSize,
      atcCode: props.atcCode,
      rxClassification: props.rxClassification as unknown as PrismaProduct['rxClassification'],
      controlledSchedule: props.controlledSchedule as unknown as PrismaProduct['controlledSchedule'],
      onlineSaleProhibited: props.onlineSaleProhibited,
      storageRequirement: props.storageRequirement as unknown as PrismaProduct['storageRequirement'],
      nameAm: props.nameAm,
      nameEn: props.nameEn,
      descriptionAm: props.descriptionAm,
      descriptionEn: props.descriptionEn,
      warnings: props.warnings,
      price: props.price,
      status: props.status as unknown as PrismaProduct['status'],
    };
    if (!expectedStatus) {
      await client.product.update({ where: { id: props.id }, data });
      return;
    }
    // Guarded write (module-16 Work 28): the row changes only while it still holds `expectedStatus`
    // — the precondition enforced by the UPDATE itself, not just by the read before it.
    const { count } = await client.product.updateMany({
      where: { id: props.id, status: expectedStatus as unknown as PrismaProduct['status'] },
      data,
    });
    if (count !== 1) {
      const current = await client.product.findUnique({ where: { id: props.id }, select: { status: true } });
      throw CatalogErrors.productNotInExpectedStatus(expectedStatus, String(current?.status ?? 'UNKNOWN'));
    }
  }

  async setCategories(productId: string, categoryIds: string[], tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    await client.productCategory.deleteMany({ where: { productId } });
    if (categoryIds.length > 0) {
      await client.productCategory.createMany({
        data: categoryIds.map((categoryId) => ({ productId, categoryId })),
      });
    }
  }

  async categoryIdsFor(productId: string): Promise<string[]> {
    const rows = await this.prisma.productCategory.findMany({
      where: { productId },
      select: { categoryId: true },
    });
    return rows.map((r) => r.categoryId);
  }

  async findDuplicateCandidate(
    criteria: DedupCriteria,
    excludeId: string | undefined,
    tx?: unknown,
  ): Promise<string | null> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.product.findFirst({
      where: {
        id: excludeId ? { not: excludeId } : undefined,
        type: ProductType.MEDICINE as unknown as PrismaProduct['type'],
        deletedAt: null,
        genericName: { equals: criteria.genericName, mode: 'insensitive' },
        strengthValue: criteria.strengthValue,
        strengthUnit: criteria.strengthUnit,
        dosageForm: criteria.dosageForm,
        manufacturerId: criteria.manufacturerId,
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async search(
    criteria: SearchProductsCriteria,
  ): Promise<{ items: ProductSummaryRow[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      status: ProductStatus.ACTIVE as unknown as PrismaProduct['status'],
      type: criteria.type as unknown as PrismaProduct['type'] | undefined,
      rxClassification: criteria.rx as unknown as PrismaProduct['rxClassification'] | undefined,
      manufacturerId: criteria.manufacturerId,
      categories: criteria.categoryId ? { some: { categoryId: criteria.categoryId } } : undefined,
    };

    if (criteria.q) {
      where.OR = [
        { genericName: { contains: criteria.q, mode: 'insensitive' } },
        { brandName: { contains: criteria.q, mode: 'insensitive' } },
        { nameEn: { contains: criteria.q, mode: 'insensitive' } },
        { nameAm: { contains: criteria.q, mode: 'insensitive' } },
      ];
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput =
      criteria.sort === 'name_asc'
        ? { genericName: 'asc' }
        : criteria.sort === 'newest'
          ? { createdAt: 'desc' }
          : { createdAt: 'desc' }; // "relevance" has no ranked read-model in Slice 1 (§5) — falls
    // back to newest-first, a reasonable default for direct browsing.

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: SUMMARY_INCLUDE,
        orderBy,
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items: (rows as SummaryRow[]).map(toSummaryView), total };
  }

  async listByCategory(
    categoryId: string,
    page: number,
    size: number,
  ): Promise<{ items: ProductSummaryRow[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      status: ProductStatus.ACTIVE as unknown as PrismaProduct['status'],
      categories: { some: { categoryId } },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: SUMMARY_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items: (rows as SummaryRow[]).map(toSummaryView), total };
  }

  async countByCategoryId(categoryId: string): Promise<number> {
    return this.prisma.product.count({
      where: {
        deletedAt: null,
        status: ProductStatus.ACTIVE as unknown as PrismaProduct['status'],
        categories: { some: { categoryId } },
      },
    });
  }
}
