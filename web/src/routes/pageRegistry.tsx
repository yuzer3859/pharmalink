import type { ComponentType } from 'react';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { InventoryPage } from '@/features/inventory/InventoryPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
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
