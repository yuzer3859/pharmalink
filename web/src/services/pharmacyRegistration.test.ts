import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import { createPharmacyRegistrationService, licenceFileProblem, registrationProblem } from './pharmacies.service';
import type { SessionRequest } from './auth.service';

const OWNER = '55555555-5555-4555-8555-555555555555';
const base = {
  ownerUserId: OWNER,
  legalName: 'Selam Pharmacy PLC',
  displayName: 'Selam Pharmacy',
  licenseNumber: 'EFDA/PH/1',
  licenseExpiresOn: '2027-06-30',
  documents: [{ kind: 'PHARMACY_LICENSE' as const, storageRef: 'doc:verification/u/1' }],
};

describe('registering a pharmacy for an owner (Work 154)', () => {
  it('accepts PDF, JPEG or PNG licence files under 10 MB', () => {
    expect(licenceFileProblem({ type: 'application/pdf', size: 1000 })).toBeNull();
    expect(licenceFileProblem({ type: 'image/webp', size: 1000 })).toMatch(/PDF, JPEG or PNG/);
    expect(licenceFileProblem({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).toMatch(/10 MB/);
  });

  it('says what is still missing, in order', () => {
    const today = '2026-11-25';
    expect(registrationProblem(base, today)).toBeNull();
    expect(registrationProblem({ ...base, ownerUserId: '' }, today)).toMatch(/owner/);
    expect(registrationProblem({ ...base, displayName: ' ' }, today)).toMatch(/customers will see/);
    expect(registrationProblem({ ...base, licenseExpiresOn: '2026-11-24' }, today)).toMatch(/expired/);
    expect(registrationProblem({ ...base, documents: [] }, today)).toMatch(/licence file/);
  });

  it('uploads a licence file under the owner, then registers with trimmed names', async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith('/uploads') ? { storageRef: 'doc:verification/o/1', upload: { url: 'https://s.test/put', method: 'PUT', headers: {} } } : { pharmacyId: 'p1', organizationId: 'o1', ownerUserId: OWNER },
    ) as unknown as SessionRequest;
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createPharmacyRegistrationService(request);

    const file = new File([new Uint8Array(20)], 'licence.pdf', { type: 'application/pdf' });
    expect(await service.uploadLicenceFile(OWNER, file, put as unknown as typeof fetch)).toBe('doc:verification/o/1');
    expect(request).toHaveBeenCalledWith('/admin/pharmacy-registrations/uploads', { method: 'POST', body: { ownerUserId: OWNER, contentType: 'application/pdf', bytes: 20 } });
    expect(put).toHaveBeenCalledWith('https://s.test/put', expect.objectContaining({ method: 'PUT', body: file }));

    await service.register({ ...base, displayName: '  Selam Pharmacy ', idempotencyKey: 'k1' });
    expect(request).toHaveBeenLastCalledWith('/admin/pharmacy-registrations', { method: 'POST', body: { ...base, displayName: 'Selam Pharmacy', idempotencyKey: 'k1' } });
  });

  it('refuses a wrong file before asking for an upload link', async () => {
    const request = vi.fn() as unknown as SessionRequest;
    await expect(createPharmacyRegistrationService(request).uploadLicenceFile(OWNER, new File(['x'], 'a.gif', { type: 'image/gif' }))).rejects.toBeInstanceOf(ApiError);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('a record’s licence files, whatever their status (Work 154)', () => {
  it('asks the queue for each status and returns them newest first, each with its documents', async () => {
    const { createAdminVerificationsService } = await import('./adminVerifications.service');
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/admin/verifications?')) {
        const status = new URLSearchParams(path.split('?')[1]).get('status');
        if (status === 'APPROVED') return { items: [{ requestId: 'a', submittedAt: '2026-01-02T00:00:00Z' }], total: 1, page: 1, size: 50 };
        if (status === 'REJECTED') return { items: [{ requestId: 'r', submittedAt: '2026-01-01T00:00:00Z' }], total: 1, page: 1, size: 50 };
        return { items: [], total: 0, page: 1, size: 50 };
      }
      return { requestId: path.split('/').pop() };
    }) as unknown as SessionRequest;
    const history = await createAdminVerificationsService(request).history({ organizationId: 'org-1' });
    expect(history.map((h) => h.requestId)).toEqual(['a', 'r']);
    const asked = (request as unknown as { mock: { calls: [string][] } }).mock.calls.map(([p]) => p).filter((p) => p.includes('?'));
    expect(asked.map((p) => new URLSearchParams(p.split('?')[1]).get('status')).sort()).toEqual(['APPROVED', 'EXPIRED', 'PENDING', 'REJECTED']);
    expect(asked.every((p) => p.includes('organizationId=org-1'))).toBe(true);
  });
});
