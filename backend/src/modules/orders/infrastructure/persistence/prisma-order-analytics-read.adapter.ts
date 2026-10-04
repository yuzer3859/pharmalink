import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  FulfillmentStatus,
  IOrderAnalyticsReadPort,
  OrderAnalyticsView,
  OrderStatus,
} from '../../application/ports/inbound/order-analytics-read.port';

/** `IOrderAnalyticsReadPort` over Prisma — two `GROUP BY`s in PostgreSQL, zero-filled in Node. */
@Injectable()
export class PrismaOrderAnalyticsReadAdapter implements IOrderAnalyticsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeOrders(): Promise<OrderAnalyticsView> {
    const [orderGroups, fulfillmentGroups] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.fulfillment.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const orderCounts = new Map(orderGroups.map((g) => [g.status as string, g._count._all]));
    const fulfillmentCounts = new Map(fulfillmentGroups.map((g) => [g.status as string, g._count._all]));
    const orders = Object.values(OrderStatus).map((status) => ({
      status,
      count: orderCounts.get(status) ?? 0,
    }));
    const fulfillments = Object.values(FulfillmentStatus).map((status) => ({
      status,
      count: fulfillmentCounts.get(status) ?? 0,
    }));
    const sum = (buckets: { count: number }[]) => buckets.reduce((acc, b) => acc + b.count, 0);
    return {
      orders: { total: sum(orders), byStatus: orders },
      fulfillments: { total: sum(fulfillments), byStatus: fulfillments },
    };
  }
}
