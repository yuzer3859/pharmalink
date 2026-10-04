import { OrdersErrors } from '../errors';

/**
 * Pure, intrinsic Cart invariants (module-06 `06-orders-spec.md` §3.1/§3.2, §9.1). Only the
 * rules that hold *without* querying Catalog/Inventory live here (§0/§14: "do not query Catalog
 * or Inventory from a value object" — price/stock/Rx-classification revalidation is an
 * application-layer concern, `/cart/validate`'s job, not this policy's). `CartItem`'s own
 * `@@unique([cartId, catalogProductId])` schema constraint is the actual, DB-enforced
 * concurrency-safety backstop (§11) — `assertUniqueProduct` exists to give a friendlier,
 * pre-write validation error, the same "early domain check, DB constraint is the real guarantee"
 * relationship module-05's dispense idempotency check has to its own unique constraint (§6.3 of
 * that spec).
 */
export const CartPolicy = {
  assertUniqueProduct(existingCatalogProductIds: readonly string[], catalogProductId: string): void {
    if (existingCatalogProductIds.includes(catalogProductId)) {
      throw OrdersErrors.validation('This product is already in the cart.', {
        field: 'catalogProductId',
        catalogProductId,
      });
    }
  },

  /** Checkout requires at least one item (§9.1 `/cart/validate`'s `readyForCheckout`) — no
   * minimum/maximum item-count or per-line quantity ceiling is defined anywhere in the Slice-1
   * specification, so none is invented here beyond "not empty". */
  assertNotEmpty(items: readonly unknown[]): void {
    if (items.length === 0) {
      throw OrdersErrors.validation('Cart must contain at least one item to check out.', {
        field: 'items',
      });
    }
  },
};
