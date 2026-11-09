import type { ComponentType } from 'react';
import DashboardRoundedIcon from '@mui/icons-material/DashboardRounded';
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';
import SummarizeRoundedIcon from '@mui/icons-material/SummarizeRounded';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import AdminPanelSettingsRoundedIcon from '@mui/icons-material/AdminPanelSettingsRounded';
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import FlagRoundedIcon from '@mui/icons-material/FlagRounded';
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded';
import VerifiedUserRoundedIcon from '@mui/icons-material/VerifiedUserRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import MedicationRoundedIcon from '@mui/icons-material/MedicationRounded';
import AccountBalanceRoundedIcon from '@mui/icons-material/AccountBalanceRounded';
import GavelRoundedIcon from '@mui/icons-material/GavelRounded';
import HowToRegRoundedIcon from '@mui/icons-material/HowToRegRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import type { PermissionKey, PortalKey } from '@/types';

export interface NavItem {
  label: string;
  path: string; // relative to portal base
  icon: ComponentType;
  permission: PermissionKey;
  section: 'Operations' | 'Insights' | 'Administration';
}

export interface PortalDefinition {
  key: PortalKey;
  title: string;
  shortTitle: string;
  basePath: string;
  /** Where the portal opens, and where a page the account may not see sends it back to. */
  landingPath: string;
  accent: string;
  nav: NavItem[];
}

const OPS = 'Operations' as const;
const INSIGHTS = 'Insights' as const;
const ADMIN = 'Administration' as const;

