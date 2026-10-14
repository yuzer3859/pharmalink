import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IStockMovementOperationsReadPort,
  StockMovementOperationsFilter,
  StockMovementOperationsPage,
  StockMovementOperationsView,
} from '../../application/ports/inbound/stock-movement-operations-read.port';

/** The columns a view needs — selected explicitly, so `reason`, `refId`, `reservationId` and `actorUserId` are never read. */
const SELECT = {
  id: true,
  listingId: true,
  batchId: true,
  type: true,
  quantityDelta: true,
  refType: true,
  createdAt: true,
  listing: { select: { pharmacyId: true, branchId: true, catalogProductId: true } },
} satisfies Prisma.StockMovementSelect;

type Row = Prisma.StockMovementGetPayload<{ select: typeof SELECT }>;

const toView = (r: Row): StockMovementOperationsView => ({
  movementId: r.id,
  listingId: r.listingId,
  pharmacyId: r.listing.pharmacyId,
  branchId: r.listing.branchId,
  catalogProductId: r.listing.catalogProductId,
  batchId: r.batchId,
  type: r.type,
  quantityDelta: r.quantityDelta,
  refType: r.refType,
  createdAt: r.createdAt,
});

/**
 * `IStockMovementOperationsReadPort` over Prisma — `SELECT`s on `stock_movements` with its one listing
 * (a required many-to-one relation, so a movement is never repeated). The list is one paged `findMany`
 * and one `count` over the same `where`, in one REPEATABLE READ transaction so the page and its total
 * agree. No balance is computed.
 */
@Injectable()
export class PrismaStockMovementOperationsReadAdapter implements IStockMovementOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listMovements(f: StockMovementOperationsFilter, page: number, size: number): Promise<StockMovementOperationsPage> {
    const listing = {
      ...(f.pharmacyId ? { pharmacyId: f.pharmacyId } : {}),
      ...(f.branchId ? { branchId: f.branchId } : {}),
    };
    const where: Prisma.StockMovementWhereInput = {
      ...(f.listingId ? { listingId: f.listingId } : {}),
      ...(f.batchId ? { batchId: f.batchId } : {}),
      ...(f.type ? { type: f.type } : {}),
      ...(Object.keys(listing).length ? { listing } : {}),
      ...(f.createdFrom || f.createdTo
        ? { createdAt: { ...(f.createdFrom ? { gte: f.createdFrom } : {}), ...(f.createdTo ? { lt: f.createdTo } : {}) } }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.stockMovement.findMany({
          where,
          select: SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * size,
          take: size,
        }),
        this.prisma.stockMovement.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { items: rows.map(toView), total, page, size };
  }

  async getMovement(movementId: string): Promise<StockMovementOperationsView | null> {
    const row = await this.prisma.stockMovement.findUnique({ where: { id: movementId }, select: SELECT });
    return row ? toView(row) : null;
  }
}
