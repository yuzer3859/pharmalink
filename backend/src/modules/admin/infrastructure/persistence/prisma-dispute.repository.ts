import { Injectable } from '@nestjs/common';
import { DisputeCase, DisputeMessage, DisputePriority, DisputeStatus, DisputeType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';

type Client = PrismaService | Prisma.TransactionClient;

export const DISPUTE_REPOSITORY = Symbol('DISPUTE_REPOSITORY');

export type DisputeCaseRow = DisputeCase;
export type DisputeMessageRow = DisputeMessage;

export interface DisputeSearch {
  status?: DisputeStatus;
  type?: DisputeType;
  priority?: DisputePriority;
  assignedAdminId?: string;
  complainantUserId?: string;
  transactionId?: string;
  overdueAt?: Date;
}

/** `dispute_cases` and `dispute_messages` (Work 86). Admin's own tables. */
@Injectable()
export class PrismaDisputeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `null` when an open case already exists for the same transaction and type. */
  async create(data: Prisma.DisputeCaseUncheckedCreateInput, tx?: unknown): Promise<DisputeCaseRow | null> {
    try {
      return await this.client(tx).disputeCase.create({ data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = JSON.stringify(err.meta?.target ?? '');
        if (target.includes('caseNumber')) throw err;
        return null;
      }
      throw err;
    }
  }

  findOpenFor(transactionId: string, type: DisputeType): Promise<DisputeCaseRow | null> {
    return this.prisma.disputeCase.findFirst({
      where: { transactionType: 'ORDER', transactionId, type, status: { notIn: [DisputeStatus.RESOLVED, DisputeStatus.CLOSED] } },
    });
  }

  findById(id: string, tx?: unknown): Promise<DisputeCaseRow | null> {
    return this.client(tx).disputeCase.findUnique({ where: { id } });
  }

  /** Applies `data` only while the case is in one of `from`; `null` when it moved first. */
  async transition(
    id: string,
    from: DisputeStatus[],
    data: Prisma.DisputeCaseUncheckedUpdateManyInput,
    tx?: unknown,
  ): Promise<DisputeCaseRow | null> {
    const client = this.client(tx);
    const { count } = await client.disputeCase.updateMany({ where: { id, status: { in: from } }, data });
    return count === 0 ? null : client.disputeCase.findUnique({ where: { id } });
  }

  async search(filter: DisputeSearch, page: number, size: number) {
    const where: Prisma.DisputeCaseWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.priority ? { priority: filter.priority } : {}),
      ...(filter.assignedAdminId ? { assignedAdminId: filter.assignedAdminId } : {}),
      ...(filter.complainantUserId ? { complainantUserId: filter.complainantUserId } : {}),
      ...(filter.transactionId ? { transactionId: filter.transactionId } : {}),
      ...(filter.overdueAt
        ? { slaDueAt: { lt: filter.overdueAt }, status: { notIn: [DisputeStatus.RESOLVED, DisputeStatus.CLOSED] } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.disputeCase.findMany({ where, orderBy: [{ openedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * size, take: size }),
      this.prisma.disputeCase.count({ where }),
    ]);
    return { items, total, page, size };
  }

  addMessage(data: Prisma.DisputeMessageUncheckedCreateInput, tx?: unknown): Promise<DisputeMessageRow> {
    return this.client(tx).disputeMessage.create({ data });
  }

  messages(caseId: string, includeInternal: boolean): Promise<DisputeMessageRow[]> {
    return this.prisma.disputeMessage.findMany({
      where: { caseId, ...(includeInternal ? {} : { internal: false }) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient | undefined) ?? this.prisma;
  }
}
