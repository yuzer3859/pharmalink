import { describe, expect, it, vi } from 'vitest';
import { toAuthUser, type BackendCurrentUser } from './auth.service';
import {
  createFacilityPortalService,
  departmentProblem,
  hoursBody,
  hoursProblem,
  locationBody,
  locationProblem,
  offersServices,
  profileBody,
  profileProblem,
  serviceBody,
  serviceProblem,
  weekFrom,
  type LocationForm,
} from './facilityPortal.service';
import { PORTALS } from '@/config/navigation';
import { pageFor } from '@/routes/pageRegistry';
import { FacilityServicesPage } from '@/features/facility/FacilityServicesPage';
import type { SessionRequest } from './auth.service';

function facilityAdmin(roleKey: string, permissions: string[]): BackendCurrentUser {
  return {
    id: 'user-1',
    phone: null,
    email: 'admin@hospital.test',
    primaryRole: 'CUSTOMER',
    status: 'ACTIVE',
    preferredLanguage: 'en',
    phoneVerifiedAt: null,
    emailVerifiedAt: '2026-11-05T00:00:00.000Z',
    faydaVerified: false,
    deletionRequestedAt: null,
    roles: [
      { roleKey: 'CUSTOMER', organizationId: null },
      { roleKey, organizationId: 'org-1' },
    ],
    permissions,
  };
}

const location: LocationForm = { name: ' Main campus ', city: 'Addis Ababa', subcity: ' Lideta ', woreda: '', addressLine: '', lat: '9.0206', lng: '38.7469', phone: '', emergencyAvailability: 'H24_7', isPrimary: true };

describe('the facility portal (Work 164)', () => {
  it('sends hospital and lab administrators to the facility portal, named by their role', () => {
    const hospital = toAuthUser(facilityAdmin('HOSPITAL_ADMIN', ['auth:login', 'provider:manage:org']));
    expect(hospital).toMatchObject({ portal: 'facility', roleName: 'Hospital Administrator', permissions: ['facility:view', 'facility:manage'] });
    expect(toAuthUser(facilityAdmin('DIAGNOSTIC_CENTER_ADMIN', ['provider:manage:org'])).roleName).toBe('Diagnostic Centre Administrator');
    expect(toAuthUser(facilityAdmin('HOSPITAL_ADMIN', ['auth:login'])).permissions).toEqual([]);
  });

  it('has Profile, Locations, Departments, Services, Doctors and Appointments behind facility:view', () => {
    expect(PORTALS.facility.basePath).toBe('/facility');
    expect(PORTALS.facility.nav.map((i) => [i.path, i.permission])).toEqual([
      ['profile', 'facility:view'],
      ['locations', 'facility:view'],
      ['departments', 'facility:view'],
      ['services', 'facility:view'],
      ['doctors', 'facility:view'],
      ['appointments', 'facility:view'],
    ]);
    for (const item of PORTALS.facility.nav) expect(pageFor('facility', item.path)).toBeDefined();
    expect(pageFor('facility', 'services')).toBe(FacilityServicesPage);
  });

  it('checks a profile and sends only what is filled in', () => {
    const form = { nameEn: '', nameAm: ' ጥቁር አንበሳ ', description: '', website: 'https://ta.example', contactPhone: '+251 11 551 7611', contactEmail: '' };
    expect(profileProblem(form)).toBeNull();
    expect(profileBody(form)).toEqual({ nameAm: 'ጥቁር አንበሳ', website: 'https://ta.example', contactPhone: '+251 11 551 7611' });
    expect(profileProblem({ ...form, website: 'javascript:alert(1)' })).toMatch(/https/);
    expect(profileProblem({ ...form, contactEmail: 'nope' })).toMatch(/e-mail/);
  });

  it('needs a location’s map position, inside Ethiopia', () => {
    expect(locationProblem(location)).toBeNull();
    expect(locationProblem({ ...location, lat: '' })).toMatch(/map position/);
    expect(locationProblem({ ...location, lat: '51.5', lng: '-0.12' })).toMatch(/Ethiopia/);
    expect(locationBody(location)).toEqual({ name: 'Main campus', city: 'Addis Ababa', subcity: 'Lideta', woreda: undefined, addressLine: undefined, lat: 9.0206, lng: 38.7469, phone: undefined, emergencyAvailability: 'H24_7', isPrimary: true });
  });

  it('shows every day of the week and sends open and closed days', () => {
    const week = weekFrom([{ weekday: 1, openTime: '08:00', closeTime: '17:30', isClosed: false }]);
    expect(week).toHaveLength(7);
    expect(week[1]).toEqual({ weekday: 1, open: true, openTime: '08:00', closeTime: '17:30' });
    expect(week[0].open).toBe(false);
    expect(hoursBody(week).slice(0, 2)).toEqual([{ weekday: 0, isClosed: true }, { weekday: 1, openTime: '08:00', closeTime: '17:30' }]);
    expect(hoursProblem(week.map((d) => (d.weekday === 1 ? { ...d, closeTime: '08:00' } : d)))).toMatch(/differ/);
  });

  it('checks departments and services; services only for labs and diagnostic centres', () => {
    expect(departmentProblem({ name: 'C', specialty: '', description: '', contactPhone: '' })).toMatch(/name/);
    const service = { type: 'LAB_TEST' as const, name: 'Complete blood count', code: 'CBC', price: '250.50', durationMinutes: '15', preparationInstructions: '', locationId: '', isAvailable: true };
    expect(serviceProblem(service)).toBeNull();
    expect(serviceBody(service)).toEqual({ type: 'LAB_TEST', name: 'Complete blood count', code: 'CBC', price: 25050, durationMinutes: 15, preparationInstructions: undefined, locationId: undefined, isAvailable: true });
    expect(serviceBody({ ...service, price: ' ' }).price).toBeUndefined();
    expect(serviceProblem({ ...service, price: '-5' })).toMatch(/birr/);
    expect(serviceProblem({ ...service, durationMinutes: '1.5' })).toMatch(/minutes/);
    expect([offersServices('LAB'), offersServices('DIAGNOSTIC_CENTER'), offersServices('HOSPITAL'), offersServices(undefined)]).toEqual([true, true, false, false]);
  });

  it('calls the facility API', async () => {
    const request = vi.fn(async () => ({ items: [] })) as unknown as SessionRequest;
    const service = createFacilityPortalService(request);
    await service.mine();
    expect(request).toHaveBeenLastCalledWith('/provider/mine', { method: 'GET' });
    await service.setHours('loc-1', weekFrom([]));
    expect(request).toHaveBeenLastCalledWith('/provider/locations/loc-1/hours', { method: 'PUT', body: { hours: expect.arrayContaining([{ weekday: 0, isClosed: true }]) } });
    await service.closeDepartment('dep-1');
    expect(request).toHaveBeenLastCalledWith('/provider/departments/dep-1', { method: 'DELETE' });
    await service.reopenDepartment('dep-1');
    expect(request).toHaveBeenLastCalledWith('/provider/departments/dep-1', { method: 'PATCH', body: { isActive: true } });
  });
});
