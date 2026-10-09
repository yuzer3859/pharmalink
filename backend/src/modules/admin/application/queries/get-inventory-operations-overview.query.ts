import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_ANALYTICS_READ_PORT,
  ICatalogAnalyticsReadPort,
  ProductStatusCount,
} from '../../../catalog/application/ports/inbound/catalog-analytics-read.port';
import {
  IPharmacyAnalyticsReadPort,
  PHARMACY_ANALYTICS_READ_PORT,
  TransactingStatusCount,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-analytics-read.port';
import {
  IPharmacyStockAvailabilityReadPort,
  PHARMACY_STOCK_AVAILABILITY_READ_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-stock-availability-read.port';

/**
 * The inventory operations snapshot (module-16 Work 25). Every figure is a count the owning module
 * defines; this view selects and lays them side by side, deriving nothing.
 *
 *  - `pharmacies.total` / `byTransactingStatus` — live pharmacies (`deletedAt IS NULL`) by Module
 *    04's `TransactingStatus` (`ACTIVE`, `SUSPENDED`, `PENDING`), every value, zero-filled (Work 08).
 *  - `pharmacies.eligible` — `TransactingEligibilityPolicy`: `ACTIVE`, licence `VALID` and unexpired.
 *  - `pharmacies.eligibleWithAvailableStock` / `eligibleWithoutAvailableStock` — eligible pharmacies
 *    with / without at least one listing `findAvailability` would offer a customer (enabled, live,
 *    `sellable > 0`, on an active branch). Same snapshot as `eligible`.
 *  - `inventory.*` — live inventory listings (`deletedAt IS NULL`). `enabledItems` / `disabledItems` /
 *    `inStockItems` / `outOfStockItems` are Work 08's split, read through its port:
 *    `enabledItems = inStockItems + outOfStockItems`, by `sellable > 0` (`sellable` is Module 04's
 *    unexpired on-hand minus reserved), and `enabledItems + disabledItems` is the live listing count.
 *    There is **no low-stock figure**: no listing carries a reorder level or threshold, and this
 *    view does not invent one.
 *  - `inventory.customerPurchasableListings` / `customerUnpurchasableListings` (Work 26) — the same
 *    live listings split by whether a customer can buy from them now: Module 04's discovery rule
 *    (`findAvailability`) **and** its reservation stock rule (BRULE-15 sellable at now > 0). Counts of
 *    listing records, not quantities. Not a redefinition of `inStockItems`: that is stored
 *    `sellable > 0` on any enabled listing, wherever it is.
 *  - `inventory.totalTrackedItems` (Work 27) — the live listing count, same definition as Work 08's
 *    `listings.total`, but taken from **the same Module 04 snapshot** as the two purchasability counts,
 *    so `customerPurchasableListings + customerUnpurchasableListings = totalTrackedItems` holds even
 *    while listings are created or deleted concurrently. (Work 08's split is a separate read; with no
 *    concurrent listing writes it sums to the same total.)
 *  - `products.total` / `byStatus` — live catalogue products by Module 03's `ProductStatus`
 *    (`DRAFT`, `PENDING_REVIEW`, `ACTIVE`, `DEPRECATED`, `DELISTED`), every value, zero-filled.
 *    There is no "inactive" status; each is reported as itself.
 *
 * The four reads are separate (each is consistent with itself), as in Work 08's overview.
 */
export interface InventoryOperationsOverview {
  generatedAt: Date;
  pharmacies: {
    total: number;
    byTransactingStatus: TransactingStatusCount[];
    eligible: number;
    eligibleWithAvailableStock: number;
    eligibleWithoutAvailableStock: number;
  };
  inventory: {
    totalTrackedItems: number;
    enabledItems: number;
    disabledItems: number;
    inStockItems: number;
    outOfStockItems: number;
    customerPurchasableListings: number;
    customerUnpurchasableListings: number;
  };
  products: {
    total: number;
    byStatus: ProductStatusCount[];
  };
}

/**
 * `GET /admin/operations/inventory/overview` (module-16 Work 25), over Module 04's and Module 03's
 * read ports — Work 08's two, plus Module 04's per-provider availability count. Read-only; not
 * audited.
 */
@Injectable()
export class GetInventoryOperationsOverviewQuery {
  constructor(
    @Inject(PHARMACY_ANALYTICS_READ_PORT) private readonly providers: IPharmacyAnalyticsReadPort,
    @Inject(PHARMACY_STOCK_AVAILABILITY_READ_PORT) private readonly availability: IPharmacyStockAvailabilityReadPort,
    @Inject(CATALOG_ANALYTICS_READ_PORT) private readonly catalog: ICatalogAnalyticsReadPort,
  ) {}

  async execute(): Promise<InventoryOperationsOverview> {
    const generatedAt = new Date();
    const [providers, available, purchasability, catalog] = await Promise.all([
      this.providers.summarizeProviders(generatedAt),
      this.availability.summarizeStockAvailability(generatedAt),
      this.availability.summarizeListingPurchasability(generatedAt),
      this.catalog.summarizeCatalog(),
    ]);
    return {
      generatedAt,
      pharmacies: {
        total: providers.pharmacies.total,
        byTransactingStatus: providers.pharmacies.byTransactingStatus,
        eligible: available.eligible,
        eligibleWithAvailableStock: available.withAvailableStock,
        eligibleWithoutAvailableStock: available.withoutAvailableStock,
      },
      inventory: {
        // Work 27: from the purchasability snapshot, never Work 08's separately-read total.
        totalTrackedItems: purchasability.tracked,
        enabledItems: providers.listings.enabled,
        disabledItems: providers.listings.disabled,
        inStockItems: providers.listings.inStock,
        outOfStockItems: providers.listings.outOfStock,
        customerPurchasableListings: purchasability.purchasable,
        customerUnpurchasableListings: purchasability.unpurchasable,
      },
      products: { total: catalog.products.total, byStatus: catalog.products.byStatus },
    };
  }
}
