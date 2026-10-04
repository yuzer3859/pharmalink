export const CART_PORT = Symbol('PAYMENT_CART_PORT');

/** One line of the caller's active cart, as Module 06 stores it. */
export interface CartLineView {
  catalogProductId: string;
  quantity: number;
}

export interface ActiveCartView {
  id: string;
  customerUserId: string;
  lines: CartLineView[];
}

/**
 * Cross-module read port into Module 06's `carts`/`cart_items` (ADR-002). Own copy, not a
 * cross-module import — `OrdersModule` exports nothing, so every consumer builds its own, exactly
 * as this module's `IOrderPort` already does.
 *
 * Added by the coupon task because §9.5's `POST /coupons/validate` cannot be answered honestly
 * without it. The request carries `{ code, cartTotal, items }`, but a discount computed from a
 * client-supplied cart is a discount the client chose: a caller could send one expensive item to
 * clear a `minSpend` and a different cheap one to be discounted. The coupon is therefore evaluated
 * against **the caller's real active cart**, resolved here from their access token's subject.
 *
 * **Deliberately no `quantity`-priced fields.** `CartItem.indicativePrice` exists but is exactly
 * what its name says — Module 06's own checkout recomputes from fresh Module 03 prices rather than
 * trusting it (`06-orders-spec.md` §3.11 invariant 2), and a coupon quote must not be built on a
 * staler number than the order it will be applied to. Pricing comes from `ICouponCatalogPort`.
 *
 * Read-only, and structurally so: it exposes no write method, because Module 07 never mutates a
 * cart.
 */
export interface ICartPort {
  /** The customer's `ACTIVE` cart, or `null` when they have none. */
  getActiveCart(customerUserId: string): Promise<ActiveCartView | null>;
}
