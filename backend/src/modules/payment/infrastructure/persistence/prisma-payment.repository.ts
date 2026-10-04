import { Injectable } from '@nestjs/common';
import { Payment as PrismaPayment, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentStatus } from '../../domain/enums';
import {
  IPaymentRepository,
  NewPaymentData,
  PaymentPage,
  PaymentSearchCriteria,
  PaymentStateUpdate,
  PaymentStatusTotals,
} from '../../domain/repositories/payment.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toPaymentProps(row: PrismaPayment): PaymentProps {
  return {
    id: row.id,
    orderId: row.orderId,
    customerUserId: row.customerUserId,
    method: row.method,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    originalAmount: row.originalAmount,
    originalCurrency: row.originalCurrency,
    fxRate: row.fxRate,
    fxSource: row.fxSource,
    provider: row.provider,
    providerRef: row.providerRef,
    providerToken: row.providerToken,
    idempotencyKey: row.idempotencyKey,
    authorizedAt: row.authorizedAt,
    capturedAt: row.capturedAt,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Prisma adapter for `IPaymentRepository` (§7 `payments`). Follows the same `tx?: unknown`
 * pass-through convention as every other Module 04/05/06 repository adapter — this adapter never
 * opens its own `$transaction()`; the caller-supplied `IUnitOfWork` owns that boundary.
 *
 * `PaymentStatusPolicy` remains the sole authority on which transitions are legal — this
 * repository persists whichever already-validated state the caller supplies, exactly as
 * `PrismaOrderRepository.updateStatus` does.
 *
 * **PCI (BRULE-26):** the mapper above enumerates every column of `payments`, and none of them
 * is card data. `providerRef`/`providerToken` are gateway-issued references only.
 */
@Injectable()
export class PrismaPaymentRepository implements IPaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<PaymentProps | null> {
    const row = await this.client(tx).payment.findUnique({ where: { id } });
    return row ? toPaymentProps(row) : null;
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<PaymentProps | null> {
    const row = await this.client(tx).payment.findUnique({ where: { idempotencyKey } });
    return row ? toPaymentProps(row) : null;
  }

  async findByOrderId(orderId: string, tx?: unknown): Promise<PaymentProps[]> {
    const rows = await this.client(tx).payment.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toPaymentProps);
  }

  async findByProviderRef(
    provider: string,
    providerRef: string,
    tx?: unknown,
  ): Promise<PaymentProps | null> {
    const row = await this.client(tx).payment.findFirst({
      where: { provider, providerRef },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? toPaymentProps(row) : null;
  }

  async findStale(
    criteria: { statuses: PaymentStatus[]; olderThan: Date; limit: number },
    tx?: unknown,
  ): Promise<PaymentProps[]> {
    const rows = await this.client(tx).payment.findMany({
      // `updatedAt` rather than `createdAt`: a payment that was touched recently (a retry, a
      // provider reference written after an ambiguous outcome) is not stuck yet.
      where: { status: { in: criteria.statuses }, updatedAt: { lt: criteria.olderThan } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: criteria.limit,
    });
    return rows.map(toPaymentProps);
  }

  async create(data: NewPaymentData, tx?: unknown): Promise<PaymentProps> {
    const row = await this.client(tx).payment.create({
      data: {
        id: data.id,
        orderId: data.orderId,
        customerUserId: data.customerUserId,
        method: data.method,
        status: data.status,
        amount: data.amount,
        currency: data.currency,
        originalAmount: data.originalAmount ?? null,
        originalCurrency: data.originalCurrency ?? null,
        fxRate: data.fxRate ?? null,
        fxSource: data.fxSource ?? null,
        provider: data.provider ?? null,
        providerRef: data.providerRef ?? null,
        providerToken: data.providerToken ?? null,
        idempotencyKey: data.idempotencyKey,
      },
    });
    return toPaymentProps(row);
  }

  async updateState(
    id: string,
    update: PaymentStateUpdate,
    tx?: unknown,
  ): Promise<PaymentProps> {
    const row = await this.client(tx).payment.update({
      where: { id },
      data: {
        status: update.status,
        providerRef: update.providerRef,
        authorizedAt: update.authorizedAt,
        capturedAt: update.capturedAt,
        failureReason: update.failureReason,
      },
    });
    return toPaymentProps(row);
  }

  async search(
    criteria: PaymentSearchCriteria,
    page: number,
    size: number,
    tx?: unknown,
  ): Promise<PaymentPage> {
    const where: Prisma.PaymentWhereInput = {
      ...(criteria.status ? { status: criteria.status } : {}),
      ...(criteria.method ? { method: criteria.method } : {}),
      ...(criteria.provider ? { provider: criteria.provider } : {}),
      ...(criteria.orderId ? { orderId: criteria.orderId } : {}),
      ...(criteria.customerUserId ? { customerUserId: criteria.customerUserId } : {}),
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
      client.payment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      client.payment.count({ where }),
    ]);
    return { items: rows.map(toPaymentProps), total, page, size };
  }

  async summarizeByStatus(tx?: unknown): Promise<PaymentStatusTotals[]> {
    const groups = await this.client(tx).payment.groupBy({
      by: ['currency', 'status'],
      _count: { _all: true },
      _sum: { amount: true },
      orderBy: [{ currency: 'asc' }, { status: 'asc' }],
    });
    return groups.map((group) => ({
      currency: group.currency,
      status: group.status,
      count: group._count._all,
      amount: group._sum.amount ?? 0,
    }));
  }
}
