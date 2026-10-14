import { LicenseStatus, TransactingStatus } from '../../../domain/enums';

export const PHARMACY_OPERATIONS_READ_PORT = Symbol('PHARMACY_OPERATIONS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 04's domain layer. */
export { LicenseStatus, TransactingStatus } from '../../../domain/enums';

/** Every filter is a stored `pharmacies` column or one of Module 04's existing rules, evaluated at `now`. */
export interface PharmacyOperationsFilter {
  transactingStatus?: TransactingStatus;
  /** `TransactingEligibilityPolicy` passes (`true`) or not (`false`). */
  eligible?: boolean;
  /** At least one listing is customer-purchasable by Work 26's rule (`true`), or none is (`false`). */
  hasPurchasableInventory?: boolean;
  /** Inclusive lower / exclusive upper bound on `createdAt`. */
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * One live pharmacy (`deletedAt IS NULL`) as operations sees it. No name, owner, staff, contact,
 * address, coordinate, licence number or document — the stored statuses, the licence expiry that
 * eligibility turns on, and counts.
 *
 * - `eligible` — `TransactingEligibilityPolicy` at `now`: `ACTIVE`, licence `VALID`, expiry null or
 *   after `now`. Not the stored `transactingStatus` alone: an `ACTIVE` pharmacy with an expired licence
 *   is ineligible.
 * - `branches` — live branches (`deletedAt IS NULL`) and those of them `isActive` (Work 08's definitions).
 * - `listings` — listing records, never quantities or distinct products:
 *     - `total`, `enabled`, `disabled`, `inStock`, `outOfStock` — Work 08's tracked definitions: live
 *       listings; live and enabled; total − enabled; enabled with stored `sellable > 0`;
 *       enabled − inStock.
 *     - `customerPurchasable` / `customerUnpurchasable` — Work 26's: passes discovery
 *       (`availableListingWhere`) **and** BRULE-15 stock recomputed at `now`
 *       (`unexpiredSellablePositive`); the rest of `total`. So an expired batch, an inactive branch, or
 *       an ineligible pharmacy makes a listing unpurchasable even when its stored `sellable` is positive.
 */
export interface PharmacyOperationsView {
  pharmacyId: string;
  transactingStatus: TransactingStatus;
  licenseStatus: LicenseStatus;
  licenseExpiresAt: Date | null;
  eligible: boolean;
  createdAt: Date;
  updatedAt: Date;
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

export interface PharmacyOperationsPage {
  items: PharmacyOperationsView[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 04's exported, read-only contract for **administrative pharmacy investigation** (module-16
 * Work 47). Separate from Work 08's aggregate `IPharmacyAnalyticsReadPort` and Work 25/26's
 * `IPharmacyStockAvailabilityReadPort`, both unchanged. Newest first (`createdAt`, then `id`). It
 * writes nothing.
 */
export interface IPharmacyOperationsReadPort {
  listPharmacies(filter: PharmacyOperationsFilter, page: number, size: number, now?: Date): Promise<PharmacyOperationsPage>;
  /** `null` when there is no live pharmacy with this id. */
  getPharmacy(pharmacyId: string, now?: Date): Promise<PharmacyOperationsView | null>;
}
