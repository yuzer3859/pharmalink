import { describe, expect, it } from 'vitest';
import { AdminOrdersPage } from '@/features/orders/AdminOrdersPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { AdminInventoryPage } from '@/features/inventory/AdminInventoryPage';
import { InventoryPage } from '@/features/inventory/InventoryPage';
import { AuditPage } from '@/features/audit/AuditPage';
import { AdminAnalyticsPage, AdminDashboardPage } from '@/features/analytics/AdminOverviewPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { pageFor } from './pageRegistry';

describe('pageFor', () => {
  it('gives the admin portals the platform-wide orders page and the pharmacy portal its own', () => {
    expect(pageFor('admin', 'orders')).toBe(AdminOrdersPage);
    expect(pageFor('superadmin', 'orders')).toBe(AdminOrdersPage);
    expect(pageFor('pharmacy', 'orders')).toBe(OrdersPage);
  });

  it('gives the admin portals the platform-wide inventory page and the pharmacy portal its own', () => {
    expect(pageFor('admin', 'inventory')).toBe(AdminInventoryPage);
    expect(pageFor('superadmin', 'inventory')).toBe(AdminInventoryPage);
    expect(pageFor('pharmacy', 'inventory')).toBe(InventoryPage);
  });

  it('gives the admin portals the platform overview for dashboard and analytics', () => {
    expect(pageFor('admin', 'dashboard')).toBe(AdminDashboardPage);
    expect(pageFor('superadmin', 'analytics')).toBe(AdminAnalyticsPage);
    expect(pageFor('pharmacy', 'dashboard')).toBe(DashboardPage);
    expect(pageFor('pharmacy', 'analytics')).toBe(AnalyticsPage);
  });

  it('falls back to the shared page, and to nothing for an unknown path', () => {
    expect(pageFor('admin', 'audit')).toBe(AuditPage);
    expect(pageFor('admin', 'nope')).toBeUndefined();
  });
});
