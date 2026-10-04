import { LicenseStatus, TransactingStatus } from '../../../domain/enums';

export const PHARMACY_ANALYTICS_READ_PORT = Symbol('PHARMACY_ANALYTICS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 04's domain layer. */
export { LicenseStatus, TransactingStatus } from '../../../domain/enums';

export interface TransactingStatusCount {
  status: TransactingStatus;
  count: number;
}

export interface LicenseStatusCount {
  status: LicenseStatus;
  count: number;
}

/**
 * Providers, their branches and their listings, counted. Soft-deleted rows are excluded
 * throughout (`deletedAt IS NULL`), as every Module 04 read excludes them. Both status
 * breakdowns carry every enum value in declaration order, zero-filled.
 *
 * `pharmacies.eligible` is **`TransactingEligibilityPolicy`, as SQL**: `transactingStatus =
 * ACTIVE AND licenseStatus = VALID AND (licenseExpiresAt IS NULL OR licenseExpiresAt > now)` —
 * the same predicate `PrismaListingRepository.findAvailability` applies to decide which
 * providers a customer can buy from. It is evaluated at read time against the clock, so it can
 * be lower than the `ACTIVE` bucket when licences have lapsed and the expiry job has not yet
 * suspended them.
 *
 * `listings.inStock`/`outOfStock` split the *enabled* listings by `sellable > 0` — the
 * listing-level half of that same availability predicate. A disabled listing is neither; it is
 * `disabled`. So `enabled = inStock + outOfStock` and `total = enabled + disabled`.
 */
export interface PharmacyAnalyticsView {
  pharmacies: {
    total: number;
    eligible: number;
    byTransactingStatus: TransactingStatusCount[];
    byLicenseStatus: LicenseStatusCount[];
  };
  branches: {
    total: number;
    active: number;
    inactive: number;
  };
  listings: {
    total: number;
    enabled: number;
    disabled: number;
    inStock: number;
    outOfStock: number;
  };
}

/**
 * Module 04's exported contract for **read-only provider and inventory analytics**, consumed
 * in-process by Module 16 (module-16 Work 08). Counts only — no pharmacy, no branch, no listing,
 * no price, no quantity of any one row.
 *
 * Kept apart from `IInventoryPort`, which reserves and releases stock for Module 06's checkout;
 * a dashboard has no business holding a port that can move inventory.
 */
export interface IPharmacyAnalyticsReadPort {
  summarizeProviders(now?: Date): Promise<PharmacyAnalyticsView>;
}
