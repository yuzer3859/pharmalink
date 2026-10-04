import { Injectable } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { StockReservationProps } from '../../domain/entities/stock-reservation.entity';
import { ReservationStatus } from '../../domain/enums';
import {
  IReservationRepository,
  NewReservationInput,
} from '../../domain/repositories/reservation.repository';

type Client = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PrismaReservationRepository implements IReservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<StockReservationProps | null> {
    return this.client(tx).stockReservation.findUnique({ where: { id } });
  }

  /**
   * `SELECT ... FOR UPDATE` on a single reservation row — see the lock-ordering comment on
   * `IReservationRepository`. Requires an interactive transaction client.
   */
  async lockForUpdate(id: string, tx: unknown): Promise<StockReservationProps | null> {
    const client = tx as Prisma.TransactionClient;
    const rows = await client.$queryRaw<StockReservationProps[]>`
      SELECT * FROM "stock_reservations" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async findByIdempotencyKey(
    listingId: string,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<StockReservationProps | null> {
    return this.client(tx).stockReservation.findUnique({
      where: { listingId_idempotencyKey: { listingId, idempotencyKey } },
    });
  }

  async create(reservation: NewReservationInput, tx?: unknown): Promise<void> {
    await this.client(tx).stockReservation.create({
      data: {
        id: reservation.id,
        listingId: reservation.listingId,
        orderId: reservation.orderId,
        quantity: reservation.quantity,
        expiresAt: reservation.expiresAt,
        idempotencyKey: reservation.idempotencyKey,
        status: ReservationStatus.HELD,
      },
    });
  }

  async updateStatus(id: string, status: ReservationStatus, tx?: unknown): Promise<void> {
    await this.client(tx).stockReservation.update({ where: { id }, data: { status } });
  }

  async lockNextExpired(
    now: Date,
    excludeIds: string[],
    tx: unknown,
  ): Promise<StockReservationProps | null> {
    const client = tx as Prisma.TransactionClient;
    const rows = await client.$queryRaw<StockReservationProps[]>`
      SELECT * FROM "stock_reservations"
      WHERE "status" = 'HELD' AND "expiresAt" < ${now}
        AND NOT ("id" = ANY(${excludeIds}::text[]))
      ORDER BY "expiresAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    return rows[0] ?? null;
  }

  async findDispatchMovements(
    reservationId: string,
    tx?: unknown,
  ): Promise<Array<{ batchId: string | null; qty: number }>> {
    const rows = await this.client(tx).stockMovement.findMany({
      where: { type: StockMovementType.DISPATCH, reservationId },
    });
    return rows.map((r) => ({ batchId: r.batchId, qty: Math.abs(r.quantityDelta) }));
  }
}
