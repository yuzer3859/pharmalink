import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPharmacyOrderViewReadPort,
  PharmacyOrderView,
  PharmacyOrderViewCriteria,
} from '../../application/ports/inbound/pharmacy-order-view-read.port';

const INCLUDE = {
  order: {
    select: {
      orderNumber: true,
      status: true,
      isCod: true,
      grandTotal: true,
      currency: true,
      placedAt: true,
      deliverySlot: true,
    },
  },
  lines: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.FulfillmentInclude;

type Row = Prisma.FulfillmentGetPayload<{ include: typeof INCLUDE }>;

/**
 * Work 107: the pharmacy portal's order read. The visibility rule is the fulfilment list's own
 * (Work 95): a prepaid order is the pharmacy's to see only once its payment is recorded.
 */
@Injectable()
export class PrismaPharmacyOrderViewReadAdapter implements IPharmacyOrderViewReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async list(criteria: PharmacyOrderViewCriteria): Promise<{ items: PharmacyOrderView[]; total: number }> {
    const where = visible(criteria.pharmacyIds, { status: criteria.status });
    const [rows, total] = await Promise.all([
      this.prisma.fulfillment.findMany({
        where,
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      this.prisma.fulfillment.count({ where }),
    ]);
    return { items: rows.map(toView), total };
  }

  async findById(fulfillmentId: string, pharmacyIds: string[]): Promise<PharmacyOrderView | null> {
    const row = await this.prisma.fulfillment.findFirst({ where: visible(pharmacyIds, { id: fulfillmentId }), include: INCLUDE });
    return row ? toView(row) : null;
  }
}

function visible(pharmacyIds: string[], extra: Prisma.FulfillmentWhereInput): Prisma.FulfillmentWhereInput {
  return {
    ...extra,
    pharmacyId: { in: pharmacyIds },
    order: { OR: [{ isCod: true }, { paymentId: { not: null } }] },
  };
}

function productName(snapshot: Prisma.JsonValue | null): string | null {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const name = (snapshot as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return null;
}

function toView(row: Row): PharmacyOrderView {
  const lines = row.lines.map((l) => ({
    id: l.id,
    catalogProductId: l.catalogProductId,
    productName: productName(l.productSnapshot),
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
    requiresRx: l.requiresRx,
    lineStatus: l.lineStatus,
  }));
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
    order: { ...row.order },
    lines,
    requiresRx: lines.some((l) => l.requiresRx),
  };
}
