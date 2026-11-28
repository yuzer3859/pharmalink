import { authService, type SessionRequest } from './auth.service';
import type { DoctorRecord, StaffAppointment } from './adminDoctors.service';

/** Work 170: a doctor's own portal over Works 166–168 (`/doctor/*`). */

export type DoctorProfile = Omit<DoctorRecord, 'account'>;
export type RuleType = 'RECURRING' | 'EXCEPTION_AVAILABLE' | 'EXCEPTION_BLOCK';
export type SlotType = 'IN_PERSON' | 'TELEMEDICINE' | 'BOTH';

export interface AvailabilityRule {
  ruleId: string;
  type: RuleType;
  weekday: number | null;
  startTime: string | null;
  endTime: string | null;
  validFrom: string | null;
  validTo: string | null;
  slotDurationMinutes: number | null;
  bufferMinutes: number | null;
  appointmentType: SlotType;
  providerLocationId: string | null;
}

export interface DoctorSlot {
  slotId: string;
  startAt: string;
  endAt: string;
  appointmentType: SlotType;
  providerLocationId: string | null;
  status: 'OPEN' | 'HELD' | 'BOOKED' | 'BLOCKED';
}

/** A location where the doctor can see patients: one of their facilities' active locations. */
export interface PracticeLocation {
  locationId: string;
  name: string;
  providerName: string;
  city: string | null;
}

export interface ProfileForm {
  fullNameAm: string;
  subSpecialties: string;
  qualifications: string;
  yearsExperience: string;
  bio: string;
  languages: string;
  /** Birr, as typed; sent in santim. */
  feeInPerson: string;
  feeTele: string;
  acceptsTelemedicine: boolean;
}

