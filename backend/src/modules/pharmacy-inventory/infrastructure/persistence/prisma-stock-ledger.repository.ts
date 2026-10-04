import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { StockBatchProps } from '../../domain/entities/stock-batch.entity';
import { StockMovementProps } from '../../domain/entities/stock-movement.entity';
import {
  IStockLedgerRepository,
  NewMovementInput,
} from '../../domain/repositories/stock-ledger.repository';

type Client = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PrismaStockLedgerRepository implements IStockLedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async addBatch(
    batch: Omit<StockBatchProps, 'createdAt'> & { id: string },
    tx?: unknown,
  ): Promise<void> {
    await this.client(tx).stockBatch.create({
      data: {
        id: batch.id,
        listingId: batch.listingId,
        batchNumber: batch.batchNumber,
        quantity: batch.quantity,
        expiryDate: batch.expiryDate,
        supplier: batch.supplier,
        receivedAt: batch.receivedAt,
      },
    });
  }

  async findBatchById(id: string, tx?: unknown): Promise<StockBatchProps | null> {
    return this.client(tx).stockBatch.findUnique({ where: { id } });
  }

  async lockBatchForUpdate(id: string, tx: unknown): Promise<StockBatchProps | null> {
    const client = tx as Prisma.TransactionClient;
    const rows = await client.$queryRaw<StockBatchProps[]>`
      SELECT * FROM "stock_batches" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async findBatchesByListing(listingId: string, tx?: unknown): Promise<StockBatchProps[]> {
    return this.client(tx).stockBatch.findMany({
      where: { listingId, quantity: { gt: 0 } },
      orderBy: { expiryDate: 'asc' },
    });
  }

  async lockBatchesForListing(listingId: string, tx: unknown): Promise<StockBatchProps[]> {
    const client = tx as Prisma.TransactionClient;
    return client.$queryRaw<StockBatchProps[]>`
      SELECT * FROM "stock_batches"
      WHERE "listingId" = ${listingId} AND "quantity" > 0
      ORDER BY "expiryDate" ASC
      FOR UPDATE
    `;
  }

  async adjustBatchQuantity(batchId: string, newQuantity: number, tx?: unknown): Promise<void> {
    await this.client(tx).stockBatch.update({ where: { id: batchId }, data: { quantity: newQuantity } });
  }

  async recordMovement(movement: NewMovementInput & { id: string }, tx?: unknown): Promise<void> {
    await this.client(tx).stockMovement.create({
      data: {
        id: movement.id,
        listingId: movement.listingId,
        batchId: movement.batchId ?? null,
        type: movement.type,
        quantityDelta: movement.quantityDelta,
        reason: movement.reason ?? null,
        refType: movement.refType ?? null,
        refId: movement.refId ?? null,
        actorUserId: movement.actorUserId ?? null,
        reservationId: movement.reservationId ?? null,
      },
    });
  }

  async listMovements(
    listingId: string,
    page: number,
    size: number,
    tx?: unknown,
  ): Promise<{ items: StockMovementProps[]; total: number }> {
    const client = this.client(tx);
    const where = { listingId };
    const [items, total] = await Promise.all([
      client.stockMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
      client.stockMovement.count({ where }),
    ]);
    return { items, total };
  }

  async sumMovementDeltas(listingId: string, tx?: unknown): Promise<number> {
    const result = await this.client(tx).stockMovement.aggregate({
      where: { listingId },
      _sum: { quantityDelta: true },
    });
    return result._sum.quantityDelta ?? 0;
  }
}
