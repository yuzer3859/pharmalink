import { DriversPage } from '@/features/drivers/DriversPage';
import { ProvidersPage } from '@/features/providers/ProvidersPage';
import { FacilityProfilePage } from '@/features/facility/FacilityProfilePage';
import { FacilityLocationsPage } from '@/features/facility/FacilityLocationsPage';
import { FacilityDepartmentsPage } from '@/features/facility/FacilityDepartmentsPage';
import { FacilityServicesPage } from '@/features/facility/FacilityServicesPage';
import { FacilityDoctorsPage } from '@/features/facility/FacilityDoctorsPage';
import { FacilityAppointmentsPage } from '@/features/facility/FacilityAppointmentsPage';
import { DoctorsPage } from '@/features/doctors/DoctorsPage';
import { DoctorAppointmentsPage } from '@/features/doctor-portal/DoctorAppointmentsPage';
import { DoctorSchedulePage } from '@/features/doctor-portal/DoctorSchedulePage';
import { DoctorAvailabilityPage } from '@/features/doctor-portal/DoctorAvailabilityPage';
import { DoctorProfilePage } from '@/features/doctor-portal/DoctorProfilePage';
import type { ComponentType } from 'react';
import { RxRequestsPage } from '@/features/rxRequests/RxRequestsPage';
import type { PortalKey } from '@/types';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { InventoryPage } from '@/features/inventory/InventoryPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { AdminOrdersPage } from '@/features/orders/AdminOrdersPage';
import { AdminInventoryPage } from '@/features/inventory/AdminInventoryPage';
import { AdminAnalyticsPage, AdminDashboardPage } from '@/features/analytics/AdminOverviewPage';
import { AdminStaffPage } from '@/features/staff/AdminStaffPage';
import { AdminRolesPage } from '@/features/roles/AdminRolesPage';
import { AdminVerificationsPage } from '@/features/verifications/AdminVerificationsPage';
import { ConfigurationPage } from '@/features/configuration/ConfigurationPage';
import { CatalogReviewPage } from '@/features/catalog/CatalogReviewPage';
import { FinancePage } from '@/features/finance/FinancePage';
import { CodDisputesPage } from '@/features/finance/CodDisputesPage';
import { ApprovalsPage } from '@/features/approvals/ApprovalsPage';
import { DisputesPage } from '@/features/disputes/DisputesPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { StaffPage } from '@/features/staff/StaffPage';
import { RolesPage } from '@/features/roles/RolesPage';
import { PharmaciesPage } from '@/features/pharmacies/PharmaciesPage';
import { PharmacyOwnersPage } from '@/features/pharmacies/PharmacyOwnersPage';
import { AuditPage } from '@/features/audit/AuditPage';
import { AdminActivityPage } from '@/features/audit/AdminActivityPage';
import { AdminReportsPage } from '@/features/reports/AdminReportsPage';
import { ModerationPage } from '@/features/moderation/ModerationPage';

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
  verifications: AdminVerificationsPage,
  // Work 156.
  drivers: DriversPage,
  providers: ProvidersPage,
  doctors: DoctorsPage,
  // Work 157.
  'pharmacy-owners': PharmacyOwnersPage,
  configuration: ConfigurationPage,
  'catalog-review': CatalogReviewPage,
  finance: FinancePage,
  'cod-disputes': CodDisputesPage,
  approvals: ApprovalsPage,
  disputes: DisputesPage,
  'admin-activity': AdminActivityPage,
  reports: AdminReportsPage,
  moderation: ModerationPage,
};

// The Finance Officer's portal (Work 81): the same finance pages, nothing else.
const FINANCE_PAGES: Record<string, ComponentType> = {
  finance: FinancePage,
  'cod-disputes': CodDisputesPage,
  approvals: ApprovalsPage,
  disputes: DisputesPage,
  reports: AdminReportsPage,
};

// Pages only the pharmacy portal has (Work 137: prescription requests).
const PHARMACY_PAGES: Record<string, ComponentType> = {
  'rx-requests': RxRequestsPage,
};

/** Work 164: a hospital, clinic, diagnostic centre or lab runs its directory profile. */
const FACILITY_PAGES: Record<string, ComponentType> = {
  profile: FacilityProfilePage,
  locations: FacilityLocationsPage,
  departments: FacilityDepartmentsPage,
  services: FacilityServicesPage,
  doctors: FacilityDoctorsPage,
  appointments: FacilityAppointmentsPage,
};

/** Work 170: a doctor's own portal. */
const DOCTOR_PAGES: Record<string, ComponentType> = {
  appointments: DoctorAppointmentsPage,
  schedule: DoctorSchedulePage,
  availability: DoctorAvailabilityPage,
  profile: DoctorProfilePage,
};

const PORTAL_PAGES: Partial<Record<PortalKey, Record<string, ComponentType>>> = {
  doctor: DOCTOR_PAGES,
  facility: FACILITY_PAGES,
  pharmacy: PHARMACY_PAGES,
  admin: ADMIN_PAGES,
  superadmin: ADMIN_PAGES,
  finance: FINANCE_PAGES,
};

export function pageFor(portal: PortalKey, path: string): ComponentType | undefined {
  return PORTAL_PAGES[portal]?.[path] ?? PAGE_REGISTRY[path];
}
