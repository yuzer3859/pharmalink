import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';

/** Work 169: the Super Admin's doctors (Module 10, Work 166). */

export type DoctorStatus = 'ACTIVE' | 'SUSPENDED';

export const DOCTOR_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const MAX_DOCTOR_FILE_BYTES = 10 * 1024 * 1024;
export const DOCTOR_DOCUMENT_KINDS = [
  { value: 'MEDICAL_LICENSE', label: 'Medical licence' },
  { value: 'DEGREE_CERTIFICATE', label: 'Medical degree' },
  { value: 'SPECIALTY_CERTIFICATE', label: 'Specialty certificate' },
  { value: 'NATIONAL_ID', label: 'National ID / Kebele ID' },
  { value: 'OTHER', label: 'Other document' },
] as const;
export type DoctorDocumentKind = (typeof DOCTOR_DOCUMENT_KINDS)[number]['value'];

export interface DoctorAffiliation {
  providerId: string;
  providerName: string;
  providerType: string;
  departmentId: string | null;
  departmentName: string | null;
  roleTitle: string | null;
  isPrimary: boolean;
}

export interface DoctorListItem {
  doctorId: string;
  userId: string;
  fullName: string;
  specialty: string | null;
  status: DoctorStatus;
  isVerified: boolean;
  licenseNumber: string | null;
  licenseExpiresAt: string | null;
  createdAt: string;
}

export interface DoctorRecord extends DoctorListItem {
  fullNameAm: string | null;
  subSpecialties: string[];
  qualifications: string[];
  yearsExperience: number | null;
  bio: string | null;
  languages: string[];
  consultationFeeInPerson: number | null;
  consultationFeeTele: number | null;
  currency: string;
  acceptsTelemedicine: boolean;
  ratingAvg: number;
  ratingCount: number;
  affiliations: DoctorAffiliation[];
  account: { email: string | null; phone: string | null; status: string } | null;
}

export interface DoctorPage {
  items: DoctorListItem[];
  total: number;
  page: number;
  size: number;
}

export interface DoctorFilters {
  q?: string;
  specialty?: string;
  status?: DoctorStatus | 'all';
  page?: number;
  size?: number;
}

export interface DoctorRegistrationForm {
  userId: string;
  fullName: string;
  fullNameAm: string;
  specialty: string;
  licenseNumber: string;
  /** `YYYY-MM-DD`, the licence's last valid day. */
  licenseExpiresOn: string;
  documents: Array<{ kind: DoctorDocumentKind; storageRef: string }>;
}

/** A facility's doctor (Work 166 `GET /provider/doctors`). */
export interface FacilityDoctor {
  doctorId: string;
  fullName: string;
  specialty: string | null;
  status: DoctorStatus;
  listed: boolean;
  departmentId: string | null;
  departmentName: string | null;
  roleTitle: string | null;
  since: string;
}

/** An appointment as a doctor or facility sees it (Work 168). */
export interface StaffAppointment {
  appointmentId: string;
  status: string;
  appointmentType: 'IN_PERSON' | 'TELEMEDICINE';
  startsAt: string;
  endsAt: string;
  fee: number | null;
  currency: string;
  reasonNote: string | null;
  cancelReason: string | null;
  doctor: { doctorId: string; fullName: string };
  patient: { userId: string; email: string | null; phone: string | null };
  location: { locationId: string; providerId: string; name: string; city: string | null } | null;
}

export function doctorQuery(filters: DoctorFilters): string {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set('q', filters.q.trim().slice(0, 100));
  if (filters.specialty?.trim()) params.set('specialty', filters.specialty.trim().slice(0, 120));
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function doctorFileProblem(file: { type: string; size: number }): string | null {
  if (!(DOCTOR_FILE_TYPES as readonly string[]).includes(file.type)) return 'Choose a PDF, JPEG or PNG file.';
  if (file.size < 1 || file.size > MAX_DOCTOR_FILE_BYTES) return 'A file must be smaller than 10 MB.';
  return null;
}

/** What is still missing, or null when the doctor can be registered. */
export function doctorRegistrationProblem(form: DoctorRegistrationForm, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!form.userId) return 'Find the person first.';
  if (form.fullName.trim().length < 3) return 'Enter the name patients will see, e.g. Dr. Selamawit Bekele.';
  if (form.specialty.trim().length < 2) return 'Enter the specialty.';
  if (!form.licenseNumber.trim()) return 'Enter the licence number.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.licenseExpiresOn)) return 'Enter the licence expiry date.';
  if (form.licenseExpiresOn < today) return 'The licence has already expired.';
  if (!form.documents.some((d) => d.kind === 'MEDICAL_LICENSE')) return 'Upload the medical licence.';
  return null;
}

