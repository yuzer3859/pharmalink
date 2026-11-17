import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DeliveryPaperState, IDeliveryPaperRepository } from '../../domain/repositories/delivery-paper.repository';

const SELECT = {
  id: true,
  orderId: true,
  fulfillmentId: true,
  status: true,
  assignedDriverId: true,
  paperRxRequired: true,
  paperCollectedAt: true,
  goodsReadyAt: true,
} as const;

type Row = Prisma.DeliveryJobGetPayload<{ select: typeof SELECT }>;

function toState(row: Row): DeliveryPaperState {
  return {
    jobId: row.id,
    orderId: row.orderId,
    fulfillmentId: row.fulfillmentId,
    status: row.status,
    assignedDriverId: row.assignedDriverId,
    paperRxRequired: row.paperRxRequired,
    paperCollectedAt: row.paperCollectedAt,
    goodsReadyAt: row.goodsReadyAt,
  };
}

/** Work 136: Prisma adapter for `IDeliveryPaperRepository`. */
@Injectable()
export class PrismaDeliveryPaperRepository implements IDeliveryPaperRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: unknown): PrismaService | Prisma.TransactionClient {
    return (tx as Prisma.TransactionClient | undefined) ?? this.prisma;
  }

  async findByJobId(jobId: string, tx?: unknown): Promise<DeliveryPaperState | null> {
    const row = await this.db(tx).deliveryJob.findUnique({ where: { id: jobId }, select: SELECT });
    return row ? toState(row) : null;
  }

  async findByFulfillmentId(fulfillmentId: string, tx?: unknown): Promise<DeliveryPaperState | null> {
    const row = await this.db(tx).deliveryJob.findFirst({ where: { fulfillmentId }, select: SELECT, orderBy: { createdAt: 'desc' } });
    return row ? toState(row) : null;
  }

  async markRequired(jobId: string, tx?: unknown): Promise<void> {
    await this.db(tx).deliveryJob.update({ where: { id: jobId }, data: { paperRxRequired: true } });
  }

  async markCollected(jobId: string, at: Date, tx?: unknown): Promise<boolean> {
    const result = await this.db(tx).deliveryJob.updateMany({ where: { id: jobId, paperRxRequired: true, paperCollectedAt: null }, data: { paperCollectedAt: at } });
    return result.count === 1;
  }

  async markGoodsReady(jobId: string, at: Date, tx?: unknown): Promise<void> {
    await this.db(tx).deliveryJob.updateMany({ where: { id: jobId, goodsReadyAt: null }, data: { goodsReadyAt: at } });
  }
}
