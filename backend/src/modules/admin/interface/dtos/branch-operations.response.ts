import {
  BranchOperationsPage,
  BranchOperationsView,
} from '../../../pharmacy-inventory/application/ports/inbound/branch-operations-read.port';

/** One branch — its stored flag, its pharmacy's eligibility, and listing counts. No name, address, city, coordinate or phone. */
export interface BranchOperationsResponse {
  branchId: string;
  pharmacyId: string;
  isActive: boolean;
  pharmacyEligible: boolean;
  createdAt: string;
  updatedAt: string;
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

export interface BranchOperationsListResponse {
  items: BranchOperationsResponse[];
  total: number;
  page: number;
  size: number;
}

// Explicit allow-list, never a spread of the port object.
export function toBranchOperationsResponse(b: BranchOperationsView): BranchOperationsResponse {
  return {
    branchId: b.branchId,
    pharmacyId: b.pharmacyId,
    isActive: b.isActive,
    pharmacyEligible: b.pharmacyEligible,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
    listings: {
      total: b.listings.total,
      enabled: b.listings.enabled,
      disabled: b.listings.disabled,
      inStock: b.listings.inStock,
      outOfStock: b.listings.outOfStock,
      customerPurchasable: b.listings.customerPurchasable,
      customerUnpurchasable: b.listings.customerUnpurchasable,
    },
  };
}

export function toBranchOperationsListResponse(p: BranchOperationsPage): BranchOperationsListResponse {
  return { items: p.items.map(toBranchOperationsResponse), total: p.total, page: p.page, size: p.size };
}
