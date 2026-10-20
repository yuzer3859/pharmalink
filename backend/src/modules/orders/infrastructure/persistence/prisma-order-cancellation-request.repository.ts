import { Injectable } from '@nestjs/common';
import { OrderCancellationPhase, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CancellationPhase,
  CancellationRequestSnapshot,
  IOrderCancellationRequestRepository,
  OPEN_CANCELLATION_PHASES,
} from '../../domain/repositories/order-cancellation-request.repository';

type Client = PrismaService | Prisma.TransactionClient;
type Row = Prisma.OrderCancellationRequestGetPayload<object>;

const toSnapshot = (r: Row): CancellationRequestSnapshot => ({
  id: r.id,
  orderId: r.orderId,
  customerUserId: r.customerUserId,
  reason: r.reason,
  phase: r.phase as CancellationPhase,
  attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt,
  lastErrorCode: r.lastErrorCode,
  lastErrorAt: r.lastErrorAt,
  attentionRequiredAt: r.attentionRequiredAt,
  leaseOwner: r.leaseOwner,
  leaseExpiresAt: r.leaseExpiresAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  completedAt: r.completedAt,
});

const OPEN = OPEN_CANCELLATION_PHASES as OrderCancellationPhase[];
const TERMINAL: readonly CancellationPhase[] = [CancellationPhase.COMPLETED, CancellationPhase.REJECTED];

/**
 * `order_cancellation_requests` (Work 55). Every transition is an `updateMany` whose `where` carries
 * the expected phase and the caller's lease, so its row count is the compare-and-set outcome.
 */
@Injectable()
export class PrismaOrderCancellationRequestRepository implements IOrderCancellationRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async createOrGet(
    input: { orderId: string; customerUserId: string; reason: string; leaseOwner: string; leaseExpiresAt: Date },
    tx?: unknown,
  ): Promise<{ request: CancellationRequestSnapshot; created: boolean }> {
    const client = this.client(tx);
    const existing = await client.orderCancellationRequest.findUnique({ where: { orderId: input.orderId } });
    if (existing) return { request: toSnapshot(existing), created: false };
    // A concurrent insert for the same order loses on the unique `orderId` (Prisma P2002). That is
    // not a serialization conflict, so the caller catches it and re-reads the winner's row.
    const row = await client.orderCancellationRequest.create({
      data: {
        orderId: input.orderId,
        customerUserId: input.customerUserId,
        reason: input.reason,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
      },
    });
    return { request: toSnapshot(row), created: true };
  }

  async findByOrderId(orderId: string, tx?: unknown): Promise<CancellationRequestSnapshot | null> {
    const row = await this.client(tx).orderCancellationRequest.findUnique({ where: { orderId } });
    return row ? toSnapshot(row) : null;
  }

  async findById(id: string, tx?: unknown): Promise<CancellationRequestSnapshot | null> {
    const row = await this.client(tx).orderCancellationRequest.findUnique({ where: { id } });
    return row ? toSnapshot(row) : null;
  }

  async claim(id: string, leaseOwner: string, now: Date, leaseExpiresAt: Date, ignoreAttention: boolean): Promise<boolean> {
    const { count } = await this.prisma.orderCancellationRequest.updateMany({
      where: {
        id,
        phase: { in: OPEN },
        ...(ignoreAttention ? {} : { attentionRequiredAt: null }),
        OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }, { leaseOwner }],
      },
      data: { leaseOwner, leaseExpiresAt },
    });
    return count === 1;
  }

  async advance(
    id: string,
    owner: string,
    from: CancellationPhase,
    to: CancellationPhase,
    now: Date,
    tx?: unknown,
    lastErrorCode: string | null = null,
  ): Promise<boolean> {
    const terminal = TERMINAL.includes(to);
    const { count } = await this.client(tx).orderCancellationRequest.updateMany({
      where: { id, phase: from as OrderCancellationPhase, leaseOwner: owner },
      data: {
        phase: to as OrderCancellationPhase,
        attentionRequiredAt: null,
        lastErrorCode,
        lastErrorAt: lastErrorCode ? now : null,
        ...(terminal ? { leaseOwner: null, leaseExpiresAt: null, completedAt: now } : {}),
      },
    });
    return count === 1;
  }

  async scheduleRetry(id: string, owner: string, now: Date, nextAttemptAt: Date, errorCode: string): Promise<boolean> {
    const { count } = await this.prisma.orderCancellationRequest.updateMany({
      where: { id, leaseOwner: owner, phase: { in: OPEN } },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt,
        lastErrorCode: errorCode,
        lastErrorAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    return count === 1;
  }

  async requireAttention(id: string, owner: string, now: Date, errorCode: string): Promise<boolean> {
    const { count } = await this.prisma.orderCancellationRequest.updateMany({
      where: { id, leaseOwner: owner, phase: { in: OPEN } },
      data: {
        attempts: { increment: 1 },
        attentionRequiredAt: now,
        lastErrorCode: errorCode,
        lastErrorAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    return count === 1;
  }

  async releaseLease(id: string, owner: string): Promise<void> {
    await this.prisma.orderCancellationRequest.updateMany({
      where: { id, leaseOwner: owner },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }

  async listDue(now: Date, limit: number): Promise<CancellationRequestSnapshot[]> {
    const rows = await this.prisma.orderCancellationRequest.findMany({
      where: {
        phase: { in: OPEN },
        attentionRequiredAt: null,
        nextAttemptAt: { lte: now },
        OR: [{ leaseOwner: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toSnapshot);
  }
}
