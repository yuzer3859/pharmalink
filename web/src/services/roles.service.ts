import type { PermissionKey, Role } from '@/types';
import { ROLES, ALL_PERMISSIONS } from './mock/seed';
import { simulate, nextId } from './apiClient';
import type { DataScope } from './scope';

let store: Role[] = [...ROLES];

export interface PermissionMeta {
  key: PermissionKey;
  label: string;
  group: string;
}

export const PERMISSION_CATALOG: PermissionMeta[] = [
  { key: 'dashboard:view', label: 'View dashboard', group: 'General' },
  { key: 'inventory:view', label: 'View inventory', group: 'Inventory' },
  { key: 'inventory:manage', label: 'Manage inventory', group: 'Inventory' },
  { key: 'orders:view', label: 'View orders', group: 'Orders' },
  { key: 'orders:manage', label: 'Manage orders', group: 'Orders' },
  { key: 'analytics:view', label: 'View analytics', group: 'Insights' },
  { key: 'reports:view', label: 'View reports', group: 'Insights' },
  { key: 'reports:export', label: 'Export reports', group: 'Insights' },
  { key: 'staff:view', label: 'View staff', group: 'People' },
  { key: 'staff:manage', label: 'Manage staff', group: 'People' },
  { key: 'roles:view', label: 'View roles', group: 'Access' },
  { key: 'roles:manage', label: 'Manage roles', group: 'Access' },
  { key: 'pharmacies:view', label: 'View pharmacies', group: 'Providers' },
  { key: 'pharmacies:manage', label: 'Manage pharmacies', group: 'Providers' },
  { key: 'audit:view', label: 'View audit logs', group: 'Access' },
  { key: 'settings:manage', label: 'Manage settings', group: 'Access' },
];

export const rolesService = {
  list(scope: DataScope) {
    let rows = store;
    if (scope.portal === 'pharmacy') rows = rows.filter((r) => r.portal === 'pharmacy');
    else if (scope.portal === 'admin') rows = rows.filter((r) => r.portal !== 'superadmin');
    return simulate(rows);
  },

  allPermissions() {
    return simulate([...ALL_PERMISSIONS]);
  },

  create(input: Omit<Role, 'id' | 'memberCount' | 'isSystem'>) {
    const role: Role = { ...input, id: nextId('role'), memberCount: 0, isSystem: false };
    store = [role, ...store];
    return simulate(role);
  },

  update(id: string, patch: Partial<Role>) {
    store = store.map((r) => (r.id === id ? { ...r, ...patch } : r));
    return simulate(store.find((r) => r.id === id)!);
  },

  remove(id: string) {
    store = store.filter((r) => r.id !== id);
    return simulate({ id });
  },
};
