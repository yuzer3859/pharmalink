import type { ComponentType } from 'react';
import type { PortalKey } from '@/types';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { InventoryPage } from '@/features/inventory/InventoryPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { AdminOrdersPage } from '@/features/orders/AdminOrdersPage';
import { AdminInventoryPage } from '@/features/inventory/AdminInventoryPage';
import { AdminAnalyticsPage, AdminDashboardPage } from '@/features/analytics/AdminOverviewPage';
import { AdminStaffPage } from '@/features/staff/AdminStaffPage';
import { AdminRolesPage } from '@/features/roles/AdminRolesPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { StaffPage } from '@/features/staff/StaffPage';
import { RolesPage } from '@/features/roles/RolesPage';
import { PharmaciesPage } from '@/features/pharmacies/PharmaciesPage';
import { AuditPage } from '@/features/audit/AuditPage';

// Maps a navigation path segment to its page component. Shared across portals.
export const PAGE_REGISTRY: Record<string, ComponentType> = {
  dashboard: DashboardPage,
  inventory: InventoryPage,
  orders: OrdersPage,
  analytics: AnalyticsPage,
  reports: ReportsPage,
  staff: StaffPage,
  roles: RolesPage,
  pharmacies: PharmaciesPage,
  audit: AuditPage,
};

// Pages that differ by portal. The admin portals read platform-wide operations APIs (Module 16);
// the pharmacy portal keeps its own pages for the same path.
const ADMIN_PAGES: Record<string, ComponentType> = {
  orders: AdminOrdersPage,
  inventory: AdminInventoryPage,
  dashboard: AdminDashboardPage,
  analytics: AdminAnalyticsPage,
  staff: AdminStaffPage,
  roles: AdminRolesPage,
};

const PORTAL_PAGES: Partial<Record<PortalKey, Record<string, ComponentType>>> = {
  admin: ADMIN_PAGES,
  superadmin: ADMIN_PAGES,
};

export function pageFor(portal: PortalKey, path: string): ComponentType | undefined {
  return PORTAL_PAGES[portal]?.[path] ?? PAGE_REGISTRY[path];
}
