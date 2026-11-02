import type { AuditLog, AuditLogPage } from '@/types';
import { authService, type SessionRequest } from './auth.service';

/**
 * The audit explorer filters (`GET /admin/audit`, module-16 §9.7). Every filter is an exact match
 * on the server; there is no free-text search and no severity in the audit trail.
 */
export interface AuditFilters {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  /** ISO 8601 instants, inclusive. */
  from?: string;
  to?: string;
  /** 1-based. */
  page?: number;
  size?: number;
}

export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value can be sent as `actorUserId` (the server accepts a UUID only). */
export const isActorIdFilter = (value: string) => UUID.test(value.trim());

/** The query string for `GET /admin/audit`: trimmed, empty filters left out. */
export function auditQuery(filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const key of ['action', 'resourceType', 'resourceId', 'actorUserId', 'from', 'to'] as const) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
  }
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function createAuditService(request: SessionRequest) {
  return {
    /** One page of the trail, newest first. Read-only: the API has no other verb. */
    list(filters: AuditFilters = {}): Promise<AuditLogPage> {
      return request<AuditLogPage>(`/admin/audit${auditQuery(filters)}`, { method: 'GET' });
    },

    /** One entry, with the server's check of its own hash link. */
    get(id: string): Promise<AuditLog & { chain: AuditLog['chain'] & { hashValid: boolean } }> {
      return request(`/admin/audit/${encodeURIComponent(id)}`, { method: 'GET' });
    },
  };
}

export const auditService = createAuditService(authService.request);
