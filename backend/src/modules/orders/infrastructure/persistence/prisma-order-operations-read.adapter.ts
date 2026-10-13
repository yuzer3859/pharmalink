import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IOrderOperationsReadPort,
  OrderOperationsDetail,
  OrderOperationsFilter,
  OrderOperationsListItem,
  OrderOperationsPage,
  OrderOperationsSummary,
} from '../../application/ports/inbound/order-operations-read.port';

/** The columns a summary needs — selected explicitly, so nothing else is ever read. */
const SUMMARY_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  isCod: true,
  grandTotal: true,
  currency: true,
  placedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { lines: true, fulfillments: true } },
} satisfies Prisma.OrderSelect;

type SummaryRow = Prisma.OrderGetPayload<{ select: typeof SUMMARY_SELECT }>;

/**
 * Work 43's one definition of "has a delivery-job reference": some fulfillment with a non-null
 * `deliveryJobId`. Used as the filter (`some` / `none`) and for the per-row flag, so the two cannot
 * disagree. Prisma renders relation filters as `EXISTS` / `NOT EXISTS`, so an order with several
 * fulfillments is still one row.
 */
const REFERENCED_FULFILLMENT = { deliveryJobId: { not: null } } satisfies Prisma.FulfillmentWhereInput;

/** Work 44's complement: a fulfillment with no recorded reference. Says nothing about Module 08's jobs. */
const UNREFERENCED_FULFILLMENT = { deliveryJobId: null } satisfies Prisma.FulfillmentWhereInput;

const toSummary = (r: SummaryRow): OrderOperationsSummary => ({
  orderId: r.id,
  orderNumber: r.orderNumber,
  status: r.status,
  isCod: r.isCod,
  grandTotal: r.grandTotal,
  currency: r.currency,
  lineCount: r._count.lines,
  fulfillmentCount: r._count.fulfillments,
  placedAt: r.placedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/**
 * `IOrderOperationsReadPort` over Prisma — `SELECT`s only, with explicit column selections (no
 * customer, beneficiary, address or note column is ever read). The list is one paged `findMany`
 * with its line and fulfillment counts as correlated sub-counts (no N+1) plus one `count`, both in
 * one transaction so the page and its total agree. Work 43 adds, in the same REPEATABLE READ
 * transaction, one more query over just the page's order ids for the reference flag — never one
 * per order, and never a fulfillment row. Work 44 adds one `GROUP BY orderId` count of the page's
 * unreferenced fulfillments, in the same transaction — counts, not rows.
 */
@Injectable()
export class PrismaOrderOperationsReadAdapter implements IOrderOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listOrders(f: OrderOperationsFilter, page: number, size: number): Promise<OrderOperationsPage> {
    const where: Prisma.OrderWhereInput = {
      ...(f.status ? { status: f.status } : {}),
      ...(f.isCod !== undefined ? { isCod: f.isCod } : {}),
      ...(f.orderNumber ? { orderNumber: f.orderNumber } : {}),
      ...(f.createdFrom || f.createdTo
        ? { createdAt: { ...(f.createdFrom ? { gte: f.createdFrom } : {}), ...(f.createdTo ? { lt: f.createdTo } : {}) } }
        : {}),
      ...(f.hasDeliveryJobReference === undefined
        ? {}
        : { fulfillments: f.hasDeliveryJobReference ? { some: REFERENCED_FULFILLMENT } : { none: REFERENCED_FULFILLMENT } }),
      // A second predicate on the same relation cannot share the `fulfillments` key; AND keeps both.
      ...(f.hasUnreferencedFulfillment === undefined
        ? {}
        : { AND: [{ fulfillments: f.hasUnreferencedFulfillment ? { some: UNREFERENCED_FULFILLMENT } : { none: UNREFERENCED_FULFILLMENT } }] }),
    };
    return this.prisma.$transaction(
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.order.findMany({
            where,
            select: SUMMARY_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * size,
            take: size,
          }),
          tx.order.count({ where }),
        ]);
        const referenced =
          rows.length === 0
            ? []
            : await tx.order.findMany({
                where: { id: { in: rows.map((r) => r.id) }, fulfillments: { some: REFERENCED_FULFILLMENT } },
                select: { id: true },
              });
        const withReference = new Set(referenced.map((r) => r.id));
        const unreferenced =
          rows.length === 0
            ? []
            : await tx.fulfillment.groupBy({
                by: ['orderId'],
                where: { orderId: { in: rows.map((r) => r.id) }, ...UNREFERENCED_FULFILLMENT },
                orderBy: { orderId: 'asc' },
                _count: { _all: true },
              });
        const unreferencedCount = new Map(unreferenced.map((g) => [g.orderId, (g._count as { _all: number })._all]));
        const items: OrderOperationsListItem[] = rows.map((r) => ({
          ...toSummary(r),
          hasDeliveryJobReference: withReference.has(r.id),
          unreferencedFulfillmentCount: unreferencedCount.get(r.id) ?? 0,
        }));
        return { items, total, page, size };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async getOrder(orderId: string): Promise<OrderOperationsDetail | null> {
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        ...SUMMARY_SELECT,
        subtotal: true,
        deliveryFee: true,
        platformFee: true,
        discountTotal: true,
        completedAt: true,
        cancelledAt: true,
        paymentId: true,
        fulfillments: {
          select: { id: true, pharmacyId: true, branchId: true, status: true, deliveryJobId: true, acceptedAt: true, readyAt: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!row) return null;
    return {
      ...toSummary(row),
      subtotal: row.subtotal,
      deliveryFee: row.deliveryFee,
      platformFee: row.platformFee,
      discountTotal: row.discountTotal,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      paymentId: row.paymentId,
      fulfillments: row.fulfillments.map((x) => ({
        fulfillmentId: x.id,
        pharmacyId: x.pharmacyId,
        branchId: x.branchId,
        status: x.status,
        deliveryJobId: x.deliveryJobId,
        acceptedAt: x.acceptedAt,
        readyAt: x.readyAt,
        createdAt: x.createdAt,
      })),
    };
  }
}
