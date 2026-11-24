import type { PharmacyOperations, PharmacyOperationsPage, TransactingStatus } from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';

/**
 * Filters of `GET /admin/operations/pharmacies` (module-16 Work 47). The API exposes no pharmacy
 * owner, address or licence number in the list; Work 153 added a search on the pharmacy's name.
 * The rest are the stored statuses and computed flags it reports.
 */
export interface PharmacyFilters {
  /** Work 153: part of the pharmacy's name. */
  q?: string;
  transactingStatus?: TransactingStatus | 'all';
  eligible?: boolean;
  hasPurchasableInventory?: boolean;
  /** 1-based. */
  page?: number;
  size?: number;
}

export const PHARMACY_PAGE_SIZES = [10, 25, 50] as const;

export function pharmacyQuery(filters: PharmacyFilters): string {
  const params = new URLSearchParams();
  if (filters.q?.trim()) params.set('q', filters.q.trim());
  if (filters.transactingStatus && filters.transactingStatus !== 'all') params.set('transactingStatus', filters.transactingStatus);
  if (filters.eligible !== undefined) params.set('eligible', String(filters.eligible));
  if (filters.hasPurchasableInventory !== undefined) params.set('hasPurchasableInventory', String(filters.hasPurchasableInventory));
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Why the server refused an activation, in words an operator can act on. */
export function activationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The pharmacy could not be activated.';
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  if (error.code === 'LICENSE_EXPIRED') return 'Not activated: the approved licence has expired.';
  if (error.code === 'PHARMACY_NOT_ELIGIBLE') {
    switch (reason) {
      case 'ORGANIZATION_NOT_ACTIVE':
        return 'Not activated: the organisation is not active. Approve its licence first.';
      case 'LICENSE_MISSING':
      case 'LICENSE_NOT_APPROVED':
        return 'Not activated: there is no approved, current licence for this pharmacy.';
      case 'ORGANIZATION_NOT_PHARMACY':
        return 'Not activated: the organisation is not a pharmacy.';
      default:
        return `Not activated: ${error.message}`;
    }
  }
  if (error.status === 403) return 'Your account is not allowed to activate pharmacies.';
  return error.message;
}

/** Work 153: the organisation behind a pharmacy — registration, licence, owner and people. */
export interface PharmacyPerson {
  userId: string;
  email: string | null;
  phone: string | null;
  status: string;
}

export interface PharmacyPeople {
  organizationId: string;
  name: string;
  type: string;
  status: string;
  licenseNumber: string | null;
  licenseExpiresAt: string | null;
  createdAt: string;
  owner: PharmacyPerson;
  members: Array<PharmacyPerson & { roles: string[]; since: string }>;
}

export const MIN_SUSPEND_REASON = 3;
export const MAX_SUSPEND_REASON = 500;
export const isValidSuspendReason = (reason: string) => {
  const n = reason.trim().length;
  return n >= MIN_SUSPEND_REASON && n <= MAX_SUSPEND_REASON;
};

/** How a person is reached, for the record: e-mail, else phone, else their id. */
export const personLabel = (p: PharmacyPerson) => p.email ?? p.phone ?? p.userId;

export function createPharmaciesService(request: SessionRequest) {
  return {
    /** One page of live pharmacies with their statuses, eligibility and counts (read-only). */
    list(filters: PharmacyFilters = {}): Promise<PharmacyOperationsPage> {
      return request<PharmacyOperationsPage>(`/admin/operations/pharmacies${pharmacyQuery(filters)}`, { method: 'GET' });
    },

    get(pharmacyId: string): Promise<PharmacyOperations> {
      return request<PharmacyOperations>(`/admin/operations/pharmacies/${encodeURIComponent(pharmacyId)}`, { method: 'GET' });
    },

    /**
     * `POST /pharmacy/activate` (`provider:verify:any`): the explicit operator action. The server
     * checks the approved licence and refuses with `PHARMACY_NOT_ELIGIBLE` or `LICENSE_EXPIRED`;
     * the portal decides nothing itself. It also enables a pharmacy disabled by `suspend`.
     */
    activate(pharmacyId: string): Promise<{ pharmacyId: string; transactingStatus: 'ACTIVE' }> {
      return request('/pharmacy/activate', { method: 'POST', body: { pharmacyId } });
    },

    /** Work 153: who the pharmacy is. */
    people(pharmacyId: string): Promise<PharmacyPeople> {
      return request<PharmacyPeople>(`/admin/operations/pharmacies/${encodeURIComponent(pharmacyId)}/people`, { method: 'GET' });
    },

    /** Work 153: stop the pharmacy trading; `activate` enables it again after re-checking its licence. */
    suspend(pharmacyId: string, reason: string): Promise<{ pharmacyId: string; transactingStatus: 'SUSPENDED'; changed: boolean }> {
      return request('/pharmacy/suspend', { method: 'POST', body: { pharmacyId, reason: reason.trim() } });
    },
  };
}