export interface RuleForm {
  type: RuleType;
  weekday: number;
  startTime: string;
  endTime: string;
  /** `YYYY-MM-DD`: a weekly pattern's first day (optional), or an exception's day. */
  fromDate: string;
  /** `YYYY-MM-DD`: a weekly pattern's last day (optional). */
  toDate: string;
  slotDurationMinutes: string;
  bufferMinutes: string;
  appointmentType: SlotType;
  providerLocationId: string;
  /** Time off for the whole day (a block without times). */
  wholeDay: boolean;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const SLOT_TYPE_LABELS: Record<SlotType, string> = { IN_PERSON: 'In person', TELEMEDICINE: 'Video', BOTH: 'In person or video' };
export const APPOINTMENT_TYPE_LABELS: Record<string, string> = { IN_PERSON: 'In person', TELEMEDICINE: 'Video' };

const list = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function profileFormFrom(p: DoctorProfile): ProfileForm {
  return {
    fullNameAm: p.fullNameAm ?? '',
    subSpecialties: p.subSpecialties.join(', '),
    qualifications: p.qualifications.join(', '),
    yearsExperience: p.yearsExperience === null ? '' : String(p.yearsExperience),
    bio: p.bio ?? '',
    languages: p.languages.join(', '),
    feeInPerson: p.consultationFeeInPerson === null ? '' : String(p.consultationFeeInPerson / 100),
    feeTele: p.consultationFeeTele === null ? '' : String(p.consultationFeeTele / 100),
    acceptsTelemedicine: p.acceptsTelemedicine,
  };
}

export function profileProblem(f: ProfileForm): string | null {
  if (f.yearsExperience.trim() && !(Number.isInteger(Number(f.yearsExperience)) && Number(f.yearsExperience) >= 0 && Number(f.yearsExperience) <= 70)) return 'Experience is whole years, 0 to 70.';
  for (const fee of [f.feeInPerson, f.feeTele]) if (fee.trim() && !(Number(fee) >= 0 && Number(fee) <= 100_000)) return 'Enter fees in birr, up to 100,000.';
  if (list(f.languages).length > 10 || list(f.subSpecialties).length > 10) return 'List at most 10 languages and 10 sub-specialties.';
  return null;
}

export function profileBody(f: ProfileForm) {
  return {
    ...(f.fullNameAm.trim() ? { fullNameAm: f.fullNameAm.trim() } : {}),
    subSpecialties: list(f.subSpecialties),
    qualifications: list(f.qualifications),
    ...(f.yearsExperience.trim() ? { yearsExperience: Number(f.yearsExperience) } : {}),
    bio: f.bio.trim(),
    languages: list(f.languages),
    ...(f.feeInPerson.trim() ? { consultationFeeInPerson: Math.round(Number(f.feeInPerson) * 100) } : {}),
    ...(f.feeTele.trim() ? { consultationFeeTele: Math.round(Number(f.feeTele) * 100) } : {}),
    acceptsTelemedicine: f.acceptsTelemedicine,
  };
}

export const emptyRule = (): RuleForm => ({
  type: 'RECURRING',
  weekday: 1,
  startTime: '09:00',
  endTime: '12:00',
  fromDate: '',
  toDate: '',
  slotDurationMinutes: '30',
  bufferMinutes: '0',
  appointmentType: 'IN_PERSON',
  providerLocationId: '',
  wholeDay: false,
});

/** What is wrong with a rule before it is sent, or null. The server checks again. */
export function ruleProblem(f: RuleForm, acceptsTelemedicine: boolean): string | null {
  const block = f.type === 'EXCEPTION_BLOCK';
  if (f.type !== 'RECURRING' && !DATE.test(f.fromDate)) return 'Choose the day.';
  if (!(block && f.wholeDay)) {
    if (!TIME.test(f.startTime) || !TIME.test(f.endTime)) return 'Times are HH:MM, for example 09:00.';
    if (minutes(f.endTime) <= minutes(f.startTime)) return 'The end time must be after the start time.';
  }
  if (!block) {
    const length = Number(f.slotDurationMinutes);
    if (!(Number.isInteger(length) && length >= 10 && length <= 240)) return 'An appointment is 10 to 240 minutes.';
    if (minutes(f.endTime) - minutes(f.startTime) < length) return 'The time is shorter than one appointment.';
    const buffer = Number(f.bufferMinutes || '0');
    if (!(Number.isInteger(buffer) && buffer >= 0 && buffer <= 120)) return 'The break between appointments is 0 to 120 minutes.';
    if (f.appointmentType !== 'IN_PERSON' && !acceptsTelemedicine) return 'Turn on video appointments in your profile first.';
    if (f.appointmentType === 'IN_PERSON' && !f.providerLocationId) return 'Choose where you see patients in person.';
  }
  if (f.type === 'RECURRING' && f.fromDate && f.toDate && f.toDate < f.fromDate) return 'The last day is before the first day.';
  return null;
}

export function ruleBody(f: RuleForm) {
  const block = f.type === 'EXCEPTION_BLOCK';
  return {
    type: f.type,
    ...(f.type === 'RECURRING' ? { weekday: f.weekday } : {}),
    ...(block && f.wholeDay ? {} : { startTime: f.startTime, endTime: f.endTime }),
    ...(f.fromDate ? { fromDate: f.fromDate } : {}),
    ...(f.type === 'RECURRING' && f.toDate ? { toDate: f.toDate } : {}),
    ...(block ? {} : { slotDurationMinutes: Number(f.slotDurationMinutes), bufferMinutes: Number(f.bufferMinutes || '0') }),
    appointmentType: block ? ('BOTH' as const) : f.appointmentType,
    ...(!block && f.providerLocationId ? { providerLocationId: f.providerLocationId } : {}),
  };
}

/** A rule in words, e.g. "Every Monday, 09:00–12:00, 30 min, in person at Main campus". */
export function ruleLabel(r: AvailabilityRule, locations: PracticeLocation[]): string {
  const at = r.providerLocationId ? locations.find((l) => l.locationId === r.providerLocationId)?.name : null;
  const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '');
  const hours = r.startTime && r.endTime ? `${r.startTime}–${r.endTime}` : 'all day';
  if (r.type === 'EXCEPTION_BLOCK') return `Time off ${day(r.validFrom)}, ${hours}`;
  const when = r.type === 'RECURRING' ? `Every ${WEEKDAYS[r.weekday ?? 0]}` : `Extra on ${day(r.validFrom)}`;
  const span = r.type === 'RECURRING' && (r.validFrom || r.validTo) ? ` (${r.validFrom ? `from ${day(r.validFrom)}` : ''}${r.validFrom && r.validTo ? ' ' : ''}${r.validTo ? `until ${day(r.validTo)}` : ''})` : '';
  return `${when}${span}, ${hours}, ${r.slotDurationMinutes ?? 30} min, ${SLOT_TYPE_LABELS[r.appointmentType].toLowerCase()}${at ? ` at ${at}` : ''}`;
}

