import { Injectable } from '@nestjs/common';
import { StockMovementType } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IReservationStatusReadPort,
  ReservationStatusView,
} from '../../application/ports/inbound/reservation-status-read.port';

/** Explicit columns only; `dispatched` is a filtered DISPATCH-movement count (Module 04's own rule). */
@Injectable()
export class PrismaReservationStatusReadAdapter implements IReservationStatusReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async findReservations(reservationIds: string[]): Promise<ReservationStatusView[]> {
    const ids = [...new Set(reservationIds)];
    if (ids.length === 0) return [];
    const rows = await this.prisma.stockReservation.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        listingId: true,
        status: true,
        expiresAt: true,
        listing: { select: { branchId: true } },
        _count: { select: { movements: { where: { type: StockMovementType.DISPATCH } } } },
      },
    });
    return rows.map((r) => ({
      reservationId: r.id,
      listingId: r.listingId,
      branchId: r.listing.branchId,
      status: r.status as ReservationStatusView['status'],
      expiresAt: r.expiresAt,
      dispatched: r._count.movements > 0,
    }));
  }
}
