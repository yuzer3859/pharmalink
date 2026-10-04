import type { StaffMember } from '@/types';
import { STAFF, ROLES } from './mock/seed';
import { simulate, nextId } from './apiClient';
import type { DataScope } from './scope';

let store: StaffMember[] = [...STAFF];

export interface StaffFilters {
  search?: string;
  status?: StaffMember['status'] | 'all';
  roleId?: string;
}

export const staffService = {
  list(scope: DataScope, filters: StaffFilters = {}) {
    let rows = store;
    if (scope.portal === 'pharmacy' && scope.pharmacyId) {
      rows = rows.filter((r) => r.pharmacyId === scope.pharmacyId);
    } else if (scope.portal === 'admin') {
      const adminRoles = ROLES.filter((r) => r.portal !== 'superadmin').map((r) => r.id);
      rows = rows.filter((r) => adminRoles.includes(r.roleId));
    }
    if (filters.status && filters.status !== 'all') {
      rows = rows.filter((r) => r.status === filters.status);
    }
    if (filters.roleId) rows = rows.filter((r) => r.roleId === filters.roleId);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter(
        (r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q),
      );
    }
    return simulate(rows);
  },

  create(input: Omit<StaffMember, 'id' | 'createdAt' | 'lastActiveAt'>) {
    const member: StaffMember = {
      ...input,
      id: nextId('staff'),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    store = [member, ...store];
    return simulate(member);
  },

  update(id: string, patch: Partial<StaffMember>) {
    store = store.map((r) => (r.id === id ? { ...r, ...patch } : r));
    return simulate(store.find((r) => r.id === id)!);
  },

  remove(id: string) {
    store = store.filter((r) => r.id !== id);
    return simulate({ id });
  },
};
