/**
 * Work 98: what Module 14's search projection reads from Module 03, through this port only (never
 * Module 03's tables). Only `ACTIVE`, non-deleted products are searchable; for any other the
 * port still answers, so the projection can remove the product.
 */
export const CATALOG_SEARCH_SOURCE_PORT = Symbol('CATALOG_SEARCH_SOURCE_PORT');

export interface SearchProductSource {
  productId: string;
  type: string;
  status: string;
  /** `false` for a deleted product, or one not `ACTIVE`. */
  searchable: boolean;
  nameEn: string | null;
  nameAm: string | null;
  genericName: string | null;
  brandName: string | null;
  manufacturer: string | null;
  dosageForm: string | null;
  strength: string | null;
  rxClassification: string | null;
  controlledSchedule: string;
  onlineSaleProhibited: boolean;
  categories: Array<{ categoryId: string; slug: string; nameEn: string | null; nameAm: string | null }>;
}

export interface ICatalogSearchSourcePort {
  product(productId: string): Promise<SearchProductSource | null>;
  /** Every live product id, for a full reindex. */
  productIds(): Promise<string[]>;
  /** The products in a category (for refreshing them when the category changes). */
  productsInCategory(categoryId: string): Promise<string[]>;
}
