import { Injectable } from '@nestjs/common';
import { Refund as PrismaRefund, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { RefundProps } from '../../domain/entities/refund.entity';
import {
  IRefundRepository,
  NewRefundData,
  RefundPage,
  RefundSearchCriteria,
  RefundStateUpdate,
  RefundStatusTotals,
} from '../../domain/repositories/refund.repository';
import { RefundStatus } from '../../domain/enums';
import { REFUNDED_TOTAL_STATUSES } from '../../domain/services/refund-status-policy';

type Client = PrismaService | Prisma.TransactionClient;

function toRefundProps(row: PrismaRefund): RefundProps {
  return {
    id: row.id,
    paymentId: row.paymentId,
    amount: row.amount,
    reason: row.reason,
    type: row.type,
    destination: row.destination,
    status: row.status,
    providerRef: row.providerRef,
    approvedBy: row.approvedBy,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/**
 * Prisma adapter for `IRefundRepository` (§7 `refunds`). Follows the same `tx?: unknown`
 * pass-through convention as every other Module 04/05/06 repository adapter — this adapter never
 * opens its own `$transaction()`; the caller-supplied `IUnitOfWork` owns that boundary, and for
 * refunds that is not a stylistic preference: the over-refund check is only atomic because the
 * caller's `Serializable` transaction spans both `totalRefundedForPayment` and `create`.
 *
 * `RefundStatusPolicy` remains the sole authority on which transitions are legal — this repository
 * persists whichever already-validated state the caller supplies, exactly as
 * `PrismaPaymentRepository.updateState` does.
 *
 * **PCI (BRULE-26):** the mapper above enumerates every column of `refunds`, and none of them is
 * card data. `providerRef` is a gateway-issued reference only.
 */
@Injectable()
export class PrismaRefundRepository implements IRefundRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<RefundProps | null> {
    const row = await this.client(tx).refund.findUnique({ where: { id } });
    return row ? toRefundProps(row) : null;
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<RefundProps | null> {
    const row = await this.client(tx).refund.findUnique({ where: { idempotencyKey } });
    return row ? toRefundProps(row) : null;
  }

  async findByPaymentId(paymentId: string, tx?: unknown): Promise<RefundProps[]> {
    const rows = await this.client(tx).refund.findMany({
      where: { paymentId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRefundProps);
  }

  /**
   * Σ `amount` over the refunds that count against the total — every status except `FAILED`, which
   * moved no money (`RefundStatusPolicy.countsAgainstRefundedTotal`). The status list is derived
   * from that policy rather than hard-coded here, so the domain stays the single authority on which
   * refunds count.
   *
   * This is the read BRULE-24's invariant is decided against. It takes no lock of its own: the
   * caller runs it and the subsequent `create` inside one `Serializable` transaction, where
   * PostgreSQL's SSI turns two concurrent "sum then insert into the summed range" transactions into
   * a serialization failure for one of them. See `IRefundRepository` for the full rationale.
   */
  async totalRefundedForPayment(paymentId: string, tx?: unknown): Promise<number> {
    const aggregate = await this.client(tx).refund.aggregate({
      where: { paymentId, status: { in: [...REFUNDED_TOTAL_STATUSES] } },
      _sum: { amount: true },
    });
    return aggregate._sum.amount ?? 0;
  }

  /**
   * Σ over `COMPLETED` refunds only — money that has actually gone back to the customer. Used for
   * §6's `REFUNDED`/`PARTIALLY_REFUNDED` decision (ADR-018), never for the over-refund guard, which
   * must also count in-flight `PENDING` refunds. See `IRefundRepository` for why the two differ.
   */
  async totalCompletedRefundedForPayment(paymentId: string, tx?: unknown): Promise<number> {
    const aggregate = await this.client(tx).refund.aggregate({
      where: { paymentId, status: RefundStatus.COMPLETED },
      _sum: { amount: true },
    });
    return aggregate._sum.amount ?? 0;
  }

  async create(data: NewRefundData, tx?: unknown): Promise<RefundProps> {
    const row = await this.client(tx).refund.create({
      data: {
        id: data.id,
        paymentId: data.paymentId,
        amount: data.amount,
        reason: data.reason ?? null,
        type: data.type,
        destination: data.destination,
        status: data.status,
        providerRef: data.providerRef ?? null,
        approvedBy: data.approvedBy ?? null,
        idempotencyKey: data.idempotencyKey,
      },
    });
    return toRefundProps(row);
  }

  async updateState(
    id: string,
    update: RefundStateUpdate,
    tx?: unknown,
  ): Promise<RefundProps> {
    const row = await this.client(tx).refund.update({
      where: { id },
      data: {
        status: update.status,
        providerRef: update.providerRef,
        completedAt: update.completedAt,
      },
    });
    return toRefundProps(row);
  }

  async search(
    criteria: RefundSearchCriteria,
    page: number,
    size: number,
    tx?: unknown,
  ): Promise<RefundPage> {
    const where: Prisma.RefundWhereInput = {
      ...(criteria.status ? { status: criteria.status } : {}),
      ...(criteria.type ? { type: criteria.type } : {}),
      ...(criteria.destination ? { destination: criteria.destination } : {}),
      ...(criteria.paymentId ? { paymentId: criteria.paymentId } : {}),
      ...(criteria.createdFrom || criteria.createdTo
        ? {
            createdAt: {
              ...(criteria.createdFrom ? { gte: criteria.createdFrom } : {}),
              ...(criteria.createdTo ? { lt: criteria.createdTo } : {}),
            },
          }
        : {}),
    };
    const client = this.client(tx);
    const [rows, total] = await Promise.all([
      client.refund.findMany({
        where,
        // The currency lives on the payment alone (see `RefundProps`); read through the relation
        // so a refund can never be reported in a currency its payment was not made in.
        include: { payment: { select: { currency: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      client.refund.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({ refund: toRefundProps(row), currency: row.payment.currency })),
      total,
      page,
      size,
    };
  }

  async summarizeByStatus(tx?: unknown): Promise<RefundStatusTotals[]> {
    const client = this.client(tx);
    // `groupBy` cannot group by a relation's column, so bucket per payment currency explicitly.
    // One currency in practice (BRULE-22 records every payment in ETB); the loop is what keeps
    // that a fact about the data rather than an assumption baked into the read.
    const currencies = await client.payment.findMany({
      distinct: ['currency'],
      select: { currency: true },
      orderBy: { currency: 'asc' },
    });
    const totals: RefundStatusTotals[] = [];
    for (const { currency } of currencies) {
      const groups = await client.refund.groupBy({
        by: ['status'],
        where: { payment: { currency } },
        _count: { _all: true },
        _sum: { amount: true },
        orderBy: { status: 'asc' },
      });
      for (const group of groups) {
        totals.push({
          currency,
          status: group.status,
          count: group._count._all,
          amount: group._sum.amount ?? 0,
        });
      }
    }
    return totals;
  }
}
