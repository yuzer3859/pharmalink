import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import { createAdminDriversService, driverFileProblem, driverRegistrationProblem } from './adminDrivers.service';
import { PORTALS } from '@/config/navigation';
import { pageFor } from '@/routes/pageRegistry';
import { DriversPage } from '@/features/drivers/DriversPage';
import type { SessionRequest } from './auth.service';

const USER = '77777777-7777-4777-8777-777777777777';
const form = {
  userId: USER,
  vehicleType: 'MOTORCYCLE' as const,
  plateNumber: 'AA 3-12345',
  documentsExpireOn: '2027-01-31',
  documents: [{ kind: 'DRIVING_LICENSE' as const, storageRef: 'doc:verification/u/1' }],
  radiusKm: 15,
};

describe('drivers (Work 156)', () => {
  it('lists driver accounts, by exact e-mail or phone and account status', async () => {
    const request = vi.fn(async () => ({ items: [], total: 0, page: 1, size: 25 })) as unknown as SessionRequest;
    await createAdminDriversService(request).list({ identifier: ' a@b.et ', status: 'SUSPENDED', page: 2, size: 25 });
    expect(request).toHaveBeenCalledWith('/admin/accounts?primaryRole=DRIVER&identifier=a%40b.et&status=SUSPENDED&page=2&size=25', { method: 'GET' });
  });

  it('says what is still missing before a driver can be registered', () => {
    const today = '2026-11-25';
    expect(driverRegistrationProblem(form, today)).toBeNull();
    expect(driverRegistrationProblem({ ...form, userId: '' }, today)).toMatch(/person/);
    expect(driverRegistrationProblem({ ...form, plateNumber: ' ' }, today)).toMatch(/plate/);
    expect(driverRegistrationProblem({ ...form, vehicleType: 'BICYCLE', plateNumber: '' }, today)).toBeNull();
    expect(driverRegistrationProblem({ ...form, documents: [{ kind: 'NATIONAL_ID', storageRef: 'doc:x' }] }, today)).toMatch(/driving licence/);
    expect(driverRegistrationProblem({ ...form, documentsExpireOn: '2026-11-01' }, today)).toMatch(/expired/);
    expect(driverRegistrationProblem({ ...form, radiusKm: 80 }, today)).toMatch(/0.5 to 50 km/);
  });

  it('uploads a document under the person and registers with the working area around Addis Ababa', async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith('/uploads') ? { storageRef: 'doc:verification/u/9', upload: { url: 'https://s.test/p', method: 'PUT', headers: {} } } : { userId: USER, profile: {} },
    ) as unknown as SessionRequest;
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createAdminDriversService(request);
    const file = new File([new Uint8Array(8)], 'licence.png', { type: 'image/png' });
    expect(await service.uploadDocument(USER, file, put as unknown as typeof fetch)).toBe('doc:verification/u/9');
    expect(request).toHaveBeenCalledWith('/admin/drivers/uploads', { method: 'POST', body: { userId: USER, contentType: 'image/png', bytes: 8 } });

    await service.register(form);
    expect(request).toHaveBeenLastCalledWith('/admin/drivers', {
      method: 'POST',
      body: { userId: USER, vehicleType: 'MOTORCYCLE', plateNumber: 'AA 3-12345', documentsExpireOn: '2027-01-31', documents: form.documents, serviceArea: { lat: 9.0108, lng: 38.7613, radiusMeters: 15000 } },
    });
    expect(driverFileProblem({ type: 'image/gif', size: 1 })).toMatch(/PDF/);
    await expect(service.uploadDocument(USER, new File(['x'], 'a.gif', { type: 'image/gif' }))).rejects.toBeInstanceOf(ApiError);
  });

  it('routes Drivers in the admin and super admin portals only, behind drivers:view', () => {
    for (const portal of ['admin', 'superadmin'] as const) {
      expect(PORTALS[portal].nav.find((i) => i.path === 'drivers')?.permission).toBe('drivers:view');
      expect(pageFor(portal, 'drivers')).toBe(DriversPage);
    }
    expect(PORTALS.pharmacy.nav.some((i) => i.path === 'drivers')).toBe(false);
  });
});
