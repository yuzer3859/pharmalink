import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import {
  createAdminProvidersService,
  facilityFileProblem,
  providerActionMessage,
  providerQuery,
  providerRegistrationProblem,
  providerTypeLabel,
} from './adminProviders.service';
import { PORTALS } from '@/config/navigation';
import { pageFor } from '@/routes/pageRegistry';
import { ProvidersPage } from '@/features/providers/ProvidersPage';
import type { SessionRequest } from './auth.service';

const ADMIN = '88888888-8888-4888-8888-888888888888';
const PROVIDER = '99999999-9999-4999-8999-999999999999';
const form = {
  adminUserId: ADMIN,
  type: 'HOSPITAL' as const,
  legalName: 'Tikur Anbessa Hospital PLC',
  displayName: ' Tikur Anbessa Hospital ',
  licenseNumber: ' MOH/HF/1 ',
  licenseExpiresOn: '2027-06-30',
  documents: [{ kind: 'FACILITY_LICENSE' as const, storageRef: 'doc:verification/u/1' }],
};

describe('healthcare providers in the portal (Work 163)', () => {
  it('lists providers by name, type and status', async () => {
    expect(providerQuery({ q: ' anbessa ', type: 'LAB', status: 'SUSPENDED', page: 2, size: 25 })).toBe('?q=anbessa&type=LAB&status=SUSPENDED&page=2&size=25');
    expect(providerQuery({ type: 'all', status: 'all' })).toBe('');
    const request = vi.fn(async () => ({ items: [], total: 0, page: 1, size: 25 })) as unknown as SessionRequest;
    await createAdminProvidersService(request).list({ q: 'bethel' });
    expect(request).toHaveBeenCalledWith('/admin/providers?q=bethel', { method: 'GET' });
    expect(providerTypeLabel('DIAGNOSTIC_CENTER')).toBe('Diagnostic centre');
  });

  it('says what is still missing before a provider can be registered', () => {
    const today = '2026-11-26';
    expect(providerRegistrationProblem(form, today)).toBeNull();
    expect(providerRegistrationProblem({ ...form, adminUserId: '' }, today)).toMatch(/administrator/);
    expect(providerRegistrationProblem({ ...form, displayName: ' ' }, today)).toMatch(/customers/);
    expect(providerRegistrationProblem({ ...form, licenseExpiresOn: '2026-01-01' }, today)).toMatch(/expired/);
    expect(providerRegistrationProblem({ ...form, documents: [] }, today)).toMatch(/licence file/);
  });

  it('uploads a licence file under the administrator and registers with trimmed values', async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith('/uploads')
        ? { storageRef: 'doc:verification/u/9', upload: { url: 'https://s.test/p', method: 'PUT', headers: {} } }
        : { organizationId: 'o', providerId: PROVIDER, adminUserId: ADMIN },
    ) as unknown as SessionRequest;
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createAdminProvidersService(request);
    const file = new File([new Uint8Array(8)], 'licence.pdf', { type: 'application/pdf' });
    expect(await service.uploadLicenceFile(ADMIN, file, put as unknown as typeof fetch)).toBe('doc:verification/u/9');
    expect(request).toHaveBeenCalledWith('/admin/provider-registrations/uploads', { method: 'POST', body: { adminUserId: ADMIN, contentType: 'application/pdf', bytes: 8 } });

    await service.register({ ...form, idempotencyKey: 'k' });
    expect(request).toHaveBeenLastCalledWith('/admin/provider-registrations', {
      method: 'POST',
      body: { ...form, displayName: 'Tikur Anbessa Hospital', licenseNumber: 'MOH/HF/1', idempotencyKey: 'k' },
    });
    expect(facilityFileProblem({ type: 'image/gif', size: 1 })).toMatch(/PDF/);
    await expect(service.uploadLicenceFile(ADMIN, new File(['x'], 'a.gif', { type: 'image/gif' }))).rejects.toBeInstanceOf(ApiError);
  });

  it('disables with a trimmed reason, enables, and explains a refused enable', async () => {
    const request = vi.fn(async () => ({})) as unknown as SessionRequest;
    const service = createAdminProvidersService(request);
    await service.suspend(PROVIDER, '  Inspection pending ');
    expect(request).toHaveBeenLastCalledWith(`/admin/providers/${PROVIDER}/suspend`, { method: 'POST', body: { reason: 'Inspection pending' } });
    await service.reactivate(PROVIDER);
    expect(request).toHaveBeenLastCalledWith(`/admin/providers/${PROVIDER}/reactivate`, { method: 'POST', body: {} });

    const expired = new ApiError(403, 'PROVIDER_NOT_ELIGIBLE', 'not eligible', { reason: 'LICENSE_EXPIRED' });
    expect(providerActionMessage(expired, 'x')).toMatch(/licence has expired/);
    expect(providerActionMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });

  it('routes Healthcare providers in the admin and super admin portals only, behind providers:view', () => {
    for (const portal of ['admin', 'superadmin'] as const) {
      expect(PORTALS[portal].nav.find((i) => i.path === 'providers')?.permission).toBe('providers:view');
      expect(pageFor(portal, 'providers')).toBe(ProvidersPage);
    }
    expect(PORTALS.pharmacy.nav.some((i) => i.path === 'providers')).toBe(false);
  });
});
