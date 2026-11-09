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
  // Work 82
  'approval:read:any',
  // Work 83
  'finance:payout:any',
  // Work 86
  'dispute:manage:any',
  // Work 90
  'report:generate:any',
];

describe('toAuthUser: the Finance Officer portal (Work 81)', () => {
  it('sends a Finance Officer to the finance portal with finance pages and settlement actions only', () => {
    const authUser = toAuthUser(user('FINANCE_OFFICER', FINANCE_GRANTS));
    expect(authUser.portal).toBe('finance');
    expect(authUser.permissions).toEqual(['reports:view', 'reports:export', 'finance:view', 'finance:settle', 'approvals:view', 'finance:payout', 'finance:refund', 'disputes:manage']);
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
    expect(permissions).toEqual(['reports:view', 'reports:export', 'finance:view', 'finance:settle', 'approvals:view', 'finance:payout', 'finance:refund', 'disputes:manage']);
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

describe('toAuthUser: pending approvals (Work 82)', () => {
  it('shows Approvals to an administrator or finance officer holding approval:read:any, and to nobody else', () => {
    expect(toAuthUser(user('ADMIN', ['auth:login', 'approval:read:any'])).permissions).toContain('approvals:view');
    expect(toAuthUser(user('ADMIN', ['auth:login', 'finance:report:any'])).permissions).not.toContain('approvals:view');
    expect(toAuthUser(user('FINANCE_OFFICER', ['auth:login', 'approval:read:any'])).permissions).toEqual(['approvals:view']);
    expect(toAuthUser(user('SUPER_ADMIN', ['*'])).permissions).toContain('approvals:view');
  });
});

describe('toAuthUser: payouts (Work 83)', () => {
  it('offers payout actions only with finance:payout:any, never from finance:settlement:any', () => {
    expect(toAuthUser(user('FINANCE_OFFICER', ['finance:report:any', 'finance:settlement:any'])).permissions).not.toContain('finance:payout');
    expect(toAuthUser(user('FINANCE_OFFICER', ['finance:report:any', 'finance:payout:any'])).permissions).toContain('finance:payout');
    expect(toAuthUser(user('ADMIN', ['finance:report:any'])).permissions).not.toContain('finance:payout');
    expect(toAuthUser(user('SUPER_ADMIN', ['*'])).permissions).toContain('finance:payout');
  });
});

describe('toAuthUser: support view (Work 85)', () => {
  it('offers the support view only with support:impersonate:any, and never in the finance portal', () => {
    expect(toAuthUser(user('ADMIN', ['auth:login', 'support:impersonate:any'])).permissions).toContain('support:impersonate');
    expect(toAuthUser(user('ADMIN', ['auth:login', 'rbac:read'])).permissions).not.toContain('support:impersonate');
    expect(toAuthUser(user('FINANCE_OFFICER', ['finance:report:any', 'support:impersonate:any'])).permissions).not.toContain('support:impersonate');
  });
});

describe('toAuthUser: the pharmacist review queue (Work 110)', () => {
  it('shows Prescriptions to a pharmacy account holding prescription:verify, and not without it', () => {
    const pharmacist = toAuthUser(user('PHARMACIST', ['auth:login', 'prescription:verify', 'order:fulfill:org']));
    expect(pharmacist.portal).toBe('pharmacy');
    expect(pharmacist.permissions).toContain('prescriptions:verify');
    expect(toAuthUser(user('PHARMACY_OWNER', ['auth:login', 'order:fulfill:org'])).permissions).not.toContain('prescriptions:verify');
  });

  it('never gives it to an operations administrator, who has no pharmacy', () => {
    expect(toAuthUser(user('ADMIN', ['auth:login', 'prescription:verify'])).permissions).not.toContain('prescriptions:verify');
  });
});
