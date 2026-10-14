import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IStockReservationOperationsReadPort,
  ReservationStatus,
  StockReservationOperationsDetail,
  StockReservationOperationsFilter,
  StockReservationOperationsPage,
  StockReservationOperationsView,
} from '../../application/ports/inbound/stock-reservation-operations-read.port';
import { StockMovementType } from '../../domain/enums';

/**
 * The columns a view needs — selected explicitly, so `orderId` and `idempotencyKey` are never read.
 * `dispatched` is a filtered relation count (one sub-count per row, in the same statement): no movement
 * row is loaded and no reservation is repeated.
 */
const SELECT = {
  id: true,
  listingId: true,
  quantity: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  listing: { select: { pharmacyId: true, branchId: true, catalogProductId: true } },
  _count: { select: { movements: { where: { type: StockMovementType.DISPATCH } } } },
} satisfies Prisma.StockReservationSelect;

type Row = Prisma.StockReservationGetPayload<{ select: typeof SELECT }>;

/**
 * The TTL sweeper's selection rule (`PrismaReservationRepository.lockNextExpired`:
 * `status = 'HELD' AND expiresAt < now`), as a predicate and as a filter. Strictly less-than, as there.
 */
export function isHeldPastExpiry(status: ReservationStatus, expiresAt: Date, now: Date): boolean {
  return status === ReservationStatus.HELD && expiresAt.getTime() < now.getTime();
}
const heldPastExpiryWhere = (now: Date): Prisma.StockReservationWhereInput => ({ status: ReservationStatus.HELD, expiresAt: { lt: now } });

const toView = (r: Row, now: Date): StockReservationOperationsView => ({
  reservationId: r.id,
  listingId: r.listingId,
  pharmacyId: r.listing.pharmacyId,
  branchId: r.listing.branchId,
  catalogProductId: r.listing.catalogProductId,
  quantity: r.quantity,
  status: r.status,
  expiresAt: r.expiresAt,
  heldPastExpiry: isHeldPastExpiry(r.status, r.expiresAt, now),
  dispatched: r._count.movements > 0,
  createdAt: r.createdAt,
});

/**
 * `IStockReservationOperationsReadPort` over Prisma — `SELECT`s on `stock_reservations` with its one
 * listing (a required many-to-one relation). The list is one paged `findMany` and one `count` over the
 * same `where`, in one REPEATABLE READ transaction; the `heldPastExpiry` filter and every row's flag use
 * the same `now`, returned as `generatedAt`. Nothing is written — a lapsed hold stays `HELD` until the
 * sweeper expires it.
 */
@Injectable()
export class PrismaStockReservationOperationsReadAdapter implements IStockReservationOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listReservations(f: StockReservationOperationsFilter, page: number, size: number, now: Date = new Date()): Promise<StockReservationOperationsPage> {
    const listing = {
      ...(f.pharmacyId ? { pharmacyId: f.pharmacyId } : {}),
      ...(f.branchId ? { branchId: f.branchId } : {}),
    };
    const where: Prisma.StockReservationWhereInput = {
      ...(f.listingId ? { listingId: f.listingId } : {}),
      ...(Object.keys(listing).length ? { listing } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.heldPastExpiry === undefined ? {} : f.heldPastExpiry ? { AND: [heldPastExpiryWhere(now)] } : { NOT: [heldPastExpiryWhere(now)] }),
      ...(f.createdFrom || f.createdTo
        ? { createdAt: { ...(f.createdFrom ? { gte: f.createdFrom } : {}), ...(f.createdTo ? { lt: f.createdTo } : {}) } }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.stockReservation.findMany({
          where,
          select: SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * size,
          take: size,
        }),
        this.prisma.stockReservation.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { generatedAt: now, items: rows.map((r) => toView(r, now)), total, page, size };
  }

  async getReservation(reservationId: string, now: Date = new Date()): Promise<StockReservationOperationsDetail | null> {
    const row = await this.prisma.stockReservation.findUnique({ where: { id: reservationId }, select: SELECT });
    return row ? { generatedAt: now, reservation: toView(row, now) } : null;
  }
}
