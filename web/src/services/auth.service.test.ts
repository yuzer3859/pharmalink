import { describe, expect, it } from 'vitest';
import { ApiError } from './apiClient';
import { toAuthUser, type BackendCurrentUser } from './auth.service';

function user(primaryRole: string, permissions: string[], roles: string[] = [primaryRole]): BackendCurrentUser {
  return {
    id: 'user-1',
    phone: null,
    email: `${primaryRole.toLowerCase()}@staging.pharmalink.test`,
    primaryRole,
    status: 'ACTIVE',
    preferredLanguage: 'en',
    phoneVerifiedAt: null,
    emailVerifiedAt: '2026-11-05T00:00:00.000Z',
    faydaVerified: false,
    deletionRequestedAt: null,
    roles: roles.map((roleKey) => ({ roleKey, organizationId: null })),
    permissions,
  };
}

/** FINANCE_OFFICER's grants in the RBAC seed (backend/prisma/rbac-catalog.ts). */
const FINANCE_GRANTS = [
  'auth:login',
  'profile:read:own',
  'notification:read:own',
  'notification:manage:own',
  'payment:capture:any',
  'payment:void:any',
  'finance:refund:any',
  'finance:settlement:any',
  'finance:report:any',
];

describe('toAuthUser: the Finance Officer portal (Work 81)', () => {
  it('sends a Finance Officer to the finance portal with finance pages and settlement actions only', () => {
    const authUser = toAuthUser(user('FINANCE_OFFICER', FINANCE_GRANTS));
    expect(authUser.portal).toBe('finance');
    expect(authUser.permissions).toEqual(['finance:view', 'finance:settle']);
  });

  it('shows the finance pages without settlement actions when the account can only report', () => {
    const authUser = toAuthUser(user('FINANCE_OFFICER', ['auth:login', 'finance:report:any']));
    expect(authUser.portal).toBe('finance');
    expect(authUser.permissions).toEqual(['finance:view']);
  });

  it('gives a Finance Officer without finance grants no page at all', () => {
    expect(toAuthUser(user('FINANCE_OFFICER', ['auth:login'])).permissions).toEqual([]);
  });

  it('never turns other finance-adjacent grants into admin pages', () => {
    const permissions = toAuthUser(user('FINANCE_OFFICER', [...FINANCE_GRANTS, 'audit:read:any', 'rbac:read', 'analytics:read'])).permissions;
    expect(permissions).toEqual(['finance:view', 'finance:settle']);
  });

  it('keeps administrators in their own portals when they also hold the finance role', () => {
    expect(toAuthUser(user('ADMIN', ['finance:report:any', 'finance:settlement:any'], ['ADMIN', 'FINANCE_OFFICER'])).portal).toBe('admin');
    expect(toAuthUser(user('SUPER_ADMIN', ['*'], ['SUPER_ADMIN', 'FINANCE_OFFICER'])).portal).toBe('superadmin');
  });

  it('still refuses an account with no operations role', () => {
    let failure: unknown;
    try {
      toAuthUser(user('CUSTOMER', ['auth:login']));
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('PORTAL_ACCESS_DENIED');
  });
});
