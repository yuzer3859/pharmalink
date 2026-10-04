import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import {
  CHECK_RX_GATE_PORT,
  CheckRxGateResult,
  ICheckRxGatePort,
} from '../../../prescription-matching/application/ports/inbound/check-rx-gate.port';
import {
  IMatchingPort,
  MATCHING_PORT,
} from '../../../prescription-matching/application/ports/inbound/matching.port';
import {
  DELIVERY_PRICING_PORT,
  IDeliveryPricingPort,
} from '../../../delivery/application/ports/inbound/delivery-pricing.port';
import { CartPolicy } from '../../domain/services/cart-policy';
import { OrderTotals, PricingCalculator } from '../../domain/services/pricing-calculator';
import { RxClassificationPolicy } from '../../domain/services/rx-classification-policy';
import { OrdersErrors } from '../../domain/errors';
import { CART_REPOSITORY, ICartRepository } from '../../domain/repositories/cart.repository';
import { ADDRESS_PORT, IAddressPort } from '../ports/outbound/address.port';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';

export interface QuoteCheckoutInput {
  customerUserId: string;
  addressId: string;
  deliverySlot?: string;
}

export interface QuoteCandidate {
  pharmacyId: string;
  branchId: string;
  coverage: string;
  totalPrice: number;
  distanceMeters: number | null;
  rank: number;
}

export interface QuoteCheckoutResult {
  rxGateResult: CheckRxGateResult;
  candidates: QuoteCandidate[];
  totals: OrderTotals;
}

/**
 * `POST /checkout/quote` (`06-orders-spec.md` §9.2 — `200 { rxGateResult, candidates, totals }`,
 * "**No order created**"; parent doc §8.2 "Rx gate result + match candidates + full price
 * breakdown (no order yet)").
 *
 * Runs the read-only prefix of the checkout saga (§4 steps 1, 2, 3, 5) and deliberately stops
 * before step 4:
 *  - step 1 — validate the caller's own cart + re-price every line fresh from `ICatalogPort`;
 *  - step 2 — `ICheckRxGatePort.check()`, Module 05's gate, reused not reimplemented;
 *  - step 3 — `IMatchingPort.find()` **only**. `IMatchingPort.select()` is never called here:
 *    `SelectMatchCommand` reserves stock via Module 04 before flipping `MatchRequest.status`
 *    (§4's own ordering rationale, ADR-014), so calling it would make this quote hold inventory.
 *    `find` ranks candidates without reserving anything;
 *  - step 5 — `PricingCalculator`, the same shared calculator checkout uses.
 * Nothing else runs: no `Order`, `Fulfillment`, `Invoice`, reservation, payment, or cart
 * mutation, and the checkout saga itself is never invoked.
 *
 * **Price confirmation.** The fresh prices quoted here are written back to each line's cached
 * `indicativePrice` (parent doc F-CRT-06 "stale prices reconciled"), because those totals are
 * exactly what the customer is being asked to confirm. That cached price is the baseline
 * `CheckoutCommand` later compares against to raise §10's `PRICE_CHANGED`, so quoting *is* the
 * "client must re-quote" step that clears it. Reconciliation happens after the quote is
 * computed, never silently ahead of it.
 *
 * `customerUserId` always comes from the authenticated principal — the DTO carries no customer
 * field, and the address is ownership-checked by `IAddressPort` in the same call.
 */
@Injectable()
export class QuoteCheckoutCommand {
  constructor(
    @Inject(CART_REPOSITORY) private readonly carts: ICartRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
    @Inject(ADDRESS_PORT) private readonly addresses: IAddressPort,
    @Inject(CHECK_RX_GATE_PORT) private readonly checkRxGate: ICheckRxGatePort,
    @Inject(MATCHING_PORT) private readonly matching: IMatchingPort,
    @Inject(DELIVERY_PRICING_PORT) private readonly deliveryPricing: IDeliveryPricingPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
  ) {}

