import type { AdminAccountPage } from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';

/** Work 156: the Super Admin's drivers. */

export const DRIVER_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const MAX_DRIVER_FILE_BYTES = 10 * 1024 * 1024;
export const DRIVER_DOCUMENT_KINDS = [
  { value: 'DRIVING_LICENSE', label: 'Driving licence' },
  { value: 'VEHICLE_REGISTRATION', label: 'Vehicle registration (libre)' },
  { value: 'NATIONAL_ID', label: 'National ID / Kebele ID' },
  { value: 'INSURANCE', label: 'Insurance' },
  { value: 'OTHER', label: 'Other document' },
] as const;
export type DriverDocumentKind = (typeof DRIVER_DOCUMENT_KINDS)[number]['value'];
export const VEHICLE_TYPES = [
  { value: 'MOTORCYCLE', label: 'Motorcycle' },
  { value: 'BICYCLE', label: 'Bicycle' },
  { value: 'CAR', label: 'Car' },
  { value: 'VAN', label: 'Van' },
  { value: 'ON_FOOT', label: 'On foot' },
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number]['value'];

/** Addis Ababa, where drivers work by default; the radius is the administrator's choice. */
export const DEFAULT_AREA_CENTRE = { lat: 9.0108, lng: 38.7613 };

export interface DriverProfile {
  driverProfileId: string;
  vehicleType: string | null;
  plateNumber: string | null;
  serviceArea: { lat: number; lng: number; radiusMeters: number } | null;
  availability: string;
  shiftStartedAt: string | null;
  lastOnlineAt: string | null;
  maxConcurrent: number | null;
  createdAt: string;
}

export interface DriverRegistrationForm {
  userId: string;
  vehicleType: VehicleType;
  plateNumber: string;
  documentsExpireOn: string;
  documents: Array<{ kind: DriverDocumentKind; storageRef: string }>;
  radiusKm: number;
}

export function driverFileProblem(file: { type: string; size: number }): string | null {
  if (!(DRIVER_FILE_TYPES as readonly string[]).includes(file.type)) return 'Choose a PDF, JPEG or PNG file.';
  if (file.size < 1 || file.size > MAX_DRIVER_FILE_BYTES) return 'A file must be smaller than 10 MB.';
  return null;
}

/** What is still missing, or null when the driver can be registered. */
export function driverRegistrationProblem(form: DriverRegistrationForm, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!form.userId) return 'Find the person first.';
  if (form.vehicleType !== 'ON_FOOT' && form.vehicleType !== 'BICYCLE' && !form.plateNumber.trim()) return 'Enter the plate number.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.documentsExpireOn)) return 'Enter when the documents expire.';
  if (form.documentsExpireOn < today) return 'The documents have already expired.';
  if (!form.documents.some((d) => d.kind === 'DRIVING_LICENSE') && form.vehicleType !== 'ON_FOOT' && form.vehicleType !== 'BICYCLE') {
    return 'Upload the driving licence.';
  }
  if (form.documents.length === 0) return 'Upload at least one document.';
  if (!(form.radiusKm >= 0.5 && form.radiusKm <= 50)) return 'The working area must be 0.5 to 50 km.';
  return null;
}

export function createAdminDriversService(request: SessionRequest) {
  return {
    /** Driver accounts, newest first; `identifier` is an exact e-mail or phone. */
    list(filters: { identifier?: string; status?: string; page?: number; size?: number } = {}): Promise<AdminAccountPage> {
      const params = new URLSearchParams({ primaryRole: 'DRIVER' });
      if (filters.identifier?.trim()) params.set('identifier', filters.identifier.trim());
      if (filters.status && filters.status !== 'all') params.set('status', filters.status);
      if (filters.page) params.set('page', String(filters.page));
      if (filters.size) params.set('size', String(filters.size));
      return request<AdminAccountPage>(`/admin/accounts?${params}`, { method: 'GET' });
    },
    profile(userId: string): Promise<DriverProfile> {
      return request<DriverProfile>(`/admin/drivers/${encodeURIComponent(userId)}/profile`, { method: 'GET' });
    },
    async uploadDocument(userId: string, file: File, put: typeof fetch = (...args) => fetch(...args)): Promise<string> {
      const problem = driverFileProblem(file);
      if (problem) throw new ApiError(400, 'VALIDATION_ERROR', problem);
      const issued = await request<{ storageRef: string; upload: { url: string; method: 'PUT' | 'GET'; headers: Record<string, string> } }>('/admin/drivers/uploads', {
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
    register(form: DriverRegistrationForm): Promise<{ userId: string; profile: DriverProfile }> {
      return request('/admin/drivers', {
        method: 'POST',
        body: {
          userId: form.userId,
          vehicleType: form.vehicleType,
          ...(form.plateNumber.trim() ? { plateNumber: form.plateNumber.trim() } : {}),
          documentsExpireOn: form.documentsExpireOn,
          documents: form.documents,
          serviceArea: { ...DEFAULT_AREA_CENTRE, radiusMeters: Math.round(form.radiusKm * 1000) },
        },
      });
    },
  };
}

export const adminDriversService = createAdminDriversService(authService.request);
