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
    accent: '#00838f',
    nav: [
      { label: 'Dashboard', path: 'dashboard', icon: DashboardRoundedIcon, permission: 'dashboard:view', section: OPS },
      { label: 'Inventory', path: 'inventory', icon: Inventory2RoundedIcon, permission: 'inventory:view', section: OPS },
      { label: 'Orders', path: 'orders', icon: ReceiptLongRoundedIcon, permission: 'orders:view', section: OPS },
      { label: 'Analytics', path: 'analytics', icon: InsightsRoundedIcon, permission: 'analytics:view', section: INSIGHTS },
      { label: 'Reports', path: 'reports', icon: SummarizeRoundedIcon, permission: 'reports:view', section: INSIGHTS },
      { label: 'Staff', path: 'staff', icon: GroupsRoundedIcon, permission: 'staff:view', section: ADMIN },
      { label: 'Roles', path: 'roles', icon: AdminPanelSettingsRoundedIcon, permission: 'roles:view', section: ADMIN },
    ],
  },
  admin: {
    key: 'admin',
    title: 'Admin Dashboard',
    shortTitle: 'Admin',
    basePath: '/admin',
    accent: '#7b1fa2',
    nav: [
      { label: 'Dashboard', path: 'dashboard', icon: DashboardRoundedIcon, permission: 'dashboard:view', section: OPS },
      { label: 'Pharmacies', path: 'pharmacies', icon: StorefrontRoundedIcon, permission: 'pharmacies:view', section: OPS },
      { label: 'Orders', path: 'orders', icon: ReceiptLongRoundedIcon, permission: 'orders:view', section: OPS },
      { label: 'Inventory', path: 'inventory', icon: Inventory2RoundedIcon, permission: 'inventory:view', section: OPS },
      { label: 'Analytics', path: 'analytics', icon: InsightsRoundedIcon, permission: 'analytics:view', section: INSIGHTS },
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
    accent: '#005662',
    nav: [
      { label: 'Dashboard', path: 'dashboard', icon: DashboardRoundedIcon, permission: 'dashboard:view', section: OPS },
      { label: 'Pharmacies', path: 'pharmacies', icon: StorefrontRoundedIcon, permission: 'pharmacies:view', section: OPS },
      { label: 'Orders', path: 'orders', icon: ReceiptLongRoundedIcon, permission: 'orders:view', section: OPS },
      { label: 'Inventory', path: 'inventory', icon: Inventory2RoundedIcon, permission: 'inventory:view', section: OPS },
      { label: 'Analytics', path: 'analytics', icon: InsightsRoundedIcon, permission: 'analytics:view', section: INSIGHTS },
      { label: 'Reports', path: 'reports', icon: SummarizeRoundedIcon, permission: 'reports:view', section: INSIGHTS },
      { label: 'Staff', path: 'staff', icon: GroupsRoundedIcon, permission: 'staff:view', section: ADMIN },
      { label: 'Roles', path: 'roles', icon: AdminPanelSettingsRoundedIcon, permission: 'roles:view', section: ADMIN },
      { label: 'Audit Logs', path: 'audit', icon: FactCheckRoundedIcon, permission: 'audit:view', section: ADMIN },
    ],
  },
};

export const NAV_SECTIONS: Array<NavItem['section']> = [OPS, INSIGHTS, ADMIN];
