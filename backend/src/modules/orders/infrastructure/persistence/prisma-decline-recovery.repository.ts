import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeclineCandidateOrder,
  IDeclineRecoveryRepository,
} from '../../domain/repositories/decline-recovery.repository';

/** Live, declined at least once, and not being cancelled by the customer (a REJECTED request does not count). */
const CANDIDATE: Prisma.OrderWhereInput = {
  status: { in: ['PAID', 'ACCEPTED'] },
  fulfillments: { some: { status: 'CANCELLED' } },
  OR: [{ cancellationRequest: { is: null } }, { cancellationRequest: { is: { phase: 'REJECTED' } } }],
};

const SELECT = {
  id: true,
  status: true,
  fulfillments: { select: { id: true, status: true, pharmacyId: true, branchId: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
  lines: { select: { id: true, fulfillmentId: true, pharmacyId: true, branchId: true, reservationId: true, createdAt: true }, orderBy: { id: 'asc' } },
} satisfies Prisma.OrderSelect;

type Row = Prisma.OrderGetPayload<{ select: typeof SELECT }>;

const toCandidate = (r: Row): DeclineCandidateOrder => ({
  id: r.id,
  status: r.status,
  fulfillments: r.fulfillments.map((f) => ({ ...f, status: f.status as string })),
  lines: r.lines,
});

/** Decline-recovery candidates from Module 06's own tables (Work 55). Short reads, no locks. */
@Injectable()
export class PrismaDeclineRecoveryRepository implements IDeclineRecoveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listCandidates(afterOrderId: string | null, limit: number): Promise<DeclineCandidateOrder[]> {
    const rows = await this.prisma.order.findMany({
      where: { ...CANDIDATE, ...(afterOrderId ? { id: { gt: afterOrderId } } : {}) },
      select: SELECT,
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map(toCandidate);
  }

  async pageCandidates(skip: number, take: number): Promise<{ orders: DeclineCandidateOrder[]; total: number }> {
    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.order.findMany({ where: CANDIDATE, select: SELECT, orderBy: { id: 'asc' }, skip, take }),
        this.prisma.order.count({ where: CANDIDATE }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { orders: rows.map(toCandidate), total };
  }

  async findCandidate(orderId: string): Promise<DeclineCandidateOrder | null> {
    const row = await this.prisma.order.findFirst({ where: { ...CANDIDATE, id: orderId }, select: SELECT });
    return row ? toCandidate(row) : null;
  }
}
