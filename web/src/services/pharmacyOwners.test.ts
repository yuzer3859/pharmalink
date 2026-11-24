import { describe, expect, it, vi } from 'vitest';
import { createPharmacyOwnersService, ownerChangeSummary, ownerQuery } from './pharmacyOwners.service';
import { PORTALS } from '@/config/navigation';
import { pageFor } from '@/routes/pageRegistry';
import { PharmacyOwnersPage } from '@/features/pharmacies/PharmacyOwnersPage';
import type { SessionRequest } from './auth.service';

const OWNER = '88888888-8888-4888-8888-888888888888';

describe('pharmacy owners (Work 157)', () => {
  it('searches by exact e-mail or phone (3+ characters) and account status', () => {
    expect(ownerQuery({ identifier: ' a@b.et ', status: 'SUSPENDED', page: 1, size: 25 })).toBe('?identifier=a%40b.et&status=SUSPENDED&page=1&size=25');
    expect(ownerQuery({ identifier: 'ab', status: 'all' })).toBe('');
  });

  it('reads an owner, disables them (with a trimmed reason) and enables them again', async () => {
    const request = vi.fn(async () => ({})) as unknown as SessionRequest;
    const service = createPharmacyOwnersService(request);
    await service.get(OWNER);
    expect(request).toHaveBeenLastCalledWith(`/admin/pharmacy-owners/${OWNER}`, { method: 'GET' });
    await service.disable(OWNER, '  Fraud review. ', true);
    expect(request).toHaveBeenLastCalledWith(`/admin/pharmacy-owners/${OWNER}/disable`, { method: 'POST', body: { reason: 'Fraud review.', alsoPharmacies: true } });
    await service.enable(OWNER, false);
    expect(request).toHaveBeenLastCalledWith(`/admin/pharmacy-owners/${OWNER}/enable`, { method: 'POST', body: { alsoPharmacies: false } });
  });

  it('says what happened to each pharmacy', () => {
    const names = new Map([['p1', 'Bole'], ['p2', 'Piassa']]);
    expect(
      ownerChangeSummary(
        { account: { previousStatus: 'SUSPENDED', status: 'ACTIVE' }, pharmacies: [{ pharmacyId: 'p1', outcome: 'enabled' }, { pharmacyId: 'p2', outcome: 'not enabled', reason: 'Licence expired' }] },
        names,
      ),
    ).toBe('Bole: enabled; Piassa: not enabled (Licence expired)');
  });

  it('routes Pharmacy owners in the admin portals only', () => {
    for (const portal of ['admin', 'superadmin'] as const) {
      expect(PORTALS[portal].nav.find((i) => i.path === 'pharmacy-owners')?.permission).toBe('pharmacies:view');
      expect(pageFor(portal, 'pharmacy-owners')).toBe(PharmacyOwnersPage);
    }
    expect(pageFor('pharmacy', 'pharmacy-owners')).toBeUndefined();
  });
});
