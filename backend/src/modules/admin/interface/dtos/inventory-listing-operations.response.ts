import {
  InventoryListingOperationsDetail,
  InventoryListingOperationsPage,
  InventoryListingOperationsView,
} from '../../../pharmacy-inventory/application/ports/inbound/inventory-listing-operations-read.port';

/** One listing — ids, the stored flag, stored and computed sellable stock, purchasability. No name, price, batch or reservation row. */
export interface InventoryListingOperationsResponse {
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  isEnabled: boolean;
  storedSellable: number;
  computedSellable: number;
  customerPurchasable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryListingOperationsDetailResponse extends InventoryListingOperationsResponse {
  reserved: number;
  unexpiredBatchCount: number;
  unexpiredBatchQuantity: number;
  storedMatchesComputed: boolean;
}

export interface InventoryListingOperationsListResponse {
  items: InventoryListingOperationsResponse[];
  total: number;
  page: number;
  size: number;
}

// Explicit allow-lists, never spreads of port objects.
export function toInventoryListingOperationsResponse(l: InventoryListingOperationsView): InventoryListingOperationsResponse {
  return {
    listingId: l.listingId,
    pharmacyId: l.pharmacyId,
    branchId: l.branchId,
    catalogProductId: l.catalogProductId,
    isEnabled: l.isEnabled,
    storedSellable: l.storedSellable,
    computedSellable: l.computedSellable,
    customerPurchasable: l.customerPurchasable,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

export function toInventoryListingOperationsListResponse(p: InventoryListingOperationsPage): InventoryListingOperationsListResponse {
  return { items: p.items.map(toInventoryListingOperationsResponse), total: p.total, page: p.page, size: p.size };
}

export function toInventoryListingOperationsDetailResponse(l: InventoryListingOperationsDetail): InventoryListingOperationsDetailResponse {
  return {
    ...toInventoryListingOperationsResponse(l),
    reserved: l.reserved,
    unexpiredBatchCount: l.unexpiredBatchCount,
    unexpiredBatchQuantity: l.unexpiredBatchQuantity,
    storedMatchesComputed: l.storedMatchesComputed,
  };
}
