import {
  PharmacyOperationsPage,
  PharmacyOperationsView,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-operations-read.port';

/**
 * One pharmacy — stored statuses, licence expiry, eligibility and counts. No name, owner, staff,
 * contact, address, coordinate, licence number or document.
 */
export interface PharmacyOperationsResponse {
  pharmacyId: string;
  transactingStatus: string;
  licenseStatus: string;
  licenseExpiresAt: string | null;
  eligible: boolean;
  createdAt: string;
  updatedAt: string;
  branches: { total: number; active: number };
  listings: {
    total: number;
    enabled: number;
    disabled: number;
    inStock: number;
    outOfStock: number;
    customerPurchasable: number;
    customerUnpurchasable: number;
  };
}

export interface PharmacyOperationsListResponse {
  items: PharmacyOperationsResponse[];
  total: number;
  page: number;
  size: number;
}

// Explicit allow-list, never a spread of the port object.
export function toPharmacyOperationsResponse(p: PharmacyOperationsView): PharmacyOperationsResponse {
  return {
    pharmacyId: p.pharmacyId,
    transactingStatus: p.transactingStatus,
    licenseStatus: p.licenseStatus,
    licenseExpiresAt: p.licenseExpiresAt ? p.licenseExpiresAt.toISOString() : null,
    eligible: p.eligible,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    branches: { total: p.branches.total, active: p.branches.active },
    listings: {
      total: p.listings.total,
      enabled: p.listings.enabled,
      disabled: p.listings.disabled,
      inStock: p.listings.inStock,
      outOfStock: p.listings.outOfStock,
      customerPurchasable: p.listings.customerPurchasable,
      customerUnpurchasable: p.listings.customerUnpurchasable,
    },
  };
}

export function toPharmacyOperationsListResponse(p: PharmacyOperationsPage): PharmacyOperationsListResponse {
  return { items: p.items.map(toPharmacyOperationsResponse), total: p.total, page: p.page, size: p.size };
}
