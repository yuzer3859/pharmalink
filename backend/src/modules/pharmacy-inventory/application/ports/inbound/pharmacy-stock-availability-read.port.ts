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
 * Module 04's exported, read-only contract for the per-provider availability count, consumed
 * in-process by Module 16's operational inventory view. Separate from `IPharmacyAnalyticsReadPort`
 * (Work 08's contract, unchanged) and from `IInventoryPort`, which moves stock.
 */
export interface IPharmacyStockAvailabilityReadPort {
  summarizeStockAvailability(now?: Date): Promise<PharmacyStockAvailabilityView>;
}