/** Why the server refused an action, in words an operator can act on. */
export function doctorActionMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === 'DOCTOR_NOT_VERIFIED') return 'Not enabled: the medical licence has expired. Register a renewed licence first.';
  if (error.code === 'BUSINESS_RULE_VIOLATION' && /customer account/.test(error.message)) return 'Only an ordinary customer account can become a doctor.';
  return error.message || fallback;
}

/** "ETB 500" from santim, or "—". */
export const feeLabel = (minor: number | null, currency = 'ETB') => (minor === null ? '—' : `${currency} ${(minor / 100).toLocaleString('en', { maximumFractionDigits: 2 })}`);

export function createAdminDoctorsService(request: SessionRequest) {
  return {
    list(filters: DoctorFilters = {}): Promise<DoctorPage> {
      return request<DoctorPage>(`/admin/doctors${doctorQuery(filters)}`, { method: 'GET' });
    },
    get(doctorId: string): Promise<DoctorRecord> {
      return request<DoctorRecord>(`/admin/doctors/${encodeURIComponent(doctorId)}`, { method: 'GET' });
    },
    suspend(doctorId: string, reason: string): Promise<{ suspended: boolean }> {
      return request(`/admin/doctors/${encodeURIComponent(doctorId)}/suspend`, { method: 'POST', body: { reason: reason.trim() } });
    },
    reactivate(doctorId: string): Promise<{ reactivated: boolean }> {
      return request(`/admin/doctors/${encodeURIComponent(doctorId)}/reactivate`, { method: 'POST', body: {} });
    },
    async uploadDocument(userId: string, file: File, put: typeof fetch = (...args) => fetch(...args)): Promise<string> {
      const problem = doctorFileProblem(file);
      if (problem) throw new ApiError(400, 'VALIDATION_ERROR', problem);
      const issued = await request<{ storageRef: string; upload: { url: string; method: 'PUT' | 'GET'; headers: Record<string, string> } }>('/admin/doctor-registrations/uploads', {
        method: 'POST',
        body: { userId, contentType: file.type, bytes: file.size },
      });
      let stored: Response;
      try {
        stored = await put(issued.upload.url, { method: issued.upload.method, headers: { ...issued.upload.headers, 'Content-Type': file.type }, body: file });
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', 'The file could not be uploaded. Check the connection and try again.');
      }
      if (!stored.ok) throw new ApiError(stored.status, 'UPLOAD_FAILED', 'The file could not be uploaded. Try again.');
      return issued.storageRef;
    },
    register(form: DoctorRegistrationForm): Promise<{ userId: string; doctorId: string }> {
      return request('/admin/doctor-registrations', {
        method: 'POST',
        body: {
          userId: form.userId,
          fullName: form.fullName.trim(),
          ...(form.fullNameAm.trim() ? { fullNameAm: form.fullNameAm.trim() } : {}),
          specialty: form.specialty.trim(),
          licenseNumber: form.licenseNumber.trim(),
          licenseExpiresOn: form.licenseExpiresOn,
          documents: form.documents,
        },
      });
    },
  };
}

/** Work 169: a facility's doctors and appointments (Works 166 and 168). */
export function createFacilityDoctorsService(request: SessionRequest) {
  return {
    async list(): Promise<FacilityDoctor[]> {
      return (await request<{ items: FacilityDoctor[] }>('/provider/doctors', { method: 'GET' })).items;
    },
    add(input: { identifier: string; departmentId?: string; roleTitle?: string }): Promise<{ doctorId: string }> {
      return request('/provider/doctors', {
        method: 'POST',
        body: {
          identifier: input.identifier.trim(),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.roleTitle?.trim() ? { roleTitle: input.roleTitle.trim() } : {}),
        },
      });
    },
    remove(doctorId: string): Promise<{ removed: boolean }> {
      return request(`/provider/doctors/${encodeURIComponent(doctorId)}`, { method: 'DELETE' });
    },
    async appointments(range: { from?: string; to?: string } = {}): Promise<StaffAppointment[]> {
      const params = new URLSearchParams();
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      const query = params.toString();
      return (await request<{ items: StaffAppointment[] }>(`/provider/appointments${query ? `?${query}` : ''}`, { method: 'GET' })).items;
    },
  };
}

export const adminDoctorsService = createAdminDoctorsService(authService.request);
export const facilityDoctorsService = createFacilityDoctorsService(authService.request);

/** "Mon 30 Nov, 09:00" in Addis Ababa time. */
export function appointmentTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}
