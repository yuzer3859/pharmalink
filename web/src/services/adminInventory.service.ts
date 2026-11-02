import type { AdminListingDetail, AdminListingPage } from '@/types';
import { authService, type SessionRequest } from './auth.service';

/**
 * Filters of `GET /admin/operations/inventory/listings` (module-16, `pharmacy:read:any`). Read-only
 * stock visibility: ids, the enabled flag, stored and computed sellable stock and purchasability.
 * The API returns no product name, price, batch or reservation row.
 */
export interface AdminListingFilters {
  pharmacyId?: string;
  isEnabled?: boolean;
  hasStoredSellableStock?: boolean;
  customerPurchasable?: boolean;
  /** 1-based. */
  page?: number;
  size?: number;
}

export const ADMIN_LISTING_PAGE_SIZES = [10, 25, 50] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value can be sent as `pharmacyId` (the server accepts a UUID only). */
export const isUuidFilter = (value: string) => UUID.test(value.trim());

export function adminListingQuery(filters: AdminListingFilters): string {
  const params = new URLSearchParams();
  const pharmacyId = filters.pharmacyId?.trim();
  if (pharmacyId) params.set('pharmacyId', pharmacyId);
  for (const key of ['isEnabled', 'hasStoredSellableStock', 'customerPurchasable'] as const) {
    if (filters[key] !== undefined) params.set(key, String(filters[key]));
  }
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function createAdminInventoryService(request: SessionRequest) {
  return {
    list(filters: AdminListingFilters = {}): Promise<AdminListingPage> {
      return request<AdminListingPage>(`/admin/operations/inventory/listings${adminListingQuery(filters)}`, { method: 'GET' });
    },

    /** One listing with stock diagnostics (reserved, unexpired batches, stored vs computed). */
    get(listingId: string): Promise<AdminListingDetail> {
      return request<AdminListingDetail>(`/admin/operations/inventory/listings/${encodeURIComponent(listingId)}`, { method: 'GET' });
    },
  };
}

export const adminInventoryService = createAdminInventoryService(authService.request);
