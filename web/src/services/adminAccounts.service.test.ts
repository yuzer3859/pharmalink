import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import {
  accountErrorMessage,
  adminAccountQuery,
  createAdminAccountsService,
  isIdentifierFilter,
  isValidReason,
} from './adminAccounts.service';
import type { SessionRequest } from './auth.service';

const USER = 'a1b2c3d4-0000-4000-8000-000000000001';

const service = () => {
  const request = vi.fn().mockResolvedValue({});
  return { request, svc: createAdminAccountsService(request as unknown as SessionRequest) };
};

describe('adminAccountQuery', () => {
  it('sends only the filters that are set; "all" is no filter', () => {
    expect(adminAccountQuery({})).toBe('');
    expect(adminAccountQuery({ status: 'all', primaryRole: 'all', identifier: '  ' })).toBe('');
    expect(adminAccountQuery({ status: 'SUSPENDED', primaryRole: 'ADMIN', identifier: ' a@b.et ', page: 2, size: 10 })).toBe(
      '?status=SUSPENDED&primaryRole=ADMIN&identifier=a%40b.et&page=2&size=10',
    );
    expect(adminAccountQuery({ identifier: '+251911000000' })).toBe('?identifier=%2B251911000000');
  });
});

describe('input rules (the server\'s bounds)', () => {
  it('identifier: 3–254 characters', () => {
    expect(isIdentifierFilter('ab')).toBe(false);
    expect(isIdentifierFilter(' abc ')).toBe(true);
    expect(isIdentifierFilter('x'.repeat(255))).toBe(false);
  });

  it('reason: 3–500 characters after trimming', () => {
    expect(isValidReason('  no ')).toBe(false);
    expect(isValidReason('Fraud report #12')).toBe(true);
    expect(isValidReason('x'.repeat(501))).toBe(false);
  });
});

describe('adminAccountsService', () => {
  it('lists, reads one account and the role catalogue', async () => {
    const { request, svc } = service();
    await svc.list({ status: 'ACTIVE', page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/admin/accounts?status=ACTIVE&page=1&size=25', { method: 'GET' });
    await svc.get(USER);
    expect(request).toHaveBeenLastCalledWith(`/admin/accounts/${USER}`, { method: 'GET' });
    await svc.roles();
    expect(request).toHaveBeenLastCalledWith('/admin/roles', { method: 'GET' });
  });

  it('suspends with a trimmed reason and reinstates without sending an empty one', async () => {
    const { request, svc } = service();
    await svc.suspend(USER, '  Fraud report  ');
    expect(request).toHaveBeenLastCalledWith(`/admin/accounts/${USER}/suspend`, { method: 'POST', body: { reason: 'Fraud report' } });
    await svc.reinstate(USER, '   ');
    expect(request).toHaveBeenLastCalledWith(`/admin/accounts/${USER}/reinstate`, { method: 'POST', body: {} });
    await svc.reinstate(USER, 'Cleared');
    expect(request).toHaveBeenLastCalledWith(`/admin/accounts/${USER}/reinstate`, { method: 'POST', body: { reason: 'Cleared' } });
  });

  it('assigns a role (organisation only when given) and revokes by assignment id', async () => {
    const { request, svc } = service();
    await svc.assignRole(USER, 'ADMIN');
    expect(request).toHaveBeenLastCalledWith(`/admin/accounts/${USER}/roles`, { method: 'POST', body: { roleKey: 'ADMIN' } });
    await svc.assignRole(USER, 'PHARMACY_MANAGER', ' org-1 ');
    expect(request).toHaveBeenLastCalledWith(`/admin/accounts/${USER}/roles`, {
      method: 'POST',
      body: { roleKey: 'PHARMACY_MANAGER', organizationId: 'org-1' },
    });
    await svc.revokeRole(USER, 'as/1');
    expect(request).toHaveBeenLastCalledWith(`/admin/accounts/${USER}/roles/as%2F1`, { method: 'DELETE' });
  });
});

describe('accountErrorMessage', () => {
  it('names a missing permission and a vanished record, and passes other server messages through', () => {
    expect(accountErrorMessage(new ApiError(403, 'FORBIDDEN', 'x'), 'fallback')).toMatch(/not allowed/);
    expect(accountErrorMessage(new ApiError(404, 'NOT_FOUND', 'x'), 'fallback')).toMatch(/no longer exists/);
    expect(accountErrorMessage(new ApiError(422, 'BUSINESS_RULE_VIOLATION', 'Cannot suspend yourself', undefined, 'r-1'), 'fallback')).toBe(
      'Cannot suspend yourself (request r-1)',
    );
    expect(accountErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
