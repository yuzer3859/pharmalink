import type { AnalyticsBundle, CategoryDatum, KpiMetric, Order, TimeSeriesPoint } from '@/types';
import { ORDERS, INVENTORY } from './mock/seed';
import { simulate } from './apiClient';
import type { DataScope } from './scope';

const scopedOrders = (scope: DataScope): Order[] =>
  scope.portal === 'pharmacy' && scope.pharmacyId
    ? ORDERS.filter((o) => o.pharmacyId === scope.pharmacyId)
    : ORDERS;

const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];

export const analyticsService = {
  bundle(scope: DataScope): Promise<AnalyticsBundle> {
    const orders = scopedOrders(scope);
    const inv =
      scope.portal === 'pharmacy' && scope.pharmacyId
        ? INVENTORY.filter((i) => i.pharmacyId === scope.pharmacyId)
        : INVENTORY;

    const revenue = orders.reduce((s, o) => s + o.total, 0);
    const completed = orders.filter((o) => o.status === 'completed').length;
    const cancelled = orders.filter((o) => o.status === 'cancelled').length;
    const fulfillmentRate = orders.length ? (completed / orders.length) * 100 : 0;
    const lowStock = inv.filter((i) => i.status === 'low_stock' || i.status === 'out_of_stock').length;

    const kpis: KpiMetric[] = [
      { key: 'revenue', label: 'Gross Revenue', value: revenue, deltaPct: 12.4, format: 'currency' },
      { key: 'orders', label: 'Total Orders', value: orders.length, deltaPct: 8.1, format: 'number' },
      { key: 'aov', label: 'Avg. Order Value', value: orders.length ? Math.round(revenue / orders.length) : 0, deltaPct: 3.6, format: 'currency' },
      { key: 'fulfillment', label: 'Fulfilment Rate', value: Number(fulfillmentRate.toFixed(1)), deltaPct: 1.9, format: 'percent' },
      { key: 'lowstock', label: 'Low / Out of Stock', value: lowStock, deltaPct: -4.2, format: 'number' },
      { key: 'cancelled', label: 'Cancelled Orders', value: cancelled, deltaPct: -2.3, format: 'number' },
    ];

    const revenueTrend: TimeSeriesPoint[] = monthLabels.map((m, i) => ({
      period: m,
      revenue: Math.round((revenue / 8) * (0.7 + ((i % 4) + 1) * 0.12)),
      orders: Math.round((orders.length / 8) * (0.75 + ((i % 3) + 1) * 0.1)),
    }));

    const statusCounts = orders.reduce<Record<string, number>>((acc, o) => {
      acc[o.status] = (acc[o.status] ?? 0) + 1;
      return acc;
    }, {});
    const ordersByStatus: CategoryDatum[] = Object.entries(statusCounts).map(([name, value]) => ({
      name,
      value,
    }));

    const catCounts = inv.reduce<Record<string, number>>((acc, i) => {
      acc[i.category] = (acc[i.category] ?? 0) + i.quantity;
      return acc;
    }, {});
    const topCategories: CategoryDatum[] = Object.entries(catCounts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);

    const fulfillmentTrend: TimeSeriesPoint[] = monthLabels.map((m, i) => ({
      period: m,
      fulfilled: Number((88 + Math.sin(i) * 5).toFixed(1)),
      cancelled: Number((6 + Math.cos(i) * 2).toFixed(1)),
    }));

    return simulate({ kpis, revenueTrend, ordersByStatus, topCategories, fulfillmentTrend });
  },
};
