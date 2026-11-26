import { authService, type SessionRequest } from './auth.service';
import type { ProviderRecord, ProviderType } from './adminProviders.service';

/** Work 164: a facility administrator's own portal over Work 161's `/provider` API. */

export interface MyFacility {
  providerId: string;
  /** Chosen with `selectOrganization` and sent as `X-Organization-Id`. */
  organizationId: string;
  type: ProviderType;
  displayName: string;
  status: string;
}

/** The facility's own profile: the provider record without the organisation part. */
export type FacilityProfile = Omit<ProviderRecord, 'organization'>;
export type FacilityLocation = FacilityProfile['locations'][number];
export type FacilityDepartment = FacilityProfile['departments'][number];
export type FacilityService = FacilityProfile['services'][number];

export interface ProfileForm {
  nameEn: string;
  nameAm: string;
  description: string;
  website: string;
  contactPhone: string;
  contactEmail: string;
}

export interface LocationForm {
  name: string;
  city: string;
  subcity: string;
  woreda: string;
  addressLine: string;
  lat: string;
  lng: string;
  phone: string;
  emergencyAvailability: 'NONE' | 'BUSINESS_HOURS' | 'H24_7';
  isPrimary: boolean;
}

export interface DayHours {
  weekday: number;
  open: boolean;
  openTime: string;
  closeTime: string;
}

export interface DepartmentForm {
  name: string;
  specialty: string;
  description: string;
  contactPhone: string;
}

export interface ServiceForm {
  type: 'LAB_TEST' | 'IMAGING' | 'SCREENING_PACKAGE';
  name: string;
  code: string;
  /** Birr, as typed; sent in santim. Blank means price on request. */
  price: string;
  durationMinutes: string;
  preparationInstructions: string;
  locationId: string;
  isAvailable: boolean;
}

/** Labs and diagnostic centres list tests, imaging and packages; hospitals and clinics do not (module-09 §5.3). */
export const offersServices = (type: string | undefined) => type === 'LAB' || type === 'DIAGNOSTIC_CENTER';

const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ETHIOPIA = { minLat: 3.397, maxLat: 14.894, minLng: 32.998, maxLng: 47.978 };

/** A blank text field is left out; trimmed otherwise. */
const optional = (value: string) => (value.trim() ? value.trim() : undefined);

export function profileBody(form: ProfileForm): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    const v = optional(value);
    if (v !== undefined) body[key] = v;
  }
  return body;
}

export function profileProblem(form: ProfileForm): string | null {
  if (form.website.trim() && !/^https?:\/\/\S+$/i.test(form.website.trim())) return 'The website must start with https:// or http://.';
  if (form.contactPhone.trim() && !PHONE.test(form.contactPhone.trim())) return 'Enter a phone number like +251 11 551 7611.';
  if (form.contactEmail.trim() && !/^\S+@\S+\.\S+$/.test(form.contactEmail.trim())) return 'Enter a valid e-mail address.';
  return null;
}

export function locationProblem(form: LocationForm): string | null {
  if (form.name.trim().length < 2) return 'Give the location a name.';
  if (form.city.trim().length < 2) return 'Enter the city.';
  const lat = Number(form.lat);
  const lng = Number(form.lng);
  if (form.lat.trim() === '' || form.lng.trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lng)) return 'Enter the map position (latitude and longitude), or use your current position.';
  if (lat < ETHIOPIA.minLat || lat > ETHIOPIA.maxLat || lng < ETHIOPIA.minLng || lng > ETHIOPIA.maxLng) return 'The map position must be in Ethiopia.';
  if (form.phone.trim() && !PHONE.test(form.phone.trim())) return 'Enter a phone number like +251 11 551 7611.';
  return null;
}

export function locationBody(form: LocationForm) {
  return {
    name: form.name.trim(),
    city: form.city.trim(),
    subcity: optional(form.subcity),
    woreda: optional(form.woreda),
    addressLine: optional(form.addressLine),
    lat: Number(form.lat),
    lng: Number(form.lng),
    phone: optional(form.phone),
    emergencyAvailability: form.emergencyAvailability,
    isPrimary: form.isPrimary,
  };
}

/** The week as the form shows it: every day, closed unless the location says otherwise. */
export function weekFrom(hours: FacilityLocation['hours']): DayHours[] {
  return Array.from({ length: 7 }, (_, weekday) => {
    const h = hours.find((x) => x.weekday === weekday);
    return { weekday, open: !!h && !h.isClosed, openTime: h?.openTime ?? '08:00', closeTime: h?.closeTime ?? '17:00' };
  });
}

export function hoursProblem(week: DayHours[]): string | null {
  for (const d of week) {
    if (!d.open) continue;
    if (!TIME.test(d.openTime) || !TIME.test(d.closeTime)) return 'Times are HH:MM, for example 08:30.';
    if (d.openTime === d.closeTime) return 'Opening and closing time must differ.';
  }
  return null;
}

