import { fromMinorUnits } from '@/services/adminOrders.service';

export type Palette = 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';

export interface TrendDef {
  title: string;
  subheader?: string;
  scale?: (v: number) => number;
  lines: Array<{ metric: string; label: string; color: Palette }>;
}

/** The charts drawn, each a handful of snapshot metrics (keys as `GET /admin/analytics/metrics` lists them). */
export const TRENDS: TrendDef[] = [
  {
    title: 'Orders',
    lines: [
      { metric: 'orders.orders.total', label: 'All orders', color: 'primary' },
      { metric: 'orders.orders.byStatus.DELIVERED', label: 'Delivered', color: 'success' },
      { metric: 'orders.orders.byStatus.CANCELLED', label: 'Cancelled', color: 'error' },
    ],
  },
  {
    title: 'Accounts and pharmacies',
    lines: [
      { metric: 'accounts.total', label: 'Accounts', color: 'primary' },
      { metric: 'providers.pharmacies.eligible', label: 'Pharmacies that can transact', color: 'secondary' },
    ],
  },
  {
    title: 'Delivery',
    lines: [
      { metric: 'delivery.jobs.total', label: 'Delivery jobs', color: 'info' },
      { metric: 'delivery.jobs.byStatus.COMPLETED', label: 'Completed', color: 'success' },
      { metric: 'delivery.drivers.dispatchable', label: 'Dispatchable drivers', color: 'warning' },
    ],
  },
  {
    title: 'Cash on delivery (ETB)',
    scale: fromMinorUnits,
    lines: [
      { metric: 'cod.expectedAmount', label: 'Expected', color: 'primary' },
      { metric: 'cod.collectedAmount', label: 'Collected', color: 'success' },
      { metric: 'cod.outstandingAmount', label: 'Outstanding', color: 'warning' },
    ],
  },
];
