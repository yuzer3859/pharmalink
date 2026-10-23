import { Injectable } from '@nestjs/common';
import { OrderCancellationPhase, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CancellationOperationsPage,
  CancellationOperationsState,
  IOrderCancellationOperationsReadPort,
} from '../../application/ports/inbound/order-cancellation-operations-read.port';
import { OPEN_CANCELLATION_PHASES } from '../../domain/repositories/order-cancellation-request.repository';

const OPEN = { phase: { in: OPEN_CANCELLATION_PHASES as OrderCancellationPhase[] } } satisfies Prisma.OrderCancellationRequestWhereInput;
const stateWhere = (state: CancellationOperationsState): Prisma.OrderCancellationRequestWhereInput =>
  state === 'ATTENTION' ? { ...OPEN, attentionRequiredAt: { not: null } } : { ...OPEN, attentionRequiredAt: null };

/** Explicit columns only: never `customerUserId`, `reason` or the lease. */
const SELECT = {
  id: true, orderId: true, phase: true, attempts: true, lastErrorCode: true, lastErrorAt: true,
  nextAttemptAt: true, attentionRequiredAt: true, createdAt: true, updatedAt: true,
} satisfies Prisma.OrderCancellationRequestSelect;

/** Work 55 operations read: one REPEATABLE READ snapshot for the page, its total and both counts. */
@Injectable()
export class PrismaOrderCancellationOperationsReadAdapter implements IOrderCancellationOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: { state?: CancellationOperationsState }, page: number, size: number): Promise<CancellationOperationsPage> {
    const generatedAt = new Date();
    const where = filter.state ? stateWhere(filter.state) : OPEN;
    const [rows, total, pending, attention] = await this.prisma.$transaction(
      [
        this.prisma.orderCancellationRequest.findMany({
          where, select: SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * size, take: size,
        }),
        this.prisma.orderCancellationRequest.count({ where }),
        this.prisma.orderCancellationRequest.count({ where: stateWhere('PENDING') }),
        this.prisma.orderCancellationRequest.count({ where: stateWhere('ATTENTION') }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      generatedAt,
      counts: { pending, attention },
      items: rows.map((r) => ({
        requestId: r.id,
        orderId: r.orderId,
        state: r.attentionRequiredAt ? 'ATTENTION' : 'PENDING',
        phase: r.phase,
        attempts: r.attempts,
        lastErrorCode: r.lastErrorCode,
        lastErrorAt: r.lastErrorAt,
        nextAttemptAt: r.nextAttemptAt,
        attentionRequiredAt: r.attentionRequiredAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total,
      page,
      size,
    };
  }
}
