import { describe, expect, it, vi } from 'vitest';
import { toAuthUser, type BackendCurrentUser, type SessionRequest } from './auth.service';
import {
  addDays,
  createDoctorPortalService,
  emptyRule,
  profileBody,
  profileFormFrom,
  profileProblem,
  ruleBody,
  ruleLabel,
  ruleProblem,
  type DoctorProfile,
} from './doctorPortal.service';
import { PORTALS } from '@/config/navigation';
import { pageFor } from '@/routes/pageRegistry';
import { DoctorAvailabilityPage } from '@/features/doctor-portal/DoctorAvailabilityPage';

const doctor = (permissions: string[]): BackendCurrentUser => ({
  id: 'd',
  phone: null,
  email: 'dr@pharmalink.test',
  primaryRole: 'DOCTOR',
  status: 'ACTIVE',
  preferredLanguage: 'en',
  phoneVerifiedAt: null,
  emailVerifiedAt: '2026-11-05T00:00:00.000Z',
  faydaVerified: false,
  deletionRequestedAt: null,
  roles: [
    { roleKey: 'CUSTOMER', organizationId: null },
    { roleKey: 'DOCTOR', organizationId: null },
  ],
  permissions,
});

const profile = {
  doctorId: 'x',
  userId: 'd',
  fullName: 'Dr. Selamawit Bekele',
  fullNameAm: null,
  specialty: 'Cardiology',
  status: 'ACTIVE',
  isVerified: true,
  licenseNumber: 'EMA/1',
  licenseExpiresAt: null,
  createdAt: '2026-11-28T00:00:00.000Z',
  subSpecialties: ['Echocardiography'],
  qualifications: [],
  yearsExperience: 12,
  bio: null,
  languages: ['Amharic', 'English'],
  consultationFeeInPerson: 50000,
  consultationFeeTele: null,
  currency: 'ETB',
  acceptsTelemedicine: false,
  ratingAvg: 0,
  ratingCount: 0,
  affiliations: [{ providerId: 'p1', providerName: 'Tikur Anbessa Hospital', providerType: 'HOSPITAL', departmentId: null, departmentName: null, roleTitle: null, isPrimary: true }],
} as DoctorProfile;

describe('the doctor portal (Work 170)', () => {
  it('sends doctors to their own portal, named Doctor, with its pages', () => {
    expect(toAuthUser(doctor(['auth:login', 'doctor:manage:own', 'appointment:book:own']))).toMatchObject({ portal: 'doctor', roleName: 'Doctor', permissions: ['doctor:view', 'doctor:manage'] });
    expect(toAuthUser(doctor(['auth:login'])).permissions).toEqual([]);
    expect(PORTALS.doctor.nav.map((i) => i.path)).toEqual(['appointments', 'schedule', 'availability', 'profile']);
    for (const item of PORTALS.doctor.nav) expect(pageFor('doctor', item.path)).toBeDefined();
    expect(pageFor('doctor', 'availability')).toBe(DoctorAvailabilityPage);
  });

  it('edits the profile in birr and comma lists', () => {
    const form = profileFormFrom(profile);
    expect(form).toMatchObject({ subSpecialties: 'Echocardiography', languages: 'Amharic, English', feeInPerson: '500', feeTele: '', yearsExperience: '12' });
    expect(profileBody({ ...form, feeTele: '350.5', languages: ' Amharic , Afaan Oromo,, ' })).toMatchObject({ consultationFeeInPerson: 50000, consultationFeeTele: 35050, languages: ['Amharic', 'Afaan Oromo'] });
    expect(profileProblem({ ...form, yearsExperience: '7.5' })).toMatch(/whole years/);
    expect(profileProblem({ ...form, feeInPerson: '-1' })).toMatch(/birr/);
  });

  it('checks availability before sending it', () => {
    const rule = { ...emptyRule(), providerLocationId: 'loc-1' };
    expect(ruleProblem(rule, false)).toBeNull();
    expect(ruleProblem({ ...rule, providerLocationId: '' }, false)).toMatch(/where you see patients/);
    expect(ruleProblem({ ...rule, appointmentType: 'TELEMEDICINE' }, false)).toMatch(/video/);
    expect(ruleProblem({ ...rule, endTime: '08:00' }, false)).toMatch(/after the start/);
    expect(ruleProblem({ ...rule, startTime: '09:00', endTime: '09:20' }, false)).toMatch(/shorter than one appointment/);
    expect(ruleProblem({ ...rule, type: 'EXCEPTION_BLOCK', wholeDay: true }, false)).toMatch(/day/);
    expect(ruleProblem({ ...rule, type: 'EXCEPTION_BLOCK', wholeDay: true, fromDate: '2026-12-01' }, false)).toBeNull();

    expect(ruleBody(rule)).toEqual({ type: 'RECURRING', weekday: 1, startTime: '09:00', endTime: '12:00', slotDurationMinutes: 30, bufferMinutes: 0, appointmentType: 'IN_PERSON', providerLocationId: 'loc-1' });
    expect(ruleBody({ ...rule, type: 'EXCEPTION_BLOCK', wholeDay: true, fromDate: '2026-12-01' })).toEqual({ type: 'EXCEPTION_BLOCK', fromDate: '2026-12-01', appointmentType: 'BOTH' });
  });

  it('describes rules in words', () => {
    const locations = [{ locationId: 'loc-1', name: 'Main campus', providerName: 'Tikur Anbessa Hospital', city: 'Addis Ababa' }];
    const base = { ruleId: 'r', validFrom: null, validTo: null, slotDurationMinutes: 30, bufferMinutes: 0, providerLocationId: 'loc-1' };
    expect(ruleLabel({ ...base, type: 'RECURRING', weekday: 1, startTime: '09:00', endTime: '12:00', appointmentType: 'IN_PERSON' }, locations)).toBe('Every Monday, 09:00–12:00, 30 min, in person at Main campus');
    expect(ruleLabel({ ...base, type: 'EXCEPTION_BLOCK', weekday: null, startTime: null, endTime: null, validFrom: '2026-11-30T21:00:00.000Z', appointmentType: 'BOTH', providerLocationId: null }, locations)).toBe('Time off 1 Dec 2026, all day');
  });

  it('calls the doctor API', async () => {
    const request = vi.fn(async () => ({ items: [] })) as unknown as SessionRequest;
    const service = createDoctorPortalService(request);
    await service.slots('2026-11-30', addDays('2026-11-30', 6));
    expect(request).toHaveBeenLastCalledWith('/doctor/slots?from=2026-11-30&to=2026-12-06', { method: 'GET' });
    await service.setBlocked('s1', true);
    expect(request).toHaveBeenLastCalledWith('/doctor/slots/s1/block', { method: 'POST', body: {} });
    await service.act('a1', 'cancel', '  Called into surgery ');
    expect(request).toHaveBeenLastCalledWith('/doctor/appointments/a1/cancel', { method: 'POST', body: { reason: 'Called into surgery' } });
    await service.act('a1', 'complete');
    expect(request).toHaveBeenLastCalledWith('/doctor/appointments/a1/complete', { method: 'POST', body: {} });
    await service.appointments('2026-11-30', '2026-12-06');
    expect(request).toHaveBeenLastCalledWith('/doctor/appointments?from=2026-11-30&to=2026-12-06', { method: 'GET' });
  });
});
