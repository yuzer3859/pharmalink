import { Injectable } from '@nestjs/common';
import { FulfillmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IPharmacyDashboardReadPort, PharmacyOrderActivity } from '../../application/queries/get-pharmacy-dashboard.query';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Work 115: the dashboard's order figures, read-only. The visibility rule is the pharmacy order
 * list's own (Work 95): a prepaid order counts only once its payment is recorded.
 */
@Injectable()
export class PrismaPharmacyDashboardReadAdapter implements IPharmacyDashboardReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarize(pharmacyIds: string[], now: Date): Promise<PharmacyOrderActivity> {
    const days = Array.from({ length: 7 }, (_, i) => dayKey(new Date(now.getTime() - (6 - i) * DAY_MS)));
    const empty: PharmacyOrderActivity = {
      byStatus: [],
      newLast24h: 0,
      deliveredRevenue30d: 0,
      currency: 'ETB',
      last7Days: days.map((date) => ({ date, orders: 0, deliveredRevenue: 0 })),
    };
    if (pharmacyIds.length === 0) return empty;

    const visible: Prisma.FulfillmentWhereInput = {
      pharmacyId: { in: pharmacyIds },
      order: { OR: [{ isCod: true }, { paymentId: { not: null } }] },
    };
    const weekStart = new Date(`${days[0]}T00:00:00.000Z`);
    const monthStart = new Date(now.getTime() - 30 * DAY_MS);
    const delivered = (from: Date): Prisma.OrderLineWhereInput => ({
      fulfillment: { ...visible, status: FulfillmentStatus.DELIVERED },
      order: { placedAt: { gte: from } },
    });

    const [byStatus, newLast24h, revenue30d, weekFulfillments, weekLines] = await Promise.all([
      this.prisma.fulfillment.groupBy({ by: ['status'], where: visible, _count: { _all: true } }),
      this.prisma.fulfillment.count({ where: { ...visible, createdAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
      this.prisma.orderLine.aggregate({ where: delivered(monthStart), _sum: { lineTotal: true } }),
      this.prisma.fulfillment.findMany({ where: { ...visible, createdAt: { gte: weekStart } }, select: { createdAt: true } }),
      this.prisma.orderLine.findMany({ where: delivered(weekStart), select: { lineTotal: true, order: { select: { placedAt: true } } } }),
    ]);

    const series = new Map(empty.last7Days.map((d) => [d.date, { ...d }]));
    for (const f of weekFulfillments) {
      const day = series.get(dayKey(f.createdAt));
      if (day) day.orders += 1;
    }
    for (const line of weekLines) {
      const day = line.order.placedAt ? series.get(dayKey(line.order.placedAt)) : undefined;
      if (day) day.deliveredRevenue += line.lineTotal;
    }

    return {
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })).sort((a, b) => a.status.localeCompare(b.status)),
      newLast24h,
      deliveredRevenue30d: revenue30d._sum.lineTotal ?? 0,
      currency: 'ETB',
      last7Days: [...series.values()],
    };
  }
}