export function createDoctorPortalService(request: SessionRequest) {
  const range = (path: string, from?: string, to?: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    for (const [k, v] of Object.entries(extra ?? {})) if (v) params.set(k, v);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  };
  return {
    profile(): Promise<DoctorProfile> {
      return request<DoctorProfile>('/doctor/profile', { method: 'GET' });
    },
    updateProfile(form: ProfileForm): Promise<DoctorProfile> {
      return request('/doctor/profile', { method: 'PATCH', body: profileBody(form) });
    },
    /** Where the doctor can see patients: their facilities' active locations (public profiles). */
    async locations(profile: DoctorProfile): Promise<PracticeLocation[]> {
      const out: PracticeLocation[] = [];
      for (const a of profile.affiliations) {
        try {
          const p = await request<{ displayName: string; locations: Array<{ locationId: string; name: string; city: string | null }> }>(`/providers/${encodeURIComponent(a.providerId)}`, { method: 'GET' });
          for (const l of p.locations) out.push({ locationId: l.locationId, name: l.name, providerName: p.displayName, city: l.city });
        } catch {
          // A facility that is not shown to patients offers no locations.
        }
      }
      return out;
    },
    async rules(): Promise<AvailabilityRule[]> {
      return (await request<{ items: AvailabilityRule[] }>('/doctor/availability', { method: 'GET' })).items;
    },
    addRule(form: RuleForm): Promise<{ ruleId: string; slotsCreated: number; slotsRemoved: number }> {
      return request('/doctor/availability', { method: 'POST', body: ruleBody(form) });
    },
    removeRule(ruleId: string): Promise<{ removed: boolean; slotsCreated: number; slotsRemoved: number }> {
      return request(`/doctor/availability/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
    },
    async slots(from?: string, to?: string): Promise<DoctorSlot[]> {
      return (await request<{ items: DoctorSlot[] }>(range('/doctor/slots', from, to), { method: 'GET' })).items;
    },
    setBlocked(slotId: string, blocked: boolean): Promise<{ slotId: string; status: string }> {
      return request(`/doctor/slots/${encodeURIComponent(slotId)}/${blocked ? 'block' : 'unblock'}`, { method: 'POST', body: {} });
    },
    async appointments(from?: string, to?: string, status?: string): Promise<StaffAppointment[]> {
      return (await request<{ items: StaffAppointment[] }>(range('/doctor/appointments', from, to, { status: status ?? '' }), { method: 'GET' })).items;
    },
    act(appointmentId: string, action: 'check-in' | 'complete' | 'no-show' | 'cancel', reason?: string): Promise<StaffAppointment> {
      return request(`/doctor/appointments/${encodeURIComponent(appointmentId)}/${action}`, { method: 'POST', body: action === 'cancel' ? { reason: (reason ?? '').trim() } : {} });
    },
  };
}

export const doctorPortalService = createDoctorPortalService(authService.request);

/** Today's local (Addis Ababa) date, `YYYY-MM-DD`. */
export const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date());
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** "09:00" in Addis Ababa time. */
export const localTime = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
/** "Mon 30 Nov" in Addis Ababa time. */
export const localDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
