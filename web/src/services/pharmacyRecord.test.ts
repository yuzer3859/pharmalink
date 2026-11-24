import { describe, expect, it, vi } from 'vitest';
import { createPharmaciesService, isValidSuspendReason, personLabel, pharmacyQuery } from './pharmacies.service';
import { verificationQuery } from './adminVerifications.service';
import type { SessionRequest } from './auth.service';

const ID = '44444444-4444-4444-8444-444444444444';

describe('the pharmacy record (Work 153)', () => {
  it('searches by part of the name, trimmed, alongside the other filters', () => {
    expect(pharmacyQuery({ q: '  Bole ', transactingStatus: 'SUSPENDED', page: 1 })).toBe('?q=Bole&transactingStatus=SUSPENDED&page=1');
    expect(pharmacyQuery({ q: '   ' })).toBe('');
    expect(verificationQuery({ organizationId: 'org-1', status: 'all', size: 50 })).toBe('?organizationId=org-1&size=50');
  });

  it('reads the people behind a pharmacy, and disables it with a trimmed reason', async () => {
    const request = vi.fn(async () => ({})) as unknown as SessionRequest;
    const service = createPharmaciesService(request);
    await service.people(ID);
    expect(request).toHaveBeenLastCalledWith(`/admin/operations/pharmacies/${ID}/people`, { method: 'GET' });
    await service.suspend(ID, '  Licence under investigation. ');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/suspend', { method: 'POST', body: { pharmacyId: ID, reason: 'Licence under investigation.' } });
  });

  it('needs a reason of 3 to 500 characters, and names a person by e-mail, else phone', () => {
    expect(isValidSuspendReason('  ab ')).toBe(false);
    expect(isValidSuspendReason('Fraud')).toBe(true);
    expect(isValidSuspendReason('x'.repeat(501))).toBe(false);
    expect(personLabel({ userId: 'u1', email: 'a@b.et', phone: '+251911', status: 'ACTIVE' })).toBe('a@b.et');
    expect(personLabel({ userId: 'u1', email: null, phone: '+251911', status: 'ACTIVE' })).toBe('+251911');
    expect(personLabel({ userId: 'u1', email: null, phone: null, status: 'ACTIVE' })).toBe('u1');
  });
});
