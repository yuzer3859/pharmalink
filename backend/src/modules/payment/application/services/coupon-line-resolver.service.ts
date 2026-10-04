import { Inject, Injectable } from '@nestjs/common';
import { DiscountableLine } from '../../domain/services/coupon-validator';
import { CART_PORT, ICartPort } from '../ports/outbound/cart.port';
import {
  COUPON_CATALOG_PORT,
  ICouponCatalogPort,
} from '../ports/outbound/coupon-catalog.port';
import { IOrderPort, ORDER_PORT } from '../ports/outbound/order.port';

const PURCHASABLE_STATUS = 'ACTIVE';

/** What a resolved cart or order looks like to a coupon. */
export interface ResolvedLines {
  lines: DiscountableLine[];
  /** Σ of every line total, in scope or not — the figure a client's `cartTotal` is checked against. */
  subtotal: number;
}

/**
 * Turns "this customer's cart" or "this order" into the priced, categorized lines
 * `CouponValidator` scores — the one place that decides what a coupon is being measured against.
 *
 * ## Why the caller's own data, never the request's
 *
 * §9.5's request carries `{ code, cartTotal, items }`, and none of it is trusted here. A discount
 * computed from a client-supplied item list is a discount the client chose: send one expensive
 * item to clear a `minSpend`, a cheap one to be discounted, or simply a product that is not in the
 * cart at all. So the cart is resolved from the authenticated subject and priced from Module 03,
 * and the request's `cartTotal`/`items` become assertions the caller can have *checked* — never
 * inputs to the arithmetic.
 *
 * ## Why prices come from the catalog, not from the cart
 *
 * `CartItem.indicativePrice` is exactly what its name says, and Module 06's own checkout ignores
 * it — `06-orders-spec.md` §3.11 invariant 2 requires `Order.grandTotal` to be computed from fresh
 * Module 03 prices inside the checkout transaction. A coupon quote built on the staler number
 * would promise a discount against one subtotal and apply it against another.
 *
 * An **order**, by contrast, is priced from its own committed `order_lines`. Those are Module 06's
 * frozen figures; re-pricing them from today's catalog would discount an order against prices the
 * customer never agreed to.
 *
 * ## Pharmacy
 *
 * A cart line has no pharmacy — Module 06's `cart_items` carries none, because the pharmacy is
 * chosen by Module 05's matching during checkout and only then written to `order_lines.pharmacyId`
 * and `fulfillments`. Cart lines therefore resolve with `pharmacyId: null`, and `CouponValidator`
 * refuses a pharmacy-scoped coupon in that state rather than guessing. ADR-020 records that this
 * is a property of the *preview* path only: in checkout, Module 06 §6's saga chooses the pharmacy
 * at step 3, before coupons are scored at step 5, so `forOrder` always has one — and
 * `forCheckoutLines` carries that chosen pharmacy for the step-5 quote that happens before any
 * order exists.
 */
@Injectable()
export class CouponLineResolver {
  constructor(
    @Inject(CART_PORT) private readonly carts: ICartPort,
    @Inject(ORDER_PORT) private readonly orders: IOrderPort,
    @Inject(COUPON_CATALOG_PORT) private readonly catalog: ICouponCatalogPort,
  ) {}

  /**
   * The caller's active cart, priced from Module 03. Returns `null` when they have no active cart
   * — distinct from an empty one, because "you have no cart" and "your cart discounts nothing"
   * are different answers.
   */
  async forActiveCart(customerUserId: string): Promise<ResolvedLines | null> {
    const cart = await this.carts.getActiveCart(customerUserId);
    if (!cart) {
      return null;
    }

    const products = await this.loadProducts(cart.lines.map((line) => line.catalogProductId));
    const lines: DiscountableLine[] = [];
    for (const line of cart.lines) {
      const product = products.get(line.catalogProductId);
      // An unknown, unpriced or non-purchasable product contributes nothing to a discount. It is
      // skipped rather than defaulted to zero-priced-but-eligible: Module 06's checkout would
      // reject the same line, so it must not help clear a `minSpend` here either.
      if (!product || product.price === null || product.status !== PURCHASABLE_STATUS) {
        continue;
      }
      lines.push({
        productId: line.catalogProductId,
        categoryIds: product.categoryIds,
        pharmacyId: null,
        lineTotal: product.price * line.quantity,
      });
    }

    return { lines, subtotal: sumLineTotals(lines) };
  }

  /**
   * The checkout saga's own lines, at the pharmacy Module 05 matched (ADR-020).
   *
   * Only the **categories** are loaded here. The prices are the caller's, deliberately: Module 06
   * has already re-priced every line from Module 03 inside its own request and is about to freeze
   * exactly those figures into `order_lines`, so re-reading the catalog would score the coupon
   * against a different instant than the order is created at. Categories are not part of that
   * commitment — an order never snapshots them — so they are a catalog fact either way, read the
   * same way `forOrder` reads them.
   *
   * A product the catalog cannot resolve contributes no categories rather than being dropped. The
   * line still counts toward the subtotal, because Module 06 is going to charge for it; it simply
   * cannot match a product- or category-scoped coupon, which is the safe direction — an unknown
   * product never *widens* a discount.
   */
  async forCheckoutLines(context: {
    pharmacyId: string;
    lines: readonly { catalogProductId: string; quantity: number; unitPrice: number }[];
  }): Promise<ResolvedLines> {
    const products = await this.loadProducts(
      context.lines.map((line) => line.catalogProductId),
    );

    const lines: DiscountableLine[] = context.lines.map((line) => ({
      productId: line.catalogProductId,
      categoryIds: products.get(line.catalogProductId)?.categoryIds ?? [],
      pharmacyId: context.pharmacyId,
      lineTotal: line.unitPrice * line.quantity,
    }));

    return { lines, subtotal: sumLineTotals(lines) };
  }

  /** An order's own committed lines, with the pharmacy the checkout saga assigned. */
  async forOrder(orderId: string): Promise<ResolvedLines> {
    const orderLines = await this.orders.getOrderLines(orderId);
    const products = await this.loadProducts(
      orderLines.map((line) => line.catalogProductId),
    );

    const lines: DiscountableLine[] = orderLines.map((line) => ({
      productId: line.catalogProductId,
      // Categories are still a catalog fact — an order does not snapshot them, and a coupon
      // scoped to a category is scored against the categories the product is in.
      categoryIds: products.get(line.catalogProductId)?.categoryIds ?? [],
      pharmacyId: line.pharmacyId,
      lineTotal: line.lineTotal,
    }));

    return { lines, subtotal: sumLineTotals(lines) };
  }

  private async loadProducts(productIds: readonly string[]) {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) {
      return new Map<string, { status: string; price: number | null; categoryIds: string[] }>();
    }
    const products = await this.catalog.getProducts(unique);
    return new Map(
      products.map((product) => [
        product.id,
        { status: product.status, price: product.price, categoryIds: product.categoryIds },
      ]),
    );
  }
}

function sumLineTotals(lines: readonly DiscountableLine[]): number {
  return lines.reduce((total, line) => total + line.lineTotal, 0);
}
