import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IOrderPaperRepository, OrderPaperState } from '../../domain/repositories/order-paper.repository';

/** Work 136: Prisma adapter for `IOrderPaperRepository`. */
@Injectable()
export class PrismaOrderPaperRepository implements IOrderPaperRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: unknown): PrismaService | Prisma.TransactionClient {
    return (tx as Prisma.TransactionClient | undefined) ?? this.prisma;
  }

  async findByOrderId(orderId: string, tx?: unknown): Promise<OrderPaperState | null> {
    const row = await this.db(tx).order.findUnique({
      where: { id: orderId },
      select: { id: true, paperRxRequired: true, paperRxVerifiedAt: true, paperRxVerifiedById: true },
    });
    return row ? { orderId: row.id, paperRxRequired: row.paperRxRequired, paperRxVerifiedAt: row.paperRxVerifiedAt, paperRxVerifiedById: row.paperRxVerifiedById } : null;
  }

  async markVerified(orderId: string, userId: string, at: Date, tx?: unknown): Promise<boolean> {
    const result = await this.db(tx).order.updateMany({
      where: { id: orderId, paperRxRequired: true, paperRxVerifiedAt: null },
      data: { paperRxVerifiedAt: at, paperRxVerifiedById: userId },
    });
    return result.count === 1;
  }
}
