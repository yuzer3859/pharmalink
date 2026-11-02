import type { PharmacyOperations, PharmacyOperationsPage, TransactingStatus } from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';

/**
 * Filters of `GET /admin/operations/pharmacies` (module-16 Work 47). The API exposes no pharmacy
 * name, owner, address or licence number, so there is no text search: filters are the stored
 * statuses and computed flags it reports.
 */
export interface PharmacyFilters {
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
     * the portal decides nothing itself. There is no suspend endpoint, so the portal offers none.
     */
    activate(pharmacyId: string): Promise<{ pharmacyId: string; transactingStatus: 'ACTIVE' }> {
      return request('/pharmacy/activate', { method: 'POST', body: { pharmacyId } });
    },
  };
}

export const pharmaciesService = createPharmaciesService(authService.request);
