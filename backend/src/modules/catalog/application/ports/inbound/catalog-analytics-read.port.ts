import { ProductStatus } from '../../../domain/enums';

export const CATALOG_ANALYTICS_READ_PORT = Symbol('CATALOG_ANALYTICS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 03's domain layer. */
export { ProductStatus } from '../../../domain/enums';

export interface ProductStatusCount {
  status: ProductStatus;
  count: number;
}

/**
 * The catalogue's products, counted by lifecycle status. Soft-deleted rows are excluded, as
 * every Module 03 read excludes them (`deletedAt IS NULL`); `DELISTED` and `DEPRECATED` are
 * statuses, not deletions, and are counted. `byStatus` carries every `ProductStatus` value in
 * declaration order, zero-filled, so `total` is Σ `byStatus`.
 */
export interface CatalogAnalyticsView {
  products: {
    total: number;
    byStatus: ProductStatusCount[];
  };
}

/**
 * Module 03's exported contract for **read-only catalogue analytics**, consumed in-process by
 * Module 16 (module-16 Work 08). Counts only — no product, no proposal, no name.
 */
export interface ICatalogAnalyticsReadPort {
  summarizeCatalog(): Promise<CatalogAnalyticsView>;
}
