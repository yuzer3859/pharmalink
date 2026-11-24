import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DuplicatePictureSuggestionError,
  IPictureSuggestionStore,
  PictureSuggestionReviewRow,
  PictureSuggestionRow,
  PictureSuggestionStatus,
} from '../../application/ports/picture-suggestion.store';

/**
 * Work 151: `product_image_suggestions`. The review list reads the pharmacy's display name from
 * Module 04's `pharmacies` table with a plain query, never a relation (ADR-002).
 */
@Injectable()
export class PrismaPictureSuggestionStore implements IPictureSuggestionStore {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: { productId: string; pharmacyId: string; url: string; suggestedById: string }): Promise<PictureSuggestionRow> {
    try {
      return (await this.prisma.productImageSuggestion.create({ data: input })) as PictureSuggestionRow;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DuplicatePictureSuggestionError();
      throw error;
    }
  }

  countPending(pharmacyId: string, productId: string): Promise<number> {
    return this.prisma.productImageSuggestion.count({ where: { pharmacyId, productId, status: 'PENDING' } });
  }

  async findById(id: string): Promise<PictureSuggestionRow | null> {
    return (await this.prisma.productImageSuggestion.findUnique({ where: { id } })) as PictureSuggestionRow | null;
  }

  async forPharmacy(pharmacyId: string, productId: string, limit: number): Promise<PictureSuggestionRow[]> {
    return (await this.prisma.productImageSuggestion.findMany({
      where: { pharmacyId, productId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })) as PictureSuggestionRow[];
  }

  async listForReview(input: { status: PictureSuggestionStatus; skip: number; take: number }): Promise<{ items: PictureSuggestionReviewRow[]; total: number }> {
    const where = { status: input.status };
    const [rows, total] = await Promise.all([
      this.prisma.productImageSuggestion.findMany({
        where,
        orderBy: input.status === 'PENDING' ? { createdAt: 'asc' } : { decidedAt: 'desc' },
        skip: input.skip,
        take: input.take,
        include: { product: { select: { nameEn: true, genericName: true, brandName: true, _count: { select: { images: true } } } } },
      }),
      this.prisma.productImageSuggestion.count({ where }),
    ]);
    const pharmacies = await this.prisma.pharmacy.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.pharmacyId))] } },
      select: { id: true, displayName: true },
    });
    const names = new Map(pharmacies.map((p) => [p.id, p.displayName]));
    return {
      total,
      items: rows.map(({ product, ...row }) => ({
        ...(row as PictureSuggestionRow),
        productName: product.nameEn ?? product.genericName ?? product.brandName ?? null,
        pharmacyName: names.get(row.pharmacyId) ?? null,
        productPictureCount: product._count.images,
      })),
    };
  }

  async decide(id: string, input: { status: 'APPROVED' | 'REJECTED'; decidedById: string; reason: string | null }): Promise<boolean> {
    const { count } = await this.prisma.productImageSuggestion.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: input.status, decidedById: input.decidedById, decisionReason: input.reason, decidedAt: new Date() },
    });
    return count === 1;
  }

  async reopen(id: string): Promise<void> {
    await this.prisma.productImageSuggestion.update({
      where: { id },
      data: { status: 'PENDING', decidedById: null, decisionReason: null, decidedAt: null },
    });
  }
}
