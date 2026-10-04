import { Inject, Injectable } from '@nestjs/common';
import { IConfigPort, CONFIG_PORT } from '../../../../shared/config/config.port';
import { GetAvailabilityQuery } from '../../../pharmacy-inventory/application/queries/get-availability.query';
import { OrderTotals, PricingCalculator } from '../../domain/services/pricing-calculator';
import { RxClassificationPolicy } from '../../domain/services/rx-classification-policy';
import { CART_REPOSITORY, ICartRepository } from '../../domain/repositories/cart.repository';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';

export interface ValidateCartInput {
  customerUserId: string;
}

/** One line of §9.1's `items: [{ ..., priceChanged, stillAvailable }]`. */
export interface ValidatedCartItem {
  id: string;
  catalogProductId: string;
  name: string | null;
  quantity: number;
  /** The price the customer had last confirmed for this line before this call reconciled it. */
  previousPrice: number | null;
  /** Authoritative Catalog reference price right now (`null` when the product is unavailable). */
  unitPrice: number | null;
  lineTotal: number | null;
  requiresRx: boolean;
  priceChanged: boolean;
  stillAvailable: boolean;
}

export interface ValidateCartResult {
  cartId: string | null;
  items: ValidatedCartItem[];
  totals: OrderTotals | null;
  readyForCheckout: boolean;
}

/**
 * `POST /cart/validate` (`06-orders-spec.md` §9.1 — `200 { items: [{ ..., priceChanged,
 * stillAvailable }], readyForCheckout }`; parent doc §8.1 "refresh prices/stock, flag Rx items →
 * readiness report"; §0.1's "live totals against real Module 03/04 data").
 *
 * Everything is read **fresh**: the reference price comes from `ICatalogPort.getProduct()`
 * (Catalog owns it, ADR-015) and availability from Module 04's already-exported
 * `GetAvailabilityQuery` — the cart's cached `indicativePrice`/`requiresRx` are never treated as
 * authoritative here, only as the *previous* values to compare against.
 *
 * **Reconciliation, not a silent update.** Parent doc F-CRT-06 requires "prices/stock refreshed;
 * **stale prices reconciled**", so a line whose price moved has its cached `indicativePrice`
 * rewritten to the current one — but only after this response has reported `priceChanged: true`
 * for it, so the customer is told before the baseline moves. This is also the documented escape
 * from §10's `PRICE_CHANGED`: "client must re-quote" means calling this (or `/checkout/quote`),
 * which re-confirms the current price. `/checkout` itself never reconciles — it compares.
 *
 * No other cart state is touched: quantities, lines and cart status are left exactly as they
 * were, and no order, fulfillment, reservation or matching assignment is created (this is a
 * read/validate operation, §9.1).
 *
 * `readyForCheckout` is the literal §9.1 readiness signal: a non-empty cart with every line
 * still available. Rx *readiness* is deliberately not folded in — §9.2 gives that its own
 * `rxGateResult` on `/checkout/quote`, and duplicating Module 05's gate decision here would put
 * the same judgement in two places (§9.1 asks this endpoint to "flag Rx items", which the
 * per-line `requiresRx` does).
 */
@Injectable()
export class ValidateCartCommand {
  constructor(
    @Inject(CART_REPOSITORY) private readonly carts: ICartRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly availability: GetAvailabilityQuery,
  ) {}

  async execute(input: ValidateCartInput): Promise<ValidateCartResult> {
    // Ownership is implicit and unforgeable: the cart is looked up *by* the authenticated
    // customer, never by a client-supplied cart id (§7's own-resource discipline).
    const cart = await this.carts.findActiveByCustomer(input.customerUserId);
    if (!cart || cart.items.length === 0) {
      return {
        cartId: cart?.id ?? null,
        items: [],
        totals: null,
        readyForCheckout: false,
      };
    }

    const items: ValidatedCartItem[] = [];
    for (const item of cart.items) {
      const product = await this.catalog.getProduct(item.catalogProductId);
      // An unpriced, deleted or non-`ACTIVE` product is reported unavailable rather than priced
      // at zero — the same rule `CatalogPortAdapter`/`CheckoutCommand` already apply (ADR-015).
      const usable = product !== null && product.status === 'ACTIVE';
      const unitPrice = usable ? product!.price : null;
      const requiresRx = usable
        ? RxClassificationPolicy.requiresPrescription(product!.rxClassification)
        : item.requiresRx;

      let stillAvailable = false;
      if (usable) {
        const offers = await this.availability.execute(item.catalogProductId, {});
        stillAvailable = offers.some((offer) => offer.sellable >= item.quantity);
      }

      const priceChanged = unitPrice !== null && unitPrice !== item.indicativePrice;

      items.push({
        id: item.id,
        catalogProductId: item.catalogProductId,
        name: usable ? product!.name : null,
        quantity: item.quantity,
        previousPrice: item.indicativePrice,
        unitPrice,
        lineTotal: unitPrice === null ? null : unitPrice * item.quantity,
        requiresRx,
        priceChanged,
        stillAvailable,
      });

      // Reconcile only after the change has been recorded in the response above.
      if (usable && (priceChanged || requiresRx !== item.requiresRx)) {
        await this.carts.reconcileItemPrice(item.id, unitPrice, requiresRx);
      }
    }

    const priceableLines = items
      .filter((line): line is ValidatedCartItem & { unitPrice: number } => line.unitPrice !== null)
      .map((line) => ({ unitPrice: line.unitPrice, quantity: line.quantity }));

    const totals =
      priceableLines.length === items.length
        ? PricingCalculator.computeTotals({
            lines: priceableLines,
            // Still the flat configuration key, and deliberately so. A cart has no address and
            // no pharmacy: nothing has been matched, so there is no branch to route from and no
            // destination to route to, and `IDeliveryPricingPort` could not be called here without
            // inventing both. The delivery fee becomes real at `/checkout/quote`, which is the
            // first point a candidate pharmacy exists (F-FEE-01). This total is the indicative
            // cart view, and the key resolves to `0` — the same amount a checkout quotes under the
            // shipped rate card.
            deliveryFee: this.config.get<number>('orders.deliveryFeeFlat') ?? 0,
            platformFeePercent: this.config.get<number>('orders.platformFeePercent') ?? 0,
          })
        : null;

    return {
      cartId: cart.id,
      items,
      totals,
      readyForCheckout: items.length > 0 && items.every((line) => line.stillAvailable),
    };
  }
}
