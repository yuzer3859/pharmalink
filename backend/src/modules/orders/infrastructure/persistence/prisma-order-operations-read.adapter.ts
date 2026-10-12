import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IOrderOperationsReadPort,
  OrderOperationsDetail,
  OrderOperationsFilter,
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
 * one transaction so the page and its total agree.
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
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items: rows.map(toSummary), total, page, size };
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
