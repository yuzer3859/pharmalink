import type {
  AccountStatus,
  AccountStatusChange,
  AdminAccountDetail,
  AdminAccountPage,
  PrimaryRole,
  RoleCatalogueEntry,
  RoleChange,
} from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';

/** Filters of `GET /admin/accounts` (`rbac:read`). `identifier` is an exact phone (E.164) or e-mail. */
export interface AdminAccountFilters {
  status?: AccountStatus | 'all';
  primaryRole?: PrimaryRole | 'all';
  identifier?: string;
  /** 1-based. */
  page?: number;
  size?: number;
}

export const ACCOUNT_STATUSES: AccountStatus[] = [
  'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'DELETED', 'PENDING_APPROVAL', 'REJECTED',
];

export const PRIMARY_ROLES: PrimaryRole[] = [
  'CUSTOMER', 'PHARMACY_OWNER', 'PHARMACY_MANAGER', 'PHARMACIST', 'CASHIER', 'INVENTORY_STAFF', 'DOCTOR', 'DRIVER',
  'HOSPITAL_ADMIN', 'DIAGNOSTIC_CENTER_ADMIN', 'LAB_STAFF', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER', 'ADMIN', 'SUPER_ADMIN',
];

export const ACCOUNT_PAGE_SIZES = [10, 25, 50] as const;

/** The server's bounds for a suspend or reinstate reason. */
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;

/** The server's bounds for the identifier filter: 3–254 characters. */
export const isIdentifierFilter = (value: string) => {
  const v = value.trim();
  return v.length >= 3 && v.length <= 254;
};

export const isValidReason = (value: string) => {
  const v = value.trim();
  return v.length >= MIN_REASON_LENGTH && v.length <= MAX_REASON_LENGTH;
};

export function adminAccountQuery(filters: AdminAccountFilters): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.primaryRole && filters.primaryRole !== 'all') params.set('primaryRole', filters.primaryRole);
  const identifier = filters.identifier?.trim();
  if (identifier) params.set('identifier', identifier);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** A refused account change in words an operator can act on; the server's message otherwise. */
export function accountErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 403) return 'Your account is not allowed to do this.';
  if (error.status === 404) return 'That account or assignment no longer exists.';
  return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
}

export function createAdminAccountsService(request: SessionRequest) {
  const account = (userId: string) => `/admin/accounts/${encodeURIComponent(userId)}`;
  return {
    list(filters: AdminAccountFilters = {}): Promise<AdminAccountPage> {
      return request<AdminAccountPage>(`/admin/accounts${adminAccountQuery(filters)}`, { method: 'GET' });
    },

    /** The account with its role assignments. */
    get(userId: string): Promise<AdminAccountDetail> {
      return request<AdminAccountDetail>(account(userId), { method: 'GET' });
    },

    /** `user:suspend:any`. The server revokes the account's sessions and audits the reason. */
    suspend(userId: string, reason: string): Promise<AccountStatusChange> {
      return request<AccountStatusChange>(`${account(userId)}/suspend`, { method: 'POST', body: { reason: reason.trim() } });
    },

    /** `user:reactivate:any`. The reason is optional on the server; an empty one is not sent. */
    reinstate(userId: string, reason?: string): Promise<AccountStatusChange> {
      const trimmed = reason?.trim();
      return request<AccountStatusChange>(`${account(userId)}/reinstate`, { method: 'POST', body: trimmed ? { reason: trimmed } : {} });
    },

    /** `rbac:manage`. `organizationId` only for organisation-scoped roles. */
    assignRole(userId: string, roleKey: string, organizationId?: string): Promise<RoleChange> {
      const org = organizationId?.trim();
      return request<RoleChange>(`${account(userId)}/roles`, { method: 'POST', body: org ? { roleKey, organizationId: org } : { roleKey } });
    },

    /** `rbac:manage`. */
    revokeRole(userId: string, assignmentId: string): Promise<RoleChange> {
      return request<RoleChange>(`${account(userId)}/roles/${encodeURIComponent(assignmentId)}`, { method: 'DELETE' });
    },

    /** `GET /admin/roles` (`rbac:read`): the role catalogue with each role's permissions. */
    roles(): Promise<RoleCatalogueEntry[]> {
      return request<RoleCatalogueEntry[]>('/admin/roles', { method: 'GET' });
    },
  };
}

export const adminAccountsService = createAdminAccountsService(authService.request);
