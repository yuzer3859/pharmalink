export const PHARMACY_STOCK_AVAILABILITY_READ_PORT = Symbol('PHARMACY_STOCK_AVAILABILITY_READ_PORT');

/**
 * Which eligible providers can sell anything right now, counted (module-16 Work 25).
 *
 * `eligible` is `TransactingEligibilityPolicy` as SQL — `transactingStatus = ACTIVE AND licenseStatus =
 * VALID AND (licenseExpiresAt IS NULL OR licenseExpiresAt > now)`, live pharmacies only — the same
 * count `IPharmacyAnalyticsReadPort` reports.
 *
 * `withAvailableStock` is those of them with **at least one listing a customer can buy from**,
 * by exactly the listing half of `PrismaListingRepository.findAvailability`'s predicate:
 * `isEnabled AND deletedAt IS NULL AND sellable > 0` on a branch with `isActive`. So it is
 * "eligible pharmacies that `GET /availability` would return for some product". The rest,
 * `withoutAvailableStock = eligible − withAvailableStock`, are open for business with nothing to sell.
 *
 * Both counts are read in one snapshot so the subtraction is consistent. Counts only — no
 * pharmacy, branch, listing, product, price or quantity.
 */
export interface PharmacyStockAvailabilityView {
  eligible: number;
  withAvailableStock: number;
  withoutAvailableStock: number;
}

/**
 * Tracked listings split by whether a customer can buy from them right now (module-16 Work 26).
 * Listing records — not quantities, not distinct products.
 *
 *  - `tracked` — live listings (`deletedAt IS NULL`): the population `IPharmacyAnalyticsReadPort`
 *    counts as `listings.total`.
 *  - `purchasable` — those that pass **both** of Module 04's existing customer rules at `now`:
 *      1. discovery — `findAvailability`'s predicate: enabled, live, stored `sellable > 0`, active
 *         branch, live pharmacy eligible by `TransactingEligibilityPolicy`; and
 *      2. reservation — `ReserveStockCommand`'s stock check: BRULE-15 sellable recomputed at `now`
 *         (unexpired batch quantity − `reserved`) above zero. The stored `sellable` is only
 *         recomputed on a stock write, so a batch that has expired since can leave a listing
 *         offered by (1) and refused by (2); such a listing is not purchasable.
 *  - `unpurchasable` — `tracked − purchasable`: every other live listing.
 *
 * All three from one snapshot: `purchasable + unpurchasable = tracked`, always. Module 16 reports
 * `tracked` as its `totalTrackedItems` (module-16 Work 27) so the three figures it shows agree.
 */
export interface ListingPurchasabilityView {
  tracked: number;
  purchasable: number;
  unpurchasable: number;
}

/**
 * Module 04's exported, read-only contract for customer-availability counts, consumed in-process by
 * Module 16's operational inventory view. Separate from `IPharmacyAnalyticsReadPort` (Work 08's
 * contract, unchanged) and from `IInventoryPort`, which moves stock.
 */
export interface IPharmacyStockAvailabilityReadPort {
  summarizeStockAvailability(now?: Date): Promise<PharmacyStockAvailabilityView>;
  summarizeListingPurchasability(now?: Date): Promise<ListingPurchasabilityView>;
}
