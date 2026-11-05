import { describe, expect, it } from 'vitest';
import { AdminOrdersPage } from '@/features/orders/AdminOrdersPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { AdminInventoryPage } from '@/features/inventory/AdminInventoryPage';
import { InventoryPage } from '@/features/inventory/InventoryPage';
import { AuditPage } from '@/features/audit/AuditPage';
import { AdminAnalyticsPage, AdminDashboardPage } from '@/features/analytics/AdminOverviewPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { AdminStaffPage } from '@/features/staff/AdminStaffPage';
import { StaffPage } from '@/features/staff/StaffPage';
import { AdminRolesPage } from '@/features/roles/AdminRolesPage';
import { RolesPage } from '@/features/roles/RolesPage';
import { AdminVerificationsPage } from '@/features/verifications/AdminVerificationsPage';
import { landingUrl, PORTALS } from '@/config/navigation';
import { ConfigurationPage } from '@/features/configuration/ConfigurationPage';
import { CatalogReviewPage } from '@/features/catalog/CatalogReviewPage';
import { FinancePage } from '@/features/finance/FinancePage';
import { CodDisputesPage } from '@/features/finance/CodDisputesPage';
import { ApprovalsPage } from '@/features/approvals/ApprovalsPage';
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

  it('gives the admin portals the accounts and role catalogue pages', () => {
    expect(pageFor('admin', 'staff')).toBe(AdminStaffPage);
    expect(pageFor('superadmin', 'roles')).toBe(AdminRolesPage);
    expect(pageFor('pharmacy', 'staff')).toBe(StaffPage);
    expect(pageFor('pharmacy', 'roles')).toBe(RolesPage);
  });

  it('routes the verification queue in the admin portals only', () => {
    expect(pageFor('admin', 'verifications')).toBe(AdminVerificationsPage);
    expect(pageFor('superadmin', 'verifications')).toBe(AdminVerificationsPage);
    expect(PORTALS.pharmacy.nav.some((i) => i.path === 'verifications')).toBe(false);
    expect(PORTALS.admin.nav.find((i) => i.path === 'verifications')?.permission).toBe('verifications:view');
  });

  it('offers Configuration in the super admin portal only', () => {
    expect(pageFor('superadmin', 'configuration')).toBe(ConfigurationPage);
    expect(PORTALS.superadmin.nav.find((i) => i.path === 'configuration')?.permission).toBe('settings:manage');
    expect(PORTALS.admin.nav.some((i) => i.path === 'configuration')).toBe(false);
    expect(PORTALS.pharmacy.nav.some((i) => i.path === 'configuration')).toBe(false);
  });

  it('routes catalogue review in the admin portals only', () => {
    expect(pageFor('admin', 'catalog-review')).toBe(CatalogReviewPage);
    expect(pageFor('superadmin', 'catalog-review')).toBe(CatalogReviewPage);
    expect(PORTALS.admin.nav.find((i) => i.path === 'catalog-review')?.permission).toBe('catalog:review');
    expect(PORTALS.pharmacy.nav.some((i) => i.path === 'catalog-review')).toBe(false);
  });

  it('routes finance and COD disputes in the admin portals only', () => {
    expect(pageFor('admin', 'finance')).toBe(FinancePage);
    expect(pageFor('superadmin', 'cod-disputes')).toBe(CodDisputesPage);
    expect(PORTALS.admin.nav.find((i) => i.path === 'finance')?.permission).toBe('finance:view');
    expect(PORTALS.pharmacy.nav.some((i) => i.path === 'finance' || i.path === 'cod-disputes')).toBe(false);
  });

  it('falls back to the shared page, and to nothing for an unknown path', () => {
    expect(pageFor('admin', 'audit')).toBe(AuditPage);
    expect(pageFor('admin', 'nope')).toBeUndefined();
  });
});

describe('the finance portal (Work 81)', () => {
  it('offers Finance, COD disputes and Approvals and nothing else, opening on Finance', () => {
    expect(PORTALS.finance.nav.map((i) => i.path)).toEqual(['finance', 'cod-disputes', 'approvals']);
    expect(PORTALS.finance.landingPath).toBe('finance');
    expect(PORTALS.finance.basePath).toBe('/finance');
    // Only nav items become routes (AppRouter), so these are the only pages the portal can reach.
    expect(PORTALS.finance.nav.map((i) => i.permission)).toEqual(['finance:view', 'finance:view', 'approvals:view']);
  });

  it('routes its pages to the same finance pages the admin portals use', () => {
    expect(pageFor('finance', 'finance')).toBe(FinancePage);
    expect(pageFor('finance', 'cod-disputes')).toBe(CodDisputesPage);
  });

  it('has no admin, pharmacy or dashboard page in its navigation', () => {
    const paths = new Set(PORTALS.finance.nav.map((i) => i.path));
    const others = [...PORTALS.admin.nav, ...PORTALS.superadmin.nav, ...PORTALS.pharmacy.nav]
      .map((i) => i.path)
      .filter((p) => p !== 'finance' && p !== 'cod-disputes' && p !== 'approvals');
    for (const path of others) expect({ path, routed: paths.has(path) }).toEqual({ path, routed: false });
  });

  it('keeps every other portal opening on its dashboard', () => {
    for (const key of ['pharmacy', 'admin', 'superadmin'] as const) expect(PORTALS[key].landingPath).toBe('dashboard');
  });
});

describe('pending approvals (Work 82)', () => {
  it('routes Approvals in the admin, super admin and finance portals, behind approvals:view', () => {
    for (const key of ['admin', 'superadmin', 'finance'] as const) {
      expect(pageFor(key, 'approvals')).toBe(ApprovalsPage);
      expect(PORTALS[key].nav.find((i) => i.path === 'approvals')?.permission).toBe('approvals:view');
    }
    expect(PORTALS.pharmacy.nav.some((i) => i.path === 'approvals')).toBe(false);
    expect(pageFor('pharmacy', 'approvals')).toBeUndefined();
  });
});

describe('landingUrl (Work 81)', () => {
  it('opens each portal on a page that portal routes', () => {
    expect(landingUrl('finance')).toBe('/finance/finance');
    expect(landingUrl('admin')).toBe('/admin/dashboard');
    for (const key of Object.keys(PORTALS) as Array<keyof typeof PORTALS>) {
      const landing = PORTALS[key].landingPath;
      expect({ key, routed: PORTALS[key].nav.some((i) => i.path === landing) }).toEqual({ key, routed: true });
    }
  });
});
