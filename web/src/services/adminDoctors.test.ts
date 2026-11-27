import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import {
  appointmentTimeLabel,
  createAdminDoctorsService,
  createFacilityDoctorsService,
  doctorActionMessage,
  doctorFileProblem,
  doctorQuery,
  doctorRegistrationProblem,
  feeLabel,
} from './adminDoctors.service';
import { toAuthUser, type BackendCurrentUser, type SessionRequest } from './auth.service';
import { PORTALS } from '@/config/navigation';
import { pageFor } from '@/routes/pageRegistry';
import { DoctorsPage } from '@/features/doctors/DoctorsPage';
import { FacilityDoctorsPage } from '@/features/facility/FacilityDoctorsPage';
import { FacilityAppointmentsPage } from '@/features/facility/FacilityAppointmentsPage';

const USER = '77777777-7777-4777-8777-777777777777';
const DOCTOR = '88888888-8888-4888-8888-888888888888';
const form = {
  userId: USER,
  fullName: ' Dr. Selamawit Bekele ',
  fullNameAm: '',
  specialty: 'Cardiology',
  licenseNumber: ' EMA/MD/1 ',
  licenseExpiresOn: '2027-06-30',
  documents: [{ kind: 'MEDICAL_LICENSE' as const, storageRef: 'doc:verification/u/1' }],
};

const admin = (permissions: string[]): BackendCurrentUser => ({
  id: 'a',
  phone: null,
  email: 'admin@pharmalink.test',
  primaryRole: 'ADMIN',
  status: 'ACTIVE',
  preferredLanguage: 'en',
  phoneVerifiedAt: null,
  emailVerifiedAt: null,
  faydaVerified: false,
  deletionRequestedAt: null,
  roles: [{ roleKey: 'ADMIN', organizationId: null }],
  permissions,
});

describe('doctors in the portal (Work 169)', () => {
  it('lists doctors by name, specialty and status', async () => {
    expect(doctorQuery({ q: ' selam ', specialty: 'Cardiology', status: 'SUSPENDED', page: 2, size: 25 })).toBe('?q=selam&specialty=Cardiology&status=SUSPENDED&page=2&size=25');
    expect(doctorQuery({ status: 'all' })).toBe('');
    const request = vi.fn(async () => ({ items: [], total: 0, page: 1, size: 25 })) as unknown as SessionRequest;
    await createAdminDoctorsService(request).list({ q: 'abebe' });
    expect(request).toHaveBeenCalledWith('/admin/doctors?q=abebe', { method: 'GET' });
  });

  it('says what is missing before a doctor can be registered, and sends trimmed values', async () => {
    const today = '2026-11-28';
    expect(doctorRegistrationProblem(form, today)).toBeNull();
    expect(doctorRegistrationProblem({ ...form, userId: '' }, today)).toMatch(/person/);
    expect(doctorRegistrationProblem({ ...form, fullName: 'Dr' }, today)).toMatch(/name/);
    expect(doctorRegistrationProblem({ ...form, licenseExpiresOn: '2026-01-01' }, today)).toMatch(/expired/);
    expect(doctorRegistrationProblem({ ...form, documents: [{ kind: 'NATIONAL_ID', storageRef: 'doc:x' }] }, today)).toMatch(/medical licence/);
    expect(doctorFileProblem({ type: 'image/gif', size: 1 })).toMatch(/PDF/);

    const request = vi.fn(async () => ({ userId: USER, doctorId: DOCTOR })) as unknown as SessionRequest;
    await createAdminDoctorsService(request).register(form);
    expect(request).toHaveBeenCalledWith('/admin/doctor-registrations', {
      method: 'POST',
      body: { userId: USER, fullName: 'Dr. Selamawit Bekele', specialty: 'Cardiology', licenseNumber: 'EMA/MD/1', licenseExpiresOn: '2027-06-30', documents: form.documents },
    });
  });

  it('disables, enables and explains a refused enable', async () => {
    const request = vi.fn(async () => ({})) as unknown as SessionRequest;
    const service = createAdminDoctorsService(request);
    await service.suspend(DOCTOR, '  Complaint under review ');
    expect(request).toHaveBeenLastCalledWith(`/admin/doctors/${DOCTOR}/suspend`, { method: 'POST', body: { reason: 'Complaint under review' } });
    await service.reactivate(DOCTOR);
    expect(request).toHaveBeenLastCalledWith(`/admin/doctors/${DOCTOR}/reactivate`, { method: 'POST', body: {} });
    expect(doctorActionMessage(new ApiError(403, 'DOCTOR_NOT_VERIFIED', 'x'), 'f')).toMatch(/licence has expired/);
    expect(doctorActionMessage(new Error('x'), 'fallback')).toBe('fallback');
  });

  it('a facility adds and removes doctors and reads its appointments', async () => {
    const request = vi.fn(async () => ({ items: [] })) as unknown as SessionRequest;
    const service = createFacilityDoctorsService(request);
    await service.add({ identifier: ' doc@pharmalink.test ', roleTitle: ' ' });
    expect(request).toHaveBeenLastCalledWith('/provider/doctors', { method: 'POST', body: { identifier: 'doc@pharmalink.test' } });
    await service.remove(DOCTOR);
    expect(request).toHaveBeenLastCalledWith(`/provider/doctors/${DOCTOR}`, { method: 'DELETE' });
    await service.appointments({ from: '2026-11-30', to: '2026-12-06' });
    expect(request).toHaveBeenLastCalledWith('/provider/appointments?from=2026-11-30&to=2026-12-06', { method: 'GET' });
  });

  it('shows fees and times the way people read them', () => {
    expect(feeLabel(50000)).toBe('ETB 500');
    expect(feeLabel(null)).toBe('—');
    expect(appointmentTimeLabel('2026-11-30T06:00:00.000Z')).toMatch(/Mon.*30 Nov.*09:00/);
  });

  it('gives doctor pages to administrators who may read doctors, and the actions only with every grant', () => {
    expect(toAuthUser(admin(['doctor:read:any'])).permissions).toContain('doctors:view');
    expect(toAuthUser(admin(['doctor:read:any'])).permissions).not.toContain('doctors:manage');
    expect(toAuthUser(admin(['doctor:read:any', 'provider:verify:any', 'user:suspend:any', 'user:reactivate:any'])).permissions).toContain('doctors:manage');
    for (const portal of ['admin', 'superadmin'] as const) {
      expect(PORTALS[portal].nav.find((i) => i.path === 'doctors')?.permission).toBe('doctors:view');
      expect(pageFor(portal, 'doctors')).toBe(DoctorsPage);
    }
    expect(pageFor('facility', 'doctors')).toBe(FacilityDoctorsPage);
    expect(pageFor('facility', 'appointments')).toBe(FacilityAppointmentsPage);
  });
});
