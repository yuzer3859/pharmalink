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
 *  - `inventory.*` — live inventory listings (`deletedAt IS NULL`), Work 08's split:
 *    `totalTrackedItems = enabledItems + disabledItems`; `enabledItems = inStockItems +
 *    outOfStockItems`, by `sellable > 0` (`sellable` is Module 04's unexpired on-hand minus reserved).
 *    There is **no low-stock figure**: no listing carries a reorder level or threshold, and this
 *    view does not invent one.
 *  - `products.total` / `byStatus` — live catalogue products by Module 03's `ProductStatus`
 *    (`DRAFT`, `PENDING_REVIEW`, `ACTIVE`, `DEPRECATED`, `DELISTED`), every value, zero-filled.
 *    There is no "inactive" status; each is reported as itself.
 *
 * The three reads are separate (each is consistent with itself), as in Work 08's overview.
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
    const [providers, available, catalog] = await Promise.all([
      this.providers.summarizeProviders(generatedAt),
      this.availability.summarizeStockAvailability(generatedAt),
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
        totalTrackedItems: providers.listings.total,
        enabledItems: providers.listings.enabled,
        disabledItems: providers.listings.disabled,
        inStockItems: providers.listings.inStock,
        outOfStockItems: providers.listings.outOfStock,
      },
      products: { total: catalog.products.total, byStatus: catalog.products.byStatus },
    };
  }
}
