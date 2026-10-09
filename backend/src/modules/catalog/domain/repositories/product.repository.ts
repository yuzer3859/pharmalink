import { Product } from '../entities/product.entity';
import { ProductStatus, ProductType } from '../enums';

export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');

/** Dedup key fields (module-03 §3.6 invariant 4, §6.2). `type` is always `MEDICINE` — the only
 * type this check applies to. */
export interface DedupCriteria {
  genericName: string;
  strengthValue: number | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  manufacturerId: string;
}

/** Read-model row for list/search views (module-03 §8.1) — a direct projection, not a full
 * aggregate rehydration, since Slice 1 serves search directly off `products` + joins (§5). */
export interface ProductSummaryRow {
  id: string;
  type: string;
  brandName: string | null;
  genericName: string | null;
  nameAm: string | null;
  nameEn: string | null;
  dosageForm: string | null;
  strengthValue: number | null;
  strengthUnit: string | null;
  rxClassification: string | null;
  manufacturerName: string | null;
  primaryCategoryId: string | null;
}

export interface SearchProductsCriteria {
  q?: string;
  type?: ProductType;
  categoryId?: string;
  rx?: string;
  manufacturerId?: string;
  sort?: 'relevance' | 'name_asc' | 'newest';
  page: number;
  size: number;
}

/**
 * Persistence port for the Product aggregate (module-03 §10). The domain/application depends on
 * this interface; the Prisma adapter implements it in the infrastructure layer.
 */
export interface IProductRepository {
  findById(id: string, tx?: unknown): Promise<Product | null>;
  create(product: Product, tx?: unknown): Promise<void>;
  /**
   * With `expectedStatus`, the write applies only while the stored row still has that status
   * (module-16 Work 28); otherwise it throws `productNotInExpectedStatus` and writes nothing.
   */
  save(product: Product, tx?: unknown, expectedStatus?: ProductStatus): Promise<void>;
  /** Replaces this product's category assignments wholesale (§8.2 create/update flow). */
  setCategories(productId: string, categoryIds: string[], tx?: unknown): Promise<void>;
  /** Category ids currently assigned to a product (§8.1 detail view `categories[]`). */
  categoryIdsFor(productId: string): Promise<string[]>;
  /**
   * Returns the id of an existing, non-deleted `MEDICINE` product matching `criteria`
   * (case-insensitive on `genericName`), excluding `excludeId` (for PATCH re-checks), or `null`
   * if none exists. A pre-check for a friendly `409` with the candidate id — the DB partial
   * unique index (§6.2) is still the authoritative, concurrency-safe guard.
   */
  findDuplicateCandidate(
    criteria: DedupCriteria,
    excludeId: string | undefined,
    tx?: unknown,
  ): Promise<string | null>;
  /** Public search/list (§5, §8.1) — `status = ACTIVE`, `deletedAt IS NULL` only. */
  search(criteria: SearchProductsCriteria): Promise<{ items: ProductSummaryRow[]; total: number }>;
  /** Direct assignments only, `status = ACTIVE` (§8.1, resolved §14.7: non-recursive). */
  listByCategory(
    categoryId: string,
    page: number,
    size: number,
  ): Promise<{ items: ProductSummaryRow[]; total: number }>;
  /** Count of non-deleted products referencing `categoryId`, for `CATEGORY_HAS_PRODUCTS` (§8.2). */
  countByCategoryId(categoryId: string): Promise<number>;
}
