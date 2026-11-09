import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import { canRemoveRole, createPharmacyStaffService, describePermissions, emailProblem, OWNER_ROLE } from './pharmacyStaff.service';

const assignable = [
  { key: 'PHARMACIST', name: 'Pharmacist', description: null, permissionKeys: [] },
  { key: 'CASHIER', name: 'Cashier', description: null, permissionKeys: [] },
];

describe('describePermissions', () => {
  it('leaves out the account basics and words the rest plainly', () => {
    expect(describePermissions(['auth:login', 'profile:read:own', 'prescription:verify', 'order:fulfill:org', 'something:new'])).toEqual([
      'Review and approve prescriptions',
      'Accept, prepare and hand over orders',
      'something:new',
    ]);
  });
});

describe('emailProblem', () => {
  it('needs an e-mail address', () => {
    expect(emailProblem('')).not.toBeNull();
    expect(emailProblem('not-an-email')).not.toBeNull();
    expect(emailProblem(' pharmacist@example.com ')).toBeNull();
  });
});

describe('canRemoveRole (the server’s rule)', () => {
  it('only a staff role, never the owner role, never one’s own', () => {
    expect(canRemoveRole('u-2', 'PHARMACIST', 'u-1', assignable)).toBe(true);
    expect(canRemoveRole('u-2', OWNER_ROLE, 'u-1', assignable)).toBe(false);
    expect(canRemoveRole('u-1', 'PHARMACIST', 'u-1', assignable)).toBe(false);
    expect(canRemoveRole('u-2', 'ADMIN', 'u-1', assignable)).toBe(false);
  });
});

describe('pharmacyStaffService', () => {
  it('lists, adds by trimmed e-mail and removes one role', async () => {
    const request = vi.fn().mockResolvedValue({});
    const s = createPharmacyStaffService(request as unknown as SessionRequest);

    await s.list();
    expect(request).toHaveBeenLastCalledWith('/pharmacy/staff', { method: 'GET' });
    await s.add(' new@example.com ', 'CASHIER');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/staff', { method: 'POST', body: { email: 'new@example.com', roleKey: 'CASHIER' } });
    await s.removeRole('u/2', 'CASHIER');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/staff/u%2F2/roles/CASHIER', { method: 'DELETE' });
  });

  it('offers no other operation', () => {
    const s = createPharmacyStaffService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(s).sort()).toEqual(['add', 'list', 'removeRole']);
  });
});