export const PORTALS: Record<PortalKey, PortalDefinition> = {
  pharmacy: {
    key: 'pharmacy',
    title: 'Pharmacy Portal',
    shortTitle: 'Pharmacy',
    basePath: '/pharmacy',
    landingPath: 'dashboard',
    accent: '#00838f',
    nav: [
      { label: 'Dashboard', path: 'dashboard', icon: DashboardRoundedIcon, permission: 'dashboard:view', section: OPS },
      { label: 'Inventory', path: 'inventory', icon: Inventory2RoundedIcon, permission: 'inventory:view', section: OPS },
      { label: 'Orders', path: 'orders', icon: ReceiptLongRoundedIcon, permission: 'orders:view', section: OPS },
      { label: 'Prescriptions', path: 'prescriptions', icon: MedicationRoundedIcon, permission: 'prescriptions:verify', section: OPS },
      { label: 'Analytics', path: 'analytics', icon: InsightsRoundedIcon, permission: 'analytics:view', section: INSIGHTS },
      // Work 116: the pharmacy's settlement statements (settlement:read:org).
      { label: 'Statements', path: 'reports', icon: SummarizeRoundedIcon, permission: 'reports:view', section: INSIGHTS },
      { label: 'Staff', path: 'staff', icon: GroupsRoundedIcon, permission: 'staff:view', section: ADMIN },
      { label: 'Roles', path: 'roles', icon: AdminPanelSettingsRoundedIcon, permission: 'roles:view', section: ADMIN },
    ],
  },
  admin: {
    key: 'admin',
    title: 'Admin Dashboard',
    shortTitle: 'Admin',
    basePath: '/admin',
    landingPath: 'dashboard',
    accent: '#7b1fa2',
    nav: [
      { label: 'Dashboard', path: 'dashboard', icon: DashboardRoundedIcon, permission: 'dashboard:view', section: OPS },
      { label: 'Pharmacies', path: 'pharmacies', icon: StorefrontRoundedIcon, permission: 'pharmacies:view', section: OPS },
      { label: 'Verifications', path: 'verifications', icon: VerifiedUserRoundedIcon, permission: 'verifications:view', section: OPS },
      { label: 'Catalogue review', path: 'catalog-review', icon: MedicationRoundedIcon, permission: 'catalog:review', section: OPS },
      { label: 'Approvals', path: 'approvals', icon: HowToRegRoundedIcon, permission: 'approvals:view', section: OPS },
      { label: 'Disputes', path: 'disputes', icon: ForumRoundedIcon, permission: 'disputes:manage', section: OPS },
      { label: 'Moderation', path: 'moderation', icon: FlagRoundedIcon, permission: 'reviews:moderate', section: OPS },
      { label: 'Orders', path: 'orders', icon: ReceiptLongRoundedIcon, permission: 'orders:view', section: OPS },
      { label: 'Inventory', path: 'inventory', icon: Inventory2RoundedIcon, permission: 'inventory:view', section: OPS },
      { label: 'Analytics', path: 'analytics', icon: InsightsRoundedIcon, permission: 'analytics:view', section: INSIGHTS },
      { label: 'Finance', path: 'finance', icon: AccountBalanceRoundedIcon, permission: 'finance:view', section: INSIGHTS },
      { label: 'COD disputes', path: 'cod-disputes', icon: GavelRoundedIcon, permission: 'finance:view', section: INSIGHTS },
      { label: 'Reports', path: 'reports', icon: SummarizeRoundedIcon, permission: 'reports:view', section: INSIGHTS },
      { label: 'Staff', path: 'staff', icon: GroupsRoundedIcon, permission: 'staff:view', section: ADMIN },
      { label: 'Roles', path: 'roles', icon: AdminPanelSettingsRoundedIcon, permission: 'roles:view', section: ADMIN },
      { label: 'Audit Logs', path: 'audit', icon: FactCheckRoundedIcon, permission: 'audit:view', section: ADMIN },
    ],
  },
  superadmin: {
    key: 'superadmin',
    title: 'Super Admin Dashboard',
    shortTitle: 'Super Admin',
    basePath: '/superadmin',
    landingPath: 'dashboard',
    accent: '#005662',
    nav: [
      { label: 'Dashboard', path: 'dashboard', icon: DashboardRoundedIcon, permission: 'dashboard:view', section: OPS },
      { label: 'Pharmacies', path: 'pharmacies', icon: StorefrontRoundedIcon, permission: 'pharmacies:view', section: OPS },
      { label: 'Verifications', path: 'verifications', icon: VerifiedUserRoundedIcon, permission: 'verifications:view', section: OPS },
      { label: 'Catalogue review', path: 'catalog-review', icon: MedicationRoundedIcon, permission: 'catalog:review', section: OPS },
      { label: 'Approvals', path: 'approvals', icon: HowToRegRoundedIcon, permission: 'approvals:view', section: OPS },
      { label: 'Disputes', path: 'disputes', icon: ForumRoundedIcon, permission: 'disputes:manage', section: OPS },
      { label: 'Moderation', path: 'moderation', icon: FlagRoundedIcon, permission: 'reviews:moderate', section: OPS },
      { label: 'Orders', path: 'orders', icon: ReceiptLongRoundedIcon, permission: 'orders:view', section: OPS },
      { label: 'Inventory', path: 'inventory', icon: Inventory2RoundedIcon, permission: 'inventory:view', section: OPS },
      { label: 'Analytics', path: 'analytics', icon: InsightsRoundedIcon, permission: 'analytics:view', section: INSIGHTS },
      { label: 'Finance', path: 'finance', icon: AccountBalanceRoundedIcon, permission: 'finance:view', section: INSIGHTS },
      { label: 'COD disputes', path: 'cod-disputes', icon: GavelRoundedIcon, permission: 'finance:view', section: INSIGHTS },
      { label: 'Reports', path: 'reports', icon: SummarizeRoundedIcon, permission: 'reports:view', section: INSIGHTS },
      { label: 'Staff', path: 'staff', icon: GroupsRoundedIcon, permission: 'staff:view', section: ADMIN },
      { label: 'Roles', path: 'roles', icon: AdminPanelSettingsRoundedIcon, permission: 'roles:view', section: ADMIN },
      { label: 'Audit Logs', path: 'audit', icon: FactCheckRoundedIcon, permission: 'audit:view', section: ADMIN },
      { label: 'Admin activity', path: 'admin-activity', icon: MonitorHeartRoundedIcon, permission: 'staff:monitor', section: ADMIN },
      { label: 'Configuration', path: 'configuration', icon: TuneRoundedIcon, permission: 'settings:manage', section: ADMIN },
    ],
  },
  // Work 81: the Finance Officer's portal. Financial oversight and COD disputes only; it opens on
  // Finance because the platform dashboard needs analytics:read, which finance does not hold.
  finance: {
    key: 'finance',
    title: 'Finance Portal',
    shortTitle: 'Finance',
    basePath: '/finance',
    landingPath: 'finance',
    accent: '#2e7d32',
    nav: [
      { label: 'Finance', path: 'finance', icon: AccountBalanceRoundedIcon, permission: 'finance:view', section: INSIGHTS },
      { label: 'COD disputes', path: 'cod-disputes', icon: GavelRoundedIcon, permission: 'finance:view', section: INSIGHTS },
      { label: 'Approvals', path: 'approvals', icon: HowToRegRoundedIcon, permission: 'approvals:view', section: OPS },
      { label: 'Disputes', path: 'disputes', icon: ForumRoundedIcon, permission: 'disputes:manage', section: OPS },
      // Work 90: payment and refund reports.
      { label: 'Reports', path: 'reports', icon: SummarizeRoundedIcon, permission: 'reports:view', section: INSIGHTS },
    ],
  },
};

export const NAV_SECTIONS: Array<NavItem['section']> = [OPS, INSIGHTS, ADMIN];

/** Where a portal opens: after sign-in, and when a page the account may not see sends it back. */
export function landingUrl(portal: PortalKey): string {
  return `${PORTALS[portal].basePath}/${PORTALS[portal].landingPath}`;
}
