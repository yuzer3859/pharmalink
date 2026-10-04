export const CATALOG_PORT = Symbol('ORDERS_CATALOG_PORT');

/** Everything §5's `ICatalogPort.getProduct()` line item names: price for pricing/totals
 * (§3.11 invariant 2), `rxClassification` for the cached `CartItem.requiresRx`/Rx-gate refresh
 * (§3.2, §4 step 1), `status` to reject a deleted/non-`ACTIVE` product, `name` for
 * `productSnapshot`/receipt display (§3.10's `PriceSnapshot` shape). */
export interface CatalogProductView {
  id: string;
  status: string;
  rxClassification: string | null;
  price: number;
  name: string;
}

/**
 * Cross-module read port into Module 03 — Catalog (module-06 `06-orders-spec.md` §5, ADR-002).
 * Own copy, not a cross-module import of Module 04/05's own `ICatalogPort` copies — `CatalogModule`
 * exports nothing (§2), so every consumer builds its own adapter, exactly like Modules 04/05 did.
 * Backed by a direct, same-database `PrismaService` read of `Product` in the infrastructure layer
 * (`infrastructure/catalog/`, not built by this task) — never a Prisma relation (ADR-002).
 *
 * Used by cart mutations (fresh price/`rxClassification` at add-time, §3.2), `/cart/validate`
 * (stale-price/Rx-flag detection, §9.1), and checkout saga step 1 (§4 — cart validation reads
 * fresh from this port, never trusts a cart-level cache for `Order.grandTotal`, §3.11
 * invariant 2).
 */
export interface ICatalogPort {
  getProduct(productId: string): Promise<CatalogProductView | null>;
}
