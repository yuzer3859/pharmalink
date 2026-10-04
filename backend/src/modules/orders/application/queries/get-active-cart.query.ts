import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import {
  CART_REPOSITORY,
  CartSnapshot,
  ICartRepository,
} from '../../domain/repositories/cart.repository';
import { OrderTotals, PricingCalculator } from '../../domain/services/pricing-calculator';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';

export interface GetActiveCartInput {
  customerUserId: string;
}

export interface ActiveCartView extends CartSnapshot {
  /** §9.1's `200 { id, items[], totals }`. `null` when the cart is empty or any line is no longer
   * priceable — a partial total would misrepresent what the customer would pay. */
  totals: OrderTotals | null;
}

/**
 * `GET /cart` (`06-orders-spec.md` §9.1 — `200 { id, items[], totals }`). Returns the customer's
 * `ACTIVE` cart, or `null` if none has been created yet (no cart row is auto-created by a read;
 * only `AddCartItemCommand` lazily creates one, §3.1).
 *
 * `totals` are computed from **fresh** `ICatalogPort` reference prices through the one shared
 * `PricingCalculator` (§0.1's "live totals against real Module 03/04 data") — never from the
 * cart's cached `indicativePrice`, and never by a second, parallel pricing implementation.
 *
 * Strictly a read: unlike `POST /cart/validate` this neither reconciles the cached
 * `indicativePrice` nor checks Module 04 availability, and it creates nothing — no order,
 * fulfillment, reservation, payment or matching assignment. Stock/`priceChanged`/`stillAvailable`
 * and the price reconciliation that clears §10's `PRICE_CHANGED` are `/cart/validate`'s job
 * (§9.1), so the two endpoints never give two different "current price" answers *and* a plain
 * `GET` never mutates the confirmation baseline as a side effect.
 */
@Injectable()
export class GetActiveCartQuery {
  constructor(
    @Inject(CART_REPOSITORY) private readonly carts: ICartRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
  ) {}

  async execute(input: GetActiveCartInput): Promise<ActiveCartView | null> {
    const cart = await this.carts.findActiveByCustomer(input.customerUserId);
    if (!cart) {
      return null;
    }

    const lines: Array<{ unitPrice: number; quantity: number }> = [];
    for (const item of cart.items) {
      const product = await this.catalog.getProduct(item.catalogProductId);
      if (!product || product.status !== 'ACTIVE') {
        return { ...cart, totals: null };
      }
      lines.push({ unitPrice: product.price, quantity: item.quantity });
    }

    return {
      ...cart,
      totals:
        lines.length === 0
          ? null
          : PricingCalculator.computeTotals({
              lines,
              // Still the flat configuration key, and deliberately so. A cart has no address and
              // no pharmacy: nothing has been matched, so there is no branch to route from and no
              // destination to route to, and `IDeliveryPricingPort` could not be called here without
              // inventing both. The delivery fee becomes real at `/checkout/quote`, which is the
              // first point a candidate pharmacy exists (F-FEE-01). This total is the indicative
              // cart view, and the key resolves to `0` — the same amount a checkout quotes under the
              // shipped rate card.
              deliveryFee: this.config.get<number>('orders.deliveryFeeFlat') ?? 0,
              platformFeePercent: this.config.get<number>('orders.platformFeePercent') ?? 0,
            }),
    };
  }
}
