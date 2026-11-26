import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';
import type { PharmacyPeople } from './pharmacies.service';

/** Work 163: the Super Admin's healthcare providers (Module 09, Work 160). */

export const PROVIDER_TYPES = [
  { value: 'HOSPITAL', label: 'Hospital' },
  { value: 'CLINIC', label: 'Clinic' },
  { value: 'DIAGNOSTIC_CENTER', label: 'Diagnostic centre' },
  { value: 'LAB', label: 'Laboratory' },
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number]['value'];
export type ProviderStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';

export const providerTypeLabel = (type: string) => PROVIDER_TYPES.find((t) => t.value === type)?.label ?? type;

export const FACILITY_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const MAX_FACILITY_FILE_BYTES = 10 * 1024 * 1024;
export const FACILITY_DOCUMENT_KINDS = [
  { value: 'FACILITY_LICENSE', label: 'Facility operating licence' },
  { value: 'BUSINESS_LICENSE', label: 'Business licence' },
  { value: 'ACCREDITATION', label: 'Accreditation certificate' },
  { value: 'TAX_REGISTRATION', label: 'Tax registration (TIN)' },
  { value: 'OTHER', label: 'Other document' },
] as const;
export type FacilityDocumentKind = (typeof FACILITY_DOCUMENT_KINDS)[number]['value'];

export const EMERGENCY_LABELS: Record<string, string> = { NONE: 'No emergency service', BUSINESS_HOURS: 'Emergency in opening hours', H24_7: '24/7 emergency' };
export const SERVICE_TYPE_LABELS: Record<string, string> = { LAB_TEST: 'Lab test', IMAGING: 'Imaging', SCREENING_PACKAGE: 'Screening package' };
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface ProviderListItem {
  providerId: string;
  organizationId: string;
  type: ProviderType;
  displayName: string;
  status: ProviderStatus;
  licenseStatus: string;
  licenseExpiresAt: string | null;
  city: string | null;
  createdAt: string;
}

export interface ProviderPage {
  items: ProviderListItem[];
  total: number;
  page: number;
  size: number;
}

export interface ProviderLocation {
  locationId: string;
  name: string;
  city: string | null;
  subcity: string | null;
  addressLine: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  region: string | null;
  woreda: string | null;
  emergencyAvailability: string;
  isPrimary: boolean;
  isActive: boolean;
  hours: Array<{ weekday: number; openTime: string | null; closeTime: string | null; isClosed: boolean }>;
  facilities: string[];
}

export interface ProviderRecord extends ProviderListItem {
  nameEn: string | null;
  nameAm: string | null;
  description: string | null;
  website: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  ratingAvg: number;
  ratingCount: number;
  locations: ProviderLocation[];
  departments: Array<{ departmentId: string; name: string; specialty: string | null; description: string | null; contactPhone: string | null; isActive: boolean }>;
  services: Array<{
    serviceId: string;
    type: string;
    name: string;
    code: string | null;
    description: string | null;
    price: number | null;
    currency: string;
    durationMinutes: number | null;
    preparationInstructions: string | null;
    locationId: string | null;
    isAvailable: boolean;
  }>;
  /** The Module 01 organisation: its licence, administrator and staff. */
  organization: PharmacyPeople | null;
}

export interface ProviderFilters {
  q?: string;
  type?: ProviderType | 'all';
  status?: ProviderStatus | 'all';
  /** 1-based. */
  page?: number;
  size?: number;
}

export interface ProviderRegistrationForm {
  adminUserId: string;
  type: ProviderType;
  legalName: string;
  displayName: string;
  licenseNumber: string;
  /** `YYYY-MM-DD`, the licence's last valid day. */
  licenseExpiresOn: string;
  documents: Array<{ kind: FacilityDocumentKind; storageRef: string }>;
  idempotencyKey: string;
}

export function providerQuery(filters: ProviderFilters): string {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set('q', filters.q.trim().slice(0, 100));
  if (filters.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function facilityFileProblem(file: { type: string; size: number }): string | null {
  if (!(FACILITY_FILE_TYPES as readonly string[]).includes(file.type)) return 'Choose a PDF, JPEG or PNG file.';
  if (file.size < 1 || file.size > MAX_FACILITY_FILE_BYTES) return 'A file must be smaller than 10 MB.';
  return null;
}

/** What is still missing from the form, or null when it can be sent. */
export function providerRegistrationProblem(form: Omit<ProviderRegistrationForm, 'idempotencyKey'>, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!form.adminUserId) return 'Find the facility’s administrator first.';
  if (form.legalName.trim().length < 2) return 'Enter the organisation’s legal name.';
  if (form.displayName.trim().length < 2) return 'Enter the name customers will see.';
  if (!form.licenseNumber.trim()) return 'Enter the licence number.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.licenseExpiresOn)) return 'Enter the licence expiry date.';
  if (form.licenseExpiresOn < today) return 'The licence has already expired.';
  if (form.documents.length === 0) return 'Upload at least one licence file.';
  return null;
}

/** Why the server refused to enable a provider, in words an operator can act on. */
export function providerActionMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  if (error.code === 'PROVIDER_NOT_ELIGIBLE') {
    if (reason === 'LICENSE_EXPIRED') return 'Not enabled: its licence has expired. Approve a renewed licence first.';
    if (reason === 'ORGANIZATION_NOT_ACTIVE') return 'Not enabled: its organisation is not active.';
    if (reason === 'LICENSE_MISSING') return 'Not enabled: it has no approved licence.';
  }
  return error.message || fallback;
}

export function createAdminProvidersService(request: SessionRequest) {
  return {
    list(filters: ProviderFilters = {}): Promise<ProviderPage> {
      return request<ProviderPage>(`/admin/providers${providerQuery(filters)}`, { method: 'GET' });
    },
    get(providerId: string): Promise<ProviderRecord> {
      return request<ProviderRecord>(`/admin/providers/${encodeURIComponent(providerId)}`, { method: 'GET' });
    },
    suspend(providerId: string, reason: string): Promise<{ suspended: boolean }> {
      return request(`/admin/providers/${encodeURIComponent(providerId)}/suspend`, { method: 'POST', body: { reason: reason.trim() } });
    },
    reactivate(providerId: string): Promise<{ reactivated: boolean }> {
      return request(`/admin/providers/${encodeURIComponent(providerId)}/reactivate`, { method: 'POST', body: {} });
    },
    /** Uploads one licence file under the facility's administrator and returns its reference. */
    async uploadLicenceFile(adminUserId: string, file: File, put: typeof fetch = (...args) => fetch(...args)): Promise<string> {
      const problem = facilityFileProblem(file);
      if (problem) throw new ApiError(400, 'VALIDATION_ERROR', problem);
      const issued = await request<{ storageRef: string; upload: { url: string; method: 'PUT' | 'GET'; headers: Record<string, string> } }>('/admin/provider-registrations/uploads', {
        method: 'POST',
        body: { adminUserId, contentType: file.type, bytes: file.size },
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
    register(form: ProviderRegistrationForm): Promise<{ organizationId: string; providerId: string; adminUserId: string }> {
      return request('/admin/provider-registrations', {
        method: 'POST',
        body: { ...form, legalName: form.legalName.trim(), displayName: form.displayName.trim(), licenseNumber: form.licenseNumber.trim() },
      });
    },
  };
}

export const adminProvidersService = createAdminProvidersService(authService.request);