export const pharmaciesService = createPharmaciesService(authService.request);

// ---- Work 154: the Super Admin registers a pharmacy for an owner -----------------------------------

export const LICENCE_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const MAX_LICENCE_FILE_BYTES = 10 * 1024 * 1024;
export const LICENCE_KINDS = [
  { value: 'PHARMACY_LICENSE', label: 'Pharmacy licence' },
  { value: 'PHARMACIST_LICENSE', label: 'Pharmacist licence' },
  { value: 'BUSINESS_LICENSE', label: 'Business licence' },
  { value: 'TAX_REGISTRATION', label: 'Tax registration (TIN)' },
  { value: 'OTHER', label: 'Other document' },
] as const;
export type LicenceKind = (typeof LICENCE_KINDS)[number]['value'];

/** Why a file can't be a licence file, or null when it can. */
export function licenceFileProblem(file: { type: string; size: number }): string | null {
  if (!(LICENCE_FILE_TYPES as readonly string[]).includes(file.type)) return 'Choose a PDF, JPEG or PNG file.';
  if (file.size < 1 || file.size > MAX_LICENCE_FILE_BYTES) return 'A file must be smaller than 10 MB.';
  return null;
}

export interface PharmacyRegistrationForm {
  ownerUserId: string;
  legalName: string;
  displayName: string;
  licenseNumber: string;
  /** `YYYY-MM-DD`, the licence's last valid day. */
  licenseExpiresOn: string;
  documents: Array<{ kind: LicenceKind; storageRef: string }>;
  idempotencyKey: string;
}

/** What is still missing from the form, or null when it can be sent. */
export function registrationProblem(form: Omit<PharmacyRegistrationForm, 'idempotencyKey'>, today = new Date().toISOString().slice(0, 10)): string | null {
  if (!form.ownerUserId) return 'Find the owner first.';
  if (form.legalName.trim().length < 2) return 'Enter the organisation’s legal name.';
  if (form.displayName.trim().length < 2) return 'Enter the name customers will see.';
  if (!form.licenseNumber.trim()) return 'Enter the licence number.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.licenseExpiresOn)) return 'Enter the licence expiry date.';
  if (form.licenseExpiresOn < today) return 'The licence has already expired.';
  if (form.documents.length === 0) return 'Upload at least one licence file.';
  return null;
}

export function createPharmacyRegistrationService(request: SessionRequest) {
  return {
    /** Uploads one licence file under the owner and returns its reference. */
    async uploadLicenceFile(ownerUserId: string, file: File, put: typeof fetch = (...args) => fetch(...args)): Promise<string> {
      const problem = licenceFileProblem(file);
      if (problem) throw new ApiError(400, 'VALIDATION_ERROR', problem);
      const issued = await request<{ storageRef: string; upload: { url: string; method: 'PUT' | 'GET'; headers: Record<string, string> } }>(
        '/admin/pharmacy-registrations/uploads',
        { method: 'POST', body: { ownerUserId, contentType: file.type, bytes: file.size } },
      );
      let stored: Response;
      try {
        stored = await put(issued.upload.url, { method: issued.upload.method, headers: { ...issued.upload.headers, 'Content-Type': file.type }, body: file });
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', 'The file could not be uploaded. Check the connection and try again.');
      }
      if (!stored.ok) throw new ApiError(stored.status, 'UPLOAD_FAILED', 'The file could not be uploaded. Try again.');
      return issued.storageRef;
    },
    register(form: PharmacyRegistrationForm): Promise<{ organizationId: string; pharmacyId: string; ownerUserId: string }> {
      return request('/admin/pharmacy-registrations', {
        method: 'POST',
        body: { ...form, legalName: form.legalName.trim(), displayName: form.displayName.trim(), licenseNumber: form.licenseNumber.trim() },
      });
    },
  };
}

export const pharmacyRegistrationService = createPharmacyRegistrationService(authService.request);
