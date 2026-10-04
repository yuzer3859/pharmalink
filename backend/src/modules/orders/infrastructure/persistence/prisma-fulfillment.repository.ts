import { Injectable } from '@nestjs/common';
import { Fulfillment as PrismaFulfillment, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { PagedResult } from '../../domain/repositories/order.repository';
import {
  FulfillmentSnapshot,
  FulfillmentStatusUpdate,
  IFulfillmentRepository,
  ListFulfillmentsByPharmacyCriteria,
  NewFulfillmentData,
} from '../../domain/repositories/fulfillment.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toFulfillmentSnapshot(row: PrismaFulfillment): FulfillmentSnapshot {
  return {
    id: row.id,
    orderId: row.orderId,
    pharmacyId: row.pharmacyId,
    branchId: row.branchId,
    status: row.status,
    deliveryJobId: row.deliveryJobId,
    acceptedAt: row.acceptedAt,
    readyAt: row.readyAt,
    createdAt: row.createdAt,
  };
}

/**
 * Prisma adapter for `IFulfillmentRepository` (module-06 `06-orders-spec.md` §3.6, §9.4, §14
 * step 4) — persists the `Fulfillment` entity via `fulfillments`
 * (`prisma/schema/06-orders.prisma`). Follows the same `tx?: unknown` pass-through convention as
 * every other Module 05/06 repository adapter — never opens its own transaction.
 *
 * `FulfillmentStatusPolicy` remains the sole authority on which transitions are legal; this
 * adapter persists whichever already-validated state the caller supplies via `updateStatus`.
 */
@Injectable()
export class PrismaFulfillmentRepository implements IFulfillmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<FulfillmentSnapshot | null> {
    const row = await this.client(tx).fulfillment.findUnique({ where: { id } });
    return row ? toFulfillmentSnapshot(row) : null;
  }

  async findByOrderId(orderId: string, tx?: unknown): Promise<FulfillmentSnapshot[]> {
    const rows = await this.client(tx).fulfillment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toFulfillmentSnapshot);
  }

  async create(data: NewFulfillmentData, tx?: unknown): Promise<FulfillmentSnapshot> {
    const row = await this.client(tx).fulfillment.create({
      data: {
        orderId: data.orderId,
        pharmacyId: data.pharmacyId,
        branchId: data.branchId,
        status: data.status ?? 'PENDING',
      },
    });
    return toFulfillmentSnapshot(row);
  }

  async updateStatus(id: string, update: FulfillmentStatusUpdate, tx?: unknown): Promise<void> {
    await this.client(tx).fulfillment.update({
      where: { id },
      data: {
        status: update.status,
        acceptedAt: update.acceptedAt,
        readyAt: update.readyAt,
        deliveryJobId: update.deliveryJobId,
      },
    });
  }

  async listByPharmacyIds(
    criteria: ListFulfillmentsByPharmacyCriteria,
    tx?: unknown,
  ): Promise<PagedResult<FulfillmentSnapshot>> {
    const client = this.client(tx);
    const where: Prisma.FulfillmentWhereInput = {
      pharmacyId: { in: criteria.pharmacyIds },
      status: criteria.status,
    };
    const [items, total] = await Promise.all([
      client.fulfillment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      client.fulfillment.count({ where }),
    ]);
    return { items: items.map(toFulfillmentSnapshot), total };
  }
}
