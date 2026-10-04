import type { AuditLog } from '@/types';
import { AUDIT_LOGS } from './mock/seed';
import { simulate } from './apiClient';

export interface AuditFilters {
  search?: string;
  severity?: AuditLog['severity'] | 'all';
}

export const auditService = {
  list(filters: AuditFilters = {}) {
    let rows = [...AUDIT_LOGS];
    if (filters.severity && filters.severity !== 'all') {
      rows = rows.filter((r) => r.severity === filters.severity);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      rows = rows.filter(
        (r) => r.actor.toLowerCase().includes(q) || r.action.toLowerCase().includes(q),
      );
    }
    return simulate(rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
  },
};
