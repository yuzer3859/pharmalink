export const COUPON_CATALOG_PORT = Symbol('PAYMENT_COUPON_CATALOG_PORT');

/**
 * Exactly what a coupon needs to know about a product: what it costs, whether it is purchasable,
 * and which categories it belongs to.
 */
export interface CouponProductView {
  id: string;
  status: string;
  /**
   * The platform reference price in ETB minor units. `null` means "not priced, therefore not
   * purchasable" — the same meaning Module 06's own `ICatalogPort` gives it.
   */
  price: number | null;
  /** From Module 03's `product_categories` join. Empty when the product is uncategorized. */
  categoryIds: string[];
}

/**
 * Cross-module read port into Module 03 — Catalog (ADR-002). Own copy, not an import of Module
 * 04/05/06's own `ICatalogPort` copies: `CatalogModule` exports nothing, so every consumer builds
 * its own adapter.
 *
 * Added by the coupon task, and narrower than Module 06's copy by design. It carries `categoryIds`
 * — which Module 06's does not, because order pricing has no use for them — because §7's coupon
 * scope has a **category** dimension, and the only sound way to decide whether a line is in a
 * category is to ask the catalog what categories the product actually has. Accepting a category
 * claim from the request would let a client widen a coupon's scope to anything it liked.
 *
 * It omits `rxClassification` and `name`, which a discount calculation has no business reading.
 *
 * Batched on purpose: a cart has many lines and a coupon evaluation needs all of them, so the
 * alternative is one query per line inside a money path.
 */
export interface ICouponCatalogPort {
  /**
   * Prices and categorizes several products at once. Products that do not exist are simply absent
   * from the result — the caller decides what an unknown product means, which for a coupon is
   * "not discountable", never "free".
   */
  getProducts(productIds: readonly string[]): Promise<CouponProductView[]>;
}