  async execute(input: QuoteCheckoutInput): Promise<QuoteCheckoutResult> {
    const cart = await this.carts.findActiveByCustomer(input.customerUserId);
    CartPolicy.assertNotEmpty(cart?.items ?? []);
    const cartItems = cart!.items;

    const address = await this.addresses.getAddress(input.addressId, input.customerUserId);
    if (!address) {
      throw OrdersErrors.notFound('Address not found.');
    }

    // Step 1 — fresh Catalog re-price (§4 step 1). An unpriced/inactive/deleted product takes the
    // same `CATALOG_PRODUCT_NOT_FOUND` branch checkout takes, so a quote can never promise a
    // price checkout would refuse.
    const priced: Array<{ catalogProductId: string; unitPrice: number; quantity: number; isRx: boolean; cartItemId: string; cachedPrice: number | null; cachedRequiresRx: boolean }> = [];
    for (const item of cartItems) {
      const product = await this.catalog.getProduct(item.catalogProductId);
      if (!product || product.status !== 'ACTIVE') {
        throw OrdersErrors.catalogProductUnavailable();
      }
      priced.push({
        catalogProductId: item.catalogProductId,
        unitPrice: product.price,
        quantity: item.quantity,
        isRx: RxClassificationPolicy.requiresPrescription(product.rxClassification),
        cartItemId: item.id,
        cachedPrice: item.indicativePrice,
        cachedRequiresRx: item.requiresRx,
      });
    }

    // Step 2 — Rx gate (§4 step 2). Unlike checkout this reports the result instead of throwing:
    // §9.2 contracts `rxGateResult` as part of a successful `200` so the client can see *why* it
    // is blocked before committing. A cart with no Rx line skips Module 05 entirely, preserving
    // the existing OTC behaviour.
    const rxLines = priced.filter((line) => line.isRx);
    const rxGateResult: CheckRxGateResult =
      rxLines.length === 0
        ? { allowed: true, blocked: [], usablePrescriptionLineIds: [] }
        : await this.checkRxGate.check({
            customerUserId: input.customerUserId,
            items: rxLines.map((line) => ({
              catalogProductId: line.catalogProductId,
              quantity: line.quantity,
            })),
          });

    // Step 3 — matching discovery only (never `select`, which would reserve stock).
    const findResult = await this.matching.find({
      customerUserId: input.customerUserId,
      lines: priced.map((line) => ({
        catalogProductId: line.catalogProductId,
        quantity: line.quantity,
      })),
      deliveryLat: address.lat ?? undefined,
      deliveryLng: address.lng ?? undefined,
    });

    // Step 4b — the delivery fee (F-FEE-01), from Module 08 through its inbound port, priced
    // against the **top-ranked** candidate.
    //
    // A quote has no chosen pharmacy — that is what `select` would decide, and this command
    // deliberately never calls it because selecting reserves stock. So it prices the delivery the
    // customer is most likely to get: rank 1, the same candidate the client will show first.
    //
    // That makes this an estimate in a second sense beyond the usual one, and the response says so
    // — a customer who picks a different pharmacy gets a different delivery fee at checkout, where
    // the fee is recomputed against the branch actually chosen. Quoting zero instead, or averaging
    // across candidates, would be less honest rather than more.
    //
    // No candidates means no pharmacy can fulfil the cart, so there is no delivery to price and no
    // branch to price it from; the totals carry a zero delivery fee and the empty `candidates`
    // array is what tells the client the real story.
    const topCandidate = findResult.candidates.find((candidate) => candidate.rank === 1) ??
      findResult.candidates[0] ?? null;
    const deliveryFee =
      topCandidate === null
        ? 0
        : (
            await this.deliveryPricing.quote({
              customerUserId: input.customerUserId,
              addressId: input.addressId,
              branchId: topCandidate.branchId,
            })
          ).deliveryFee;

    // Step 5 — totals, via the one shared calculator.
    const totals = PricingCalculator.computeTotals({
      lines: priced.map((line) => ({ unitPrice: line.unitPrice, quantity: line.quantity })),
      deliveryFee,
      platformFeePercent: this.config.get<number>('orders.platformFeePercent') ?? 0,
    });

    // Confirm the quoted prices as the cart's new baseline (F-CRT-06), after the quote is built.
    for (const line of priced) {
      if (line.unitPrice !== line.cachedPrice || line.isRx !== line.cachedRequiresRx) {
        await this.carts.reconcileItemPrice(line.cartItemId, line.unitPrice, line.isRx);
      }
    }

    return {
      rxGateResult,
      candidates: findResult.candidates.map((candidate) => ({
        pharmacyId: candidate.pharmacyId,
        branchId: candidate.branchId,
        coverage: candidate.coverage,
        totalPrice: candidate.totalPrice,
        distanceMeters: candidate.distanceMeters,
        rank: candidate.rank,
      })),
      totals,
    };
  }
}
