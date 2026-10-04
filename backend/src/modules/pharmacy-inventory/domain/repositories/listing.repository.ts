import { InventoryListing } from '../entities/inventory-listing.entity';

export const LISTING_REPOSITORY = Symbol('LISTING_REPOSITORY');

export interface ListingFilter {
  branchId?: string;
  catalogProductId?: string;
  pharmacyId?: string;
  page: number;
  size: number;
}

export interface AvailabilityRow {
  pharmacyId: string;
  branchId: string;
  listingId: string;
  price: number;
  currency: string;
  sellable: number;
  storageRequirement: string;
  lat: number | null;
  lng: number | null;
}

export interface IListingRepository {
  findById(id: string, tx?: unknown): Promise<InventoryListing | null>;
  findByBranchAndProduct(
    branchId: string,
    catalogProductId: string,
    tx?: unknown,
  ): Promise<InventoryListing | null>;
  /** Row-level lock (`SELECT ... FOR UPDATE`) for the reserve transaction (module-04 §8). */
  lockForUpdate(id: string, tx: unknown): Promise<InventoryListing | null>;
  create(listing: InventoryListing, tx?: unknown): Promise<void>;
  updateCache(
    id: string,
    patch: { onHand?: number; reserved?: number; sellable?: number },
    tx?: unknown,
  ): Promise<void>;
  updatePriceEnable(
    id: string,
    patch: { price?: number; isEnabled?: boolean },
    tx?: unknown,
  ): Promise<void>;
  softDelete(id: string, tx?: unknown): Promise<void>;
  findMany(filter: ListingFilter, tx?: unknown): Promise<{ items: InventoryListing[]; total: number }>;
  /**
   * Availability read (module-04 §10.3) — excludes disabled/soft-deleted/zero-sellable listings
   * and ineligible pharmacies at the SQL level (§3.10, §9.4).
   */
  findAvailability(
    catalogProductId: string,
    now: Date,
    limit: number,
  ): Promise<AvailabilityRow[]>;
}
