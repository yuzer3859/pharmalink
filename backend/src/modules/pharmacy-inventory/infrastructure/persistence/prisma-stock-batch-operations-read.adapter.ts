import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IStockBatchOperationsReadPort,
  StockBatchOperationsDetail,
  StockBatchOperationsFilter,
  StockBatchOperationsPage,
  StockBatchOperationsView,
} from '../../application/ports/inbound/stock-batch-operations-read.port';

/** The columns a view needs — selected explicitly, so `batchNumber` and `supplier` are never read. */
const SELECT = {
  id: true,
  listingId: true,
  quantity: true,
  expiryDate: true,
  receivedAt: true,
  createdAt: true,
  listing: { select: { pharmacyId: true, branchId: true, catalogProductId: true } },
} satisfies Prisma.StockBatchSelect;

type Row = Prisma.StockBatchGetPayload<{ select: typeof SELECT }>;

/**
 * Expired at `now` — the complement of `SellableStockCalculator.computeSellable`'s
 * `expiryDate.getTime() > now.getTime()` filter (and of the SQL `sb."expiryDate" > now`). Written once
 * here for this read, and checked against the calculator in its unit tests.
 */
export function isBatchExpired(expiryDate: Date, now: Date): boolean {
  return expiryDate.getTime() <= now.getTime();
}

const toView = (r: Row, now: Date): StockBatchOperationsView => ({
  batchId: r.id,
  listingId: r.listingId,
  pharmacyId: r.listing.pharmacyId,
  branchId: r.listing.branchId,
  catalogProductId: r.listing.catalogProductId,
  quantity: r.quantity,
  expiryDate: r.expiryDate,
  isExpired: isBatchExpired(r.expiryDate, now),
  receivedAt: r.receivedAt,
  createdAt: r.createdAt,
});

/**
 * `IStockBatchOperationsReadPort` over Prisma — `SELECT`s on `stock_batches` with its one listing (a
 * required many-to-one relation, so a batch is never repeated; movements and reservations are not
 * joined). The list is one paged `findMany` and one `count` over the same `where`, in one REPEATABLE
 * READ transaction; the `isExpired` filter and every row's `isExpired` use the same `now`, returned as
 * `generatedAt`.
 */
@Injectable()
export class PrismaStockBatchOperationsReadAdapter implements IStockBatchOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listBatches(f: StockBatchOperationsFilter, page: number, size: number, now: Date = new Date()): Promise<StockBatchOperationsPage> {
    const expiry: Prisma.StockBatchWhereInput[] = [];
    if (f.expiresFrom || f.expiresTo) {
      expiry.push({ expiryDate: { ...(f.expiresFrom ? { gte: f.expiresFrom } : {}), ...(f.expiresTo ? { lt: f.expiresTo } : {}) } });
    }
    if (f.isExpired !== undefined) expiry.push({ expiryDate: f.isExpired ? { lte: now } : { gt: now } });
    const where: Prisma.StockBatchWhereInput = {
      listing: {
        deletedAt: null,
        ...(f.pharmacyId ? { pharmacyId: f.pharmacyId } : {}),
        ...(f.branchId ? { branchId: f.branchId } : {}),
        ...(f.catalogProductId ? { catalogProductId: f.catalogProductId } : {}),
      },
      ...(f.listingId ? { listingId: f.listingId } : {}),
      ...(expiry.length ? { AND: expiry } : {}),
      ...(f.createdFrom || f.createdTo
        ? { createdAt: { ...(f.createdFrom ? { gte: f.createdFrom } : {}), ...(f.createdTo ? { lt: f.createdTo } : {}) } }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.stockBatch.findMany({
          where,
          select: SELECT,
          orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * size,
          take: size,
        }),
        this.prisma.stockBatch.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { generatedAt: now, items: rows.map((r) => toView(r, now)), total, page, size };
  }

  async getBatch(batchId: string, now: Date = new Date()): Promise<StockBatchOperationsDetail | null> {
    const row = await this.prisma.stockBatch.findFirst({ where: { id: batchId, listing: { deletedAt: null } }, select: SELECT });
    return row ? { generatedAt: now, batch: toView(row, now) } : null;
  }
}
