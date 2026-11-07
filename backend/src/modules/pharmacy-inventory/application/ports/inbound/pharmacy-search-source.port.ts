/**
 * Work 98: what Module 14's search projection reads from Module 04, through this port only (never
 * Module 04's tables). Purchasability is Module 04's own rule (`IListingRepository.findAvailability`:
 * enabled live listing, stock to sell, active branch, transacting-eligible pharmacy).
 */
export const PHARMACY_SEARCH_SOURCE_PORT = Symbol('PHARMACY_SEARCH_SOURCE_PORT');

export interface SearchAvailabilityOffer {
  pharmacyId: string;
  pharmacyName: string;
  branchId: string;
  branchName: string;
  city: string | null;
  lat: number | null;
  lng: number | null;
  listingId: string;
  price: number;
  currency: string;
  sellable: number;
}

export interface SearchPharmacySource {
  pharmacyId: string;
  name: string;
  description: string | null;
  /** Module 04's transacting eligibility at the time of the read. */
  eligible: boolean;
  ratingAvg: number;
  branches: Array<{ branchId: string; name: string; city: string | null; lat: number | null; lng: number | null }>;
}

export interface IPharmacySearchSourcePort {
  /** Every purchasable offer of a catalogue product right now (at most `limit`). */
  offersForProduct(catalogProductId: string, limit?: number): Promise<SearchAvailabilityOffer[]>;
  /** The catalogue product a listing sells, or `null` for an unknown listing. */
  productOfListing(listingId: string): Promise<string | null>;
  /** The products a pharmacy lists (for refreshing them when its eligibility changes). */
  productsOfPharmacy(pharmacyId: string): Promise<string[]>;
  pharmacy(pharmacyId: string): Promise<SearchPharmacySource | null>;
  /** Every live pharmacy id, for a full reindex. */
  pharmacyIds(): Promise<string[]>;
}