export const hoursBody = (week: DayHours[]) =>
  week.map((d) => (d.open ? { weekday: d.weekday, openTime: d.openTime, closeTime: d.closeTime } : { weekday: d.weekday, isClosed: true }));

export function departmentProblem(form: DepartmentForm): string | null {
  if (form.name.trim().length < 2) return 'Give the department a name.';
  if (form.contactPhone.trim() && !PHONE.test(form.contactPhone.trim())) return 'Enter a phone number like +251 11 551 7611.';
  return null;
}

export const departmentBody = (form: DepartmentForm) => ({
  name: form.name.trim(),
  specialty: optional(form.specialty),
  description: optional(form.description),
  contactPhone: optional(form.contactPhone),
});

export function serviceProblem(form: ServiceForm): string | null {
  if (form.name.trim().length < 2) return 'Give the service a name.';
  if (form.price.trim() && !(Number(form.price) >= 0 && Number(form.price) <= 1_000_000)) return 'Enter the price in birr, or leave it blank.';
  if (form.durationMinutes.trim() && !(Number.isInteger(Number(form.durationMinutes)) && Number(form.durationMinutes) >= 1 && Number(form.durationMinutes) <= 1440)) {
    return 'The duration is whole minutes, 1 to 1440.';
  }
  return null;
}

export const serviceBody = (form: ServiceForm) => ({
  type: form.type,
  name: form.name.trim(),
  code: optional(form.code),
  price: form.price.trim() ? Math.round(Number(form.price) * 100) : undefined,
  durationMinutes: form.durationMinutes.trim() ? Number(form.durationMinutes) : undefined,
  preparationInstructions: optional(form.preparationInstructions),
  locationId: form.locationId || undefined,
  isAvailable: form.isAvailable,
});

export function createFacilityPortalService(request: SessionRequest) {
  return {
    async mine(): Promise<MyFacility[]> {
      return (await request<{ items: MyFacility[] }>('/provider/mine', { method: 'GET' })).items;
    },
    profile(): Promise<FacilityProfile> {
      return request<FacilityProfile>('/provider/profile', { method: 'GET' });
    },
    updateProfile(form: ProfileForm): Promise<FacilityProfile> {
      return request('/provider/profile', { method: 'PATCH', body: profileBody(form) });
    },
    addLocation(form: LocationForm): Promise<{ locationId: string }> {
      return request('/provider/locations', { method: 'POST', body: locationBody(form) });
    },
    updateLocation(locationId: string, form: LocationForm): Promise<{ locationId: string }> {
      return request(`/provider/locations/${encodeURIComponent(locationId)}`, { method: 'PATCH', body: locationBody(form) });
    },
    removeLocation(locationId: string): Promise<{ removed: boolean }> {
      return request(`/provider/locations/${encodeURIComponent(locationId)}`, { method: 'DELETE' });
    },
    setHours(locationId: string, week: DayHours[]): Promise<unknown> {
      return request(`/provider/locations/${encodeURIComponent(locationId)}/hours`, { method: 'PUT', body: { hours: hoursBody(week) } });
    },
    setFacilities(locationId: string, facilities: string[]): Promise<unknown> {
      return request(`/provider/locations/${encodeURIComponent(locationId)}/facilities`, { method: 'PUT', body: { facilities } });
    },
    addDepartment(form: DepartmentForm): Promise<{ departmentId: string }> {
      return request('/provider/departments', { method: 'POST', body: departmentBody(form) });
    },
    updateDepartment(departmentId: string, form: DepartmentForm): Promise<unknown> {
      return request(`/provider/departments/${encodeURIComponent(departmentId)}`, { method: 'PATCH', body: departmentBody(form) });
    },
    reopenDepartment(departmentId: string): Promise<unknown> {
      return request(`/provider/departments/${encodeURIComponent(departmentId)}`, { method: 'PATCH', body: { isActive: true } });
    },
    closeDepartment(departmentId: string): Promise<unknown> {
      return request(`/provider/departments/${encodeURIComponent(departmentId)}`, { method: 'DELETE' });
    },
    addService(form: ServiceForm): Promise<{ serviceId: string }> {
      return request('/provider/services', { method: 'POST', body: serviceBody(form) });
    },
    updateService(serviceId: string, form: ServiceForm): Promise<unknown> {
      return request(`/provider/services/${encodeURIComponent(serviceId)}`, { method: 'PATCH', body: serviceBody(form) });
    },
    removeService(serviceId: string): Promise<unknown> {
      return request(`/provider/services/${encodeURIComponent(serviceId)}`, { method: 'DELETE' });
    },
  };
}

export const facilityPortalService = createFacilityPortalService(authService.request);
