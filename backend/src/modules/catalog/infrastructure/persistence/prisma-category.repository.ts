import { Injectable } from '@nestjs/common';
import { Category as PrismaCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { Category } from '../../domain/entities/category.entity';
import { CategoryAppliesTo, MAX_CATEGORY_DEPTH } from '../../domain/enums';
import { ICategoryRepository } from '../../domain/repositories/category.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toDomain(row: PrismaCategory): Category {
  return Category.rehydrate({
    id: row.id,
    parentId: row.parentId,
    slug: row.slug,
    nameAm: row.nameAm,
    nameEn: row.nameEn,
    appliesTo: row.appliesTo as unknown as CategoryAppliesTo,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  });
}

@Injectable()
export class PrismaCategoryRepository implements ICategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: unknown): Promise<Category | null> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.category.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findBySlug(slug: string): Promise<Category | null> {
    const row = await this.prisma.category.findUnique({ where: { slug } });
    return row ? toDomain(row) : null;
  }

  async create(category: Category, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = category.toProps();
    await client.category.create({
      data: {
        id: props.id,
        parentId: props.parentId,
        slug: props.slug,
        nameAm: props.nameAm,
        nameEn: props.nameEn,
        appliesTo: props.appliesTo as unknown as PrismaCategory['appliesTo'],
        sortOrder: props.sortOrder,
        isActive: props.isActive,
      },
    });
  }

  async save(category: Category, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = category.toProps();
    await client.category.update({
      where: { id: props.id },
      data: {
        parentId: props.parentId,
        nameAm: props.nameAm,
        nameEn: props.nameEn,
        appliesTo: props.appliesTo as unknown as PrismaCategory['appliesTo'],
        sortOrder: props.sortOrder,
        isActive: props.isActive,
      },
    });
  }

  async listActive(): Promise<Category[]> {
    const rows = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map(toDomain);
  }

  async listAll(): Promise<Category[]> {
    const rows = await this.prisma.category.findMany({ orderBy: { sortOrder: 'asc' } });
    return rows.map(toDomain);
  }

  async findManyByIds(ids: string[]): Promise<Category[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.category.findMany({ where: { id: { in: ids } } });
    return rows.map(toDomain);
  }

  /** Walks `parentId` up to the root, starting at (and including) `categoryId` itself. Bounded
   * to `MAX_CATEGORY_DEPTH + 1` hops as a defensive guard against corrupted/cyclic data. */
  async getAncestorChain(categoryId: string): Promise<string[]> {
    const chain: string[] = [];
    let currentId: string | null = categoryId;
    let hops = 0;

    while (currentId && hops <= MAX_CATEGORY_DEPTH + 1) {
      chain.push(currentId);
      const row: Pick<PrismaCategory, 'parentId'> | null = await this.prisma.category.findUnique({
        where: { id: currentId },
        select: { parentId: true },
      });
      currentId = row?.parentId ?? null;
      hops += 1;
    }

    return chain;
  }
}
