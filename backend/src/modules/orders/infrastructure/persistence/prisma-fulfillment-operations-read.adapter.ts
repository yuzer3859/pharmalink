import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  FulfillmentOperationsFilter,
  FulfillmentOperationsPage,
  FulfillmentOperationsView,
  IFulfillmentOperationsReadPort,
} from '../../application/ports/inbound/fulfillment-operations-read.port';

/** The columns a view needs — selected explicitly. `fulfillments` holds no personal data, but nothing else is read. */
const SELECT = {
  id: true,
  orderId: true,
  pharmacyId: true,
  branchId: true,
  status: true,
  deliveryJobId: true,
  acceptedAt: true,
  readyAt: true,
  createdAt: true,
} satisfies Prisma.FulfillmentSelect;

type Row = Prisma.FulfillmentGetPayload<{ select: typeof SELECT }>;

const toView = (r: Row): FulfillmentOperationsView => ({
  fulfillmentId: r.id,
  orderId: r.orderId,
  pharmacyId: r.pharmacyId,
  branchId: r.branchId,
  status: r.status,
  deliveryJobId: r.deliveryJobId,
  hasDeliveryJobReference: r.deliveryJobId !== null,
  acceptedAt: r.acceptedAt,
  readyAt: r.readyAt,
  createdAt: r.createdAt,
});

const window = (from?: Date, to?: Date) =>
  from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } : undefined;

/**
 * `IFulfillmentOperationsReadPort` over Prisma — `SELECT`s on Module 06's own `fulfillments` only.
 * The list is one paged `findMany` and one `count` over the same `where`, in one REPEATABLE READ
 * transaction so the page and its total agree. One row per fulfillment: an order with several
 * fulfillments has several rows, by design.
 */
@Injectable()
export class PrismaFulfillmentOperationsReadAdapter implements IFulfillmentOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listFulfillments(f: FulfillmentOperationsFilter, page: number, size: number): Promise<FulfillmentOperationsPage> {
    const created = window(f.createdFrom, f.createdTo);
    const ready = window(f.readyFrom, f.readyTo);
    const where: Prisma.FulfillmentWhereInput = {
      ...(f.status ? { status: f.status } : {}),
      ...(f.orderId ? { orderId: f.orderId } : {}),
      ...(f.pharmacyId ? { pharmacyId: f.pharmacyId } : {}),
      ...(f.branchId ? { branchId: f.branchId } : {}),
      ...(f.hasDeliveryJobReference === undefined ? {} : { deliveryJobId: f.hasDeliveryJobReference ? { not: null } : null }),
      ...(created ? { createdAt: created } : {}),
      ...(ready ? { readyAt: ready } : {}),
    };
    const [rows, total] = await this.prisma.$transaction(
      [
        this.prisma.fulfillment.findMany({
          where,
          select: SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * size,
          take: size,
        }),
        this.prisma.fulfillment.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { items: rows.map(toView), total, page, size };
  }

  async getFulfillment(fulfillmentId: string): Promise<FulfillmentOperationsView | null> {
    const row = await this.prisma.fulfillment.findUnique({ where: { id: fulfillmentId }, select: SELECT });
    return row ? toView(row) : null;
  }
}
