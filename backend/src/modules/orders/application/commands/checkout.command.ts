import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  CheckRxGateInput,
  ICheckRxGatePort,
  CHECK_RX_GATE_PORT,
} from '../../../prescription-matching/application/ports/inbound/check-rx-gate.port';
import {
  IMatchingPort,
  MATCHING_PORT,
} from '../../../prescription-matching/application/ports/inbound/matching.port';
import {
  DELIVERY_PRICING_PORT,
  IDeliveryPricingPort,
} from '../../../delivery/application/ports/inbound/delivery-pricing.port';
import {
  COUPON_PORT,
  ICouponPort,
} from '../../../payment/application/ports/inbound/coupon.port';
import { OrdersErrors } from '../../domain/errors';
import { orderPaidEvent, orderPlacedEvent } from '../../domain/events';
import {
  CART_REPOSITORY,
  ICartRepository,
} from '../../domain/repositories/cart.repository';
import {
  FulfillmentSnapshot,
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepository,
} from '../../domain/repositories/fulfillment.repository';
import {
  InvoiceSnapshot,
  IOrderRepository,
  NewOrderLineData,
  ORDER_REPOSITORY,
  OrderLineSnapshot,
  OrderSnapshot,
} from '../../domain/repositories/order.repository';
import { CartPolicy } from '../../domain/services/cart-policy';
import { RxClassificationPolicy } from '../../domain/services/rx-classification-policy';
import { PriceableLine, PricingCalculator } from '../../domain/services/pricing-calculator';
import { ADDRESS_PORT, IAddressPort } from '../ports/outbound/address.port';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithOrderRetry } from '../support/order-retry';

export interface CheckoutInput {
  customerUserId: string;
  addressId: string;
  deliverySlot?: string;
  /** REQUIRED — DTO-body idempotency (§4, §13.5), not an HTTP header. */
  idempotencyKey: string;
  /**
   * Optional promotion code. At most one (ADR-021) — the shape is singular, and Module 07 refuses
   * a second `APPLIED` redemption on an order inside its own transaction regardless.
   */
  couponCode?: string;
}

export interface CheckoutResult {
  order: OrderSnapshot;
  lines: OrderLineSnapshot[];
  fulfillment: FulfillmentSnapshot;
  invoice: InvoiceSnapshot;
  /** `true` when this call returned an already-committed order from a prior/concurrent attempt
   * with the same `idempotencyKey` (§4/§13.5), rather than placing a new one. */
  replay: boolean;
}

interface ResolvedLine {
  catalogProductId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  isRx: boolean;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002');
}

/**
 * `POST /checkout` (module-06 `06-orders-spec.md` §4, COD-only Slice 1). Saga steps 1–6+8 (§4) —
 * step 7 (payment authorization) does not exist in Slice 1 (every order `isCod = true`); step 3+4
 * (matching + reservation) is a single call into Module 05's already-atomic `IMatchingPort.select()`
 * (§4's ordering rationale, ADR-014) — this command never calls `IInventoryPort.reserve()` itself.
 *
 * Order of operations:
 *  1. Idempotency replay check (§4/§13.5) — `IOrderRepository.findByIdempotencyKey()` first, so a
 *     sequential replay does no Rx-gate/matching/reservation work at all. A different customer
 *     reusing the same key is a deterministic `IDEMPOTENCY_CONFLICT`, never a silently-returned
 *     mismatched order.
 *  2. Load + validate the caller's own `ACTIVE` cart (ownership is implicit — `ICartRepository
 *     .findActiveByCustomer` is already scoped to `customerUserId`; §9.1's "cart must contain at
 *     least one item" via `CartPolicy.assertNotEmpty`).
 *  3. Resolve the delivery address (ownership-checked by `IAddressPort.getAddress` itself, §5).
 *  4. Re-price every line fresh from `ICatalogPort` (§3.11 invariant 2 — never trust the cart's
 *     cached `indicativePrice`/`requiresRx`).
 *  5. Rx gate (§4 step 2) — see the per-product-call doc comment on {@link checkRxGateBlocking}
 *     for why this calls `ICheckRxGatePort.check()` once per Rx product rather than once for the
 *     whole cart.
 *  6. Matching + reservation (§4 step 3+4) via `IMatchingPort.find()`/`.select()` — both already
 *     throw the correctly-coded, reused errors (`NO_PHARMACY_MATCH`/`MATCH_CANDIDATE_UNAVAILABLE`/
 *     `INSUFFICIENT_STOCK`) on failure; nothing is reserved yet if `find()` fails, and `select()`
 *     already releases its own partial reservations internally on failure (§4's own
 *     `SelectMatchCommand` doc comment) — no compensation is needed for either failure mode.
 *  7. `PricingCalculator.computeTotals()` (§4 step 5) — pure, in-memory.
 *  7b. `IInventoryPort.confirm()` per reservation, `HELD -> CONFIRMED` (module-04 §8's "Confirm
 *     (on payment success, called by Module 06)"). COD's payment success is step 8's
 *     `PENDING_PAYMENT -> PAID`, so this is that moment; it sits outside the transaction because
 *     it is a cross-module call with its own transaction (ADR-014), and before it because Module
 *     04's TTL sweeper only expires `HELD` holds — an unconfirmed reservation would expire out
 *     from under a paid order. Without this step `MarkReadyCommand`'s later
 *     `IInventoryPort.dispatch()` fails with `INVALID_RESERVATION_STATE`, since dispatch requires
 *     `CONFIRMED`.
 *  8. Local `Serializable` transaction (§4 steps 6+8, §11, `runWithOrderRetry`): create the
 *     `Order` (`PENDING_PAYMENT` + initial history row) + `Fulfillment` + `OrderLine`s + `Invoice`,
 *     then immediately confirm `PENDING_PAYMENT -> PAID` (COD, no gateway round-trip) in the same
 *     transaction, finalize the cart (`ICartRepository.markConverted`), audit, outbox
 *     `OrderPlaced`/`OrderPaid` (§4/§8).
 *
 * Compensation (§4's failure/compensation table): if step 7b's confirmation or step 8's
 * transaction fails for any reason *other* than an idempotency-key race (a concurrent request
 * already committed with this exact key), every reservation `IMatchingPort.select()` made for
 * *this* attempt is released via
 * `IInventoryPort.release()` (best-effort — Module 04's TTL sweeper self-heals regardless,
 * ADR-007/ADR-014) before the error is rethrown. On an idempotency-key race specifically (a
 * `P2002` unique-constraint hit on `Order.idempotencyKey`, mirrors `ReserveStockCommand`'s
 * `(listingId, idempotencyKey)` race-handling exactly), this attempt's own now-orphaned
 * reservations are released the same way, and the already-committed winning order is returned as
 * the replay result instead of an error — concurrent identical checkouts never produce two orders.
 */
@Injectable()
export class CheckoutCommand {
  constructor(
    @Inject(CART_REPOSITORY) private readonly carts: ICartRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
    @Inject(ADDRESS_PORT) private readonly addresses: IAddressPort,
    @Inject(CHECK_RX_GATE_PORT) private readonly checkRxGate: ICheckRxGatePort,
    @Inject(MATCHING_PORT) private readonly matching: IMatchingPort,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    @Inject(COUPON_PORT) private readonly coupons: ICouponPort,
    @Inject(DELIVERY_PRICING_PORT) private readonly deliveryPricing: IDeliveryPricingPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: CheckoutInput): Promise<CheckoutResult> {
    // Step 1 — idempotency replay check (§4/§13.5), before any Rx-gate/matching/reservation work.
    const existing = await this.orders.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.customerUserId !== input.customerUserId) {
        throw OrdersErrors.idempotencyConflict();
      }
      return this.loadCheckoutResult(existing, true);
    }

    // Step 2 — load + validate the cart.
    const cart = await this.carts.findActiveByCustomer(input.customerUserId);
    CartPolicy.assertNotEmpty(cart?.items ?? []);
    const cartItems = cart!.items;

    // Step 3 — resolve the delivery address (ownership-checked by the port itself).
    const address = await this.addresses.getAddress(input.addressId, input.customerUserId);
    if (!address) {
      throw OrdersErrors.notFound('Address not found.');
    }

    // Step 4 — re-price every line fresh from Catalog (§3.11 invariant 2).
    const resolvedLines: ResolvedLine[] = [];
    const diverged: Array<{
      catalogProductId: string;
      confirmedPrice: number | null;
      currentPrice: number;
    }> = [];
    for (const item of cartItems) {
      const product = await this.catalog.getProduct(item.catalogProductId);
      if (!product || product.status !== 'ACTIVE') {
        throw OrdersErrors.catalogProductUnavailable();
      }
      if (product.price !== item.indicativePrice) {
        diverged.push({
          catalogProductId: item.catalogProductId,
          confirmedPrice: item.indicativePrice,
          currentPrice: product.price,
        });
      }
      resolvedLines.push({
        catalogProductId: item.catalogProductId,
        name: product.name,
        quantity: item.quantity,
        unitPrice: product.price,
        isRx: RxClassificationPolicy.requiresPrescription(product.rxClassification),
      });
    }

    // §10 `PRICE_CHANGED` (409): "cart price diverged from the fresh Module 03 read at step 1;
    // client must re-quote". The baseline is `CartItem.indicativePrice` — the price the customer
    // last had confirmed, written at add-to-cart time and refreshed by `/cart/validate` /
    // `/checkout/quote`. Neither spec defines a quote token to pass back in (§9.2's body has no
    // such field), so the cart's own cached price *is* the contract's confirmation baseline.
    //
    // This does not weaken §3.12 invariant 2: the cache never becomes the charged price. Below,
    // `resolvedLines` still carries the fresh Catalog price and that is what the order is priced
    // at — the cache only decides whether checkout may proceed without re-confirmation, so a
    // customer is never silently charged more than the amount they were last quoted.
    //
    // Raised before matching/reservation so a rejected checkout holds no stock to compensate.
    if (diverged.length > 0) {
      throw OrdersErrors.priceChanged(diverged);
    }

    // Step 5 — Rx gate.
    const prescriptionLineIdByProduct = await this.checkRxGateBlocking(
      input.customerUserId,
      resolvedLines,
    );

    // Step 6 — matching + reservation (Module 05's already-atomic find + select, ADR-014).
    const matchLines = resolvedLines.map((line) => ({
      catalogProductId: line.catalogProductId,
      quantity: line.quantity,
    }));
    const findResult = await this.matching.find({
      customerUserId: input.customerUserId,
      lines: matchLines,
      deliveryLat: address.lat ?? undefined,
      deliveryLng: address.lng ?? undefined,
    });
    const selected = await this.matching.select({
      matchRequestId: findResult.matchRequest.id,
      customerUserId: input.customerUserId,
      lines: matchLines,
    });
    const chosenResult = selected.chosenResult;
    if (!chosenResult) {
      // Defensive — `SelectMatchCommand` always sets `chosenResult` on success (§4's own doc
      // comment); this should be unreachable, but never silently proceeds with a null result.
      throw OrdersErrors.validation('Matching returned no chosen pharmacy result.');
    }

    // Step 6b — coupon quote (ADR-020: after matching, before the order exists).
    //
    // Scored against `resolvedLines` — the lines step 4 just re-priced from Module 03 and that
    // step 8 is about to freeze into `order_lines` — at `chosenResult.pharmacyId`, the pharmacy
    // Module 05 just matched. Neither comes from the request: the client sent a code and nothing
    // else. The customer's *cart* is deliberately not what is scored; it carries no pharmacy and
    // its cached prices are not what this order will be created at.
    //
    // Nothing is redeemed here. A redemption row needs an `order_id` and there is no order yet
    // (§11.7), so this only produces the number that feeds pricing; the usage is consumed after
    // step 8 commits.
    const discountTotal = await this.quoteCoupon(input, resolvedLines, chosenResult.pharmacyId);

    // Step 6c — the delivery fee (F-FEE-01, BR-DEL-09), from Module 08 through its inbound port.
    //
    // **This is the charge, and it is computed here rather than accepted from anywhere.** The
    // client sent a cart, an address id and possibly a coupon code; there is no `deliveryFee` field
    // anywhere in `CheckoutInput`, so a quote the customer read an hour ago — or edited — has no
    // route into this number.
    //
    // It is resolved *after* matching rather than alongside the cart because before matching there
    // is no branch, and a fee quoted against a different pharmacy would be a fee for a different
    // delivery. It is resolved outside the transaction below per ADR-014: a cross-module call opens
    // its own reads, and a serialization retry must not re-issue it.
    //
    // A routing failure fails the checkout rather than producing a number. The alternative is
    // charging a fabricated fee — a zero nobody chose, or a guess — and a delivery fee is money.
    // The reservations step 6 just took are released first, because a checkout that cannot be
    // priced must not leave stock held for an order that will never exist.
    let deliveryFee: number;
    try {
      deliveryFee = (
        await this.deliveryPricing.quote({
          customerUserId: input.customerUserId,
          addressId: input.addressId,
          branchId: chosenResult.branchId,
        })
      ).deliveryFee;
    } catch (err) {
      await this.releaseReservations(
        chosenResult.lines.map((line) => line.reservationId),
        'checkout-delivery-quote-failed',
      );
      throw err;
    }

    // Step 7 — pricing (pure, in-memory).
    const priceableLines: PriceableLine[] = resolvedLines.map((line) => ({
      unitPrice: line.unitPrice,
      quantity: line.quantity,
    }));
    const platformFeePercent = this.config.get<number>('orders.platformFeePercent') ?? 0;
    // The *existing* call, with one more already-resolved input — `PricingCalculator` declared
    // `discountTotal` optional for exactly this caller and is unchanged. It remains the sole owner
    // of what the customer is charged; Module 07 says only what the coupon is worth.
    const totals = PricingCalculator.computeTotals({
      lines: priceableLines,
      deliveryFee,
      platformFeePercent,
      discountTotal,
    });

    const reservationIds = chosenResult.lines.map((l) => l.reservationId);

    // Step 7b — confirm every reservation `HELD -> CONFIRMED` (module-04 §8: "Confirm (on payment
    // success, called by Module 06)"; `ConfirmReservationCommand`'s own doc names "Module 06's
    // payment-success handler" as the caller). For COD, payment success *is* this saga's
    // `PENDING_PAYMENT -> PAID` transition (§4 step 8 / §3.4), so this is the payment-success
    // moment — there is no later one.
    //
    // It must happen here, before the local transaction, for two reasons:
    //  - It is a cross-module call that runs its own transaction; it cannot join this module's
    //    Prisma transaction (ADR-014), and calling it inside `runWithOrderRetry`'s callback would
    //    re-issue it on every serialization retry.
    //  - Module 04's TTL sweeper only expires **`HELD`** reservations. Leaving the hold
    //    unconfirmed until the pharmacy accepts would let the 15-minute TTL
    //    (`inventory.reservationTtlMinutes`) expire it out from under a paid order; once
    //    `CONFIRMED`, the sweeper ignores it and only an explicit release/dispatch moves it.
    //
    // Failure falls into the existing compensation below — `ReleaseReservationCommand` accepts a
    // `CONFIRMED` reservation as readily as a `HELD` one, so no new compensation capability is
    // needed. Re-confirming an already-`CONFIRMED` reservation is a no-op in Module 04, so a
    // retried checkout is safe.
    try {
      for (const reservationId of reservationIds) {
        await this.inventory.confirm({ reservationId });
      }
    } catch (err) {
      await this.releaseReservations(reservationIds, 'checkout-reservation-confirm-failed');
      throw err;
    }

    // Step 8 — local Serializable transaction (create + confirm PAID + finalize cart + audit/outbox).
    try {
      const placed = await runWithOrderRetry(this.uow, async (tx) => {
        const order = await this.orders.create(
          {
            orderNumber: `ORD-${randomUUID()}`,
            customerUserId: input.customerUserId,
            beneficiarySnapshot: null,
            addressSnapshot: {
              line1: address.line1,
              city: address.city,
              lat: address.lat,
              lng: address.lng,
            },
            status: 'PENDING_PAYMENT',
            subtotal: totals.subtotal,
            deliveryFee: totals.deliveryFee,
            platformFee: totals.platformFee,
            discountTotal: totals.discountTotal,
            grandTotal: totals.grandTotal,
            currency: totals.currency,
            matchRequestId: findResult.matchRequest.id,
            deliverySlot: input.deliverySlot ?? null,
            idempotencyKey: input.idempotencyKey,
            isCod: true,
            placedAt: new Date(),
          },
          {
            fromStatus: null,
            toStatus: 'PENDING_PAYMENT',
            event: 'CHECKOUT_SUBMITTED',
            actorUserId: input.customerUserId,
            actorRole: 'CUSTOMER',
          },
          tx,
        );

        const fulfillment = await this.fulfillments.create(
          { orderId: order.id, pharmacyId: chosenResult.pharmacyId, branchId: chosenResult.branchId },
          tx,
        );

        const lineData: NewOrderLineData[] = resolvedLines.map((line) => {
          const chosenLine = chosenResult.lines.find(
            (l) => l.catalogProductId === line.catalogProductId,
          );
          return {
            catalogProductId: line.catalogProductId,
            productSnapshot: { name: line.name },
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.unitPrice * line.quantity,
            fulfillmentId: fulfillment.id,
            pharmacyId: chosenResult.pharmacyId,
            branchId: chosenResult.branchId,
            reservationId: chosenLine?.reservationId ?? null,
            prescriptionLineId: line.isRx
              ? prescriptionLineIdByProduct.get(line.catalogProductId) ?? null
              : null,
            requiresRx: line.isRx,
            lineStatus: 'RESERVED',
          };
        });
        const lines = await this.orders.createLines(order.id, lineData, tx);

        const invoiceTotals = {
          subtotal: totals.subtotal,
          deliveryFee: totals.deliveryFee,
          platformFee: totals.platformFee,
          discountTotal: totals.discountTotal,
          grandTotal: totals.grandTotal,
          currency: totals.currency,
          lines: totals.lines,
        };
        const invoice = await this.orders.createInvoice(
          order.id,
          { invoiceNumber: `INV-${randomUUID()}`, totals: invoiceTotals },
          tx,
        );

        await this.orders.updateStatus(
          order.id,
          { status: 'PAID' },
          {
            fromStatus: 'PENDING_PAYMENT',
            toStatus: 'PAID',
            event: 'COD_CONFIRMED',
            actorUserId: input.customerUserId,
            actorRole: 'CUSTOMER',
          },
          tx,
        );

        await this.carts.markConverted(cart!.id, tx);

        await this.audit.record(
          {
            actorUserId: input.customerUserId,
            action: 'ORDER_PLACED',
            resourceType: 'Order',
            resourceId: order.id,
            context: { grandTotal: totals.grandTotal, lineCount: lines.length },
          },
          tx,
        );

        await this.outbox.write(
          orderPlacedEvent({
            orderId: order.id,
            customerUserId: input.customerUserId,
            totals: { grandTotal: totals.grandTotal, currency: totals.currency },
          }),
          tx as never,
        );
        await this.outbox.write(orderPaidEvent({ orderId: order.id, paymentId: null }), tx as never);

        const finalOrder = (await this.orders.findById(order.id, tx)) as OrderSnapshot;
        return { order: finalOrder, lines, fulfillment, invoice, replay: false };
      });

      // Step 9 — redeem the coupon, now that the order it is redeemed against exists.
      //
      // This cannot join step 8's transaction: no inbound port in this codebase takes a `tx`, and
      // ADR-014 records why — a single Prisma `$transaction` cannot span two module-owned
      // unit-of-work implementations without collapsing ADR-001/ADR-002's boundary. So it runs
      // over ADR-014's accepted eventual-consistency seam, exactly like the `IInventoryPort` calls
      // above, and owns the window that opens if it fails.
      if (input.couponCode) {
        await this.redeemCoupon(input, placed, discountTotal, reservationIds);
      }

      return placed;
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.orders.findByIdempotencyKey(input.idempotencyKey);
        if (winner) {
          await this.releaseReservations(reservationIds, 'checkout-idempotency-replay');
          if (winner.customerUserId !== input.customerUserId) {
            throw OrdersErrors.idempotencyConflict();
          }
          return this.loadCheckoutResult(winner, true);
        }
      }
      await this.releaseReservations(reservationIds, 'checkout-order-creation-failed');
      throw err;
    }
  }


  /**
   * Step 6b — what the coupon is worth on *this* order, or `0` when none was supplied.
   *
   * The lines handed to Module 07 are `resolvedLines`: step 4's fresh Module 03 prices, which step
   * 8 commits verbatim into `order_lines`. The pharmacy is Module 05's chosen match. Together those
   * make all three of §7's scope dimensions — product, category, pharmacy — decidable here, which
   * is what ADR-020 means by "evaluated after matching". Categories are resolved by Module 07 from
   * its own catalog port; Module 06's `ICatalogPort` does not expose them and is not widened to,
   * because coupon scope is not Module 06's concern.
   *
   * A coupon that does not apply is a **refusal**, not a silent zero. `ICouponPort.validate`
   * answers `{ valid: false, reason }` rather than throwing, because for the preview endpoint "this
   * code does not apply" is a successful answer; here the customer explicitly asked for it, so
   * placing the order at full price without it would charge them more than they intended to pay.
   * The reason is mapped onto Module 06's existing `ApiException` vocabulary so the client sees
   * the same error envelope every other checkout failure uses.
   *
   * Raised **before** reservations are confirmed and before the order is created, so a rejected
   * coupon compensates through the saga's existing reservation-release path — the same treatment
   * `PRICE_CHANGED` and the Rx gate already get.
   */
  private async quoteCoupon(
    input: CheckoutInput,
    resolvedLines: ResolvedLine[],
    pharmacyId: string,
  ): Promise<number> {
    if (!input.couponCode) {
      return 0;
    }

    const quote = await this.coupons.validate({
      customerUserId: input.customerUserId,
      code: input.couponCode,
      checkout: {
        pharmacyId,
        lines: resolvedLines.map((line) => ({
          catalogProductId: line.catalogProductId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        })),
      },
    });

    if (!quote.valid) {
      throw OrdersErrors.couponNotApplicable(input.couponCode, quote.reason ?? 'NOT_APPLICABLE');
    }
    return quote.discountAmount;
  }

  /**
   * Step 9 — consume the coupon's usage against the order that now exists.
   *
   * Module 07 re-scores the order's **committed `order_lines`** rather than trusting a number
   * carried across the step boundary, so the discount is recomputed from the same data that
   * produced `discountTotal`. That should make the two identical; if they are not, the order has
   * been committed at a price the redemption does not agree with, and this refuses rather than
   * letting the discrepancy stand. It is a defect tripwire, not an expected branch.
   *
   * ## The failure window, and why it is closed by cancelling
   *
   * `apply` runs after step 8 committed, so between the two there is a moment where a discounted,
   * `PAID` order exists whose coupon has not been consumed — the customer paid the discounted total
   * while the code remained spendable. ADR-014 makes that window structural: the two transactions
   * cannot commit together without collapsing the module boundary, and inventing cross-module
   * transaction machinery to close it is exactly what that ADR forbids.
   *
   * So it is compensated instead, with the saga's own vocabulary. The order is cancelled
   * (`PAID -> CANCELLED`, a transition `OrderStatusPolicy` already allows and
   * `CancellationPolicy` already treats as cancellable), its reservations are released through the
   * same best-effort path every other compensation here uses, and the original coupon error is
   * rethrown. Nothing is left half-applied: no discounted order stands, and the coupon — never
   * redeemed — is still the customer's to spend on a retry.
   *
   * Cancelling rather than retrying is deliberate. `ApplyCouponCommand` already retries its own
   * serialization failures internally, so what reaches here is a coupon that genuinely cannot be
   * redeemed — most plausibly a concurrent checkout taking the last global usage, or ADR-021
   * refusing a second coupon. Quietly re-pricing the order without the discount is the one thing
   * that must not happen: the customer agreed to the discounted total, not to that one.
   *
   * The compensation is itself best-effort on its failing half. If the cancellation cannot be
   * written the coupon error is still what surfaces — it is the cause, and masking it with a
   * secondary failure would hide why the checkout failed.
   */
  private async redeemCoupon(
    input: CheckoutInput,
    placed: CheckoutResult,
    quotedDiscount: number,
    reservationIds: string[],
  ): Promise<void> {
    try {
      const redemption = await this.coupons.apply({
        code: input.couponCode as string,
        orderId: placed.order.id,
        customerUserId: input.customerUserId,
        actorUserId: input.customerUserId,
      });

      if (redemption.discountAmount !== quotedDiscount) {
        throw OrdersErrors.validation(
          'The coupon redeemed for a different amount than the order was priced at.',
          {
            orderId: placed.order.id,
            quoted: quotedDiscount,
            redeemed: redemption.discountAmount,
          },
        );
      }
    } catch (err) {
      await this.compensateFailedRedemption(input, placed, reservationIds);
      throw err;
    }
  }

  /** Undoes a placed-but-un-couponed order: cancel, release, audit. Never throws. */
  private async compensateFailedRedemption(
    input: CheckoutInput,
    placed: CheckoutResult,
    reservationIds: string[],
  ): Promise<void> {
    const reason = 'checkout-coupon-redemption-failed';
    try {
      await runWithOrderRetry(this.uow, async (tx) => {
        await this.orders.updateStatus(
          placed.order.id,
          {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: reason,
          },
          {
            fromStatus: placed.order.status,
            toStatus: 'CANCELLED',
            event: 'ORDER_CANCELLED',
            actorUserId: input.customerUserId,
            actorRole: 'SYSTEM',
            reason,
          },
          tx,
        );
        await this.audit.record(
          {
            actorUserId: input.customerUserId,
            action: 'ORDER_CANCELLED',
            resourceType: 'Order',
            resourceId: placed.order.id,
            context: { reason, couponCode: input.couponCode },
          },
          tx,
        );
      });
    } catch {
      // Swallowed on purpose: the coupon failure is the cause and must be what the caller sees.
      // A stranded `PAID` order here is visible in the audit trail and recoverable by an operator;
      // masking the real error would not be.
    }
    await this.releaseReservations(reservationIds, reason);
  }

  /**
   * Rx gate (§4 step 2, §9.2). Calls `ICheckRxGatePort.check()` **once per distinct Rx product**
   * rather than once for the whole cart. `CheckRxGateResult.usablePrescriptionLineIds` (§3.7) is
   * a flat set with no per-`catalogProductId` attribution — batching every line into one call
   * would make it impossible to know *which* line each returned prescription-line id belongs to
   * once a cart has more than one distinct Rx product. `ICheckRxGatePort.check()`'s existing
   * `items` field already accepts an arbitrary-length array (no new port method or shape is
   * introduced, §0/Step 6/Step 8's "do not invent a new cross-module API" instruction) — calling
   * it with a single-item batch per Rx product is a pure application-layer orchestration choice
   * that resolves the mapping unambiguously, since `PrescriptionGate.check()`'s per-line logic
   * (module-05 `domain/services/prescription-gate.ts`) is already independent per requested line
   * and produces an identical allow/block answer whether the lines are batched or split. OTC
   * lines never reach this method at all — the gate is not invoked when the cart has no Rx items.
   */
  private async checkRxGateBlocking(
    customerUserId: string,
    lines: ResolvedLine[],
  ): Promise<Map<string, string>> {
    const prescriptionLineIdByProduct = new Map<string, string>();
    const rxLines = lines.filter((line) => line.isRx);
    if (rxLines.length === 0) {
      return prescriptionLineIdByProduct;
    }

    const blocked: Array<{ catalogProductId: string; reason: ErrorCode }> = [];
    for (const line of rxLines) {
      const input: CheckRxGateInput = {
        customerUserId,
        items: [{ catalogProductId: line.catalogProductId, quantity: line.quantity }],
      };
      const result = await this.checkRxGate.check(input);
      if (!result.allowed) {
        blocked.push(...result.blocked);
        continue;
      }
      const [usableId] = result.usablePrescriptionLineIds;
      if (usableId) {
        prescriptionLineIdByProduct.set(line.catalogProductId, usableId);
      }
    }

    if (blocked.length > 0) {
      throw OrdersErrors.rxGateBlocked(blocked);
    }
    return prescriptionLineIdByProduct;
  }

  /** Best-effort compensation (§4's failure/compensation table) — Module 04's reservation TTL
   * sweeper self-heals any stragglers regardless (ADR-007/ADR-014), mirroring
   * `CancelOrderCommand`/`RematchCommand`'s identical `Promise.allSettled` release pattern. */
  private async releaseReservations(reservationIds: string[], reason: string): Promise<void> {
    await Promise.allSettled(
      reservationIds.map((reservationId) => this.inventory.release({ reservationId, reason })),
    );
  }

  private async loadCheckoutResult(order: OrderSnapshot, replay: boolean): Promise<CheckoutResult> {
    const [lines, fulfillments, invoice] = await Promise.all([
      this.orders.findLinesByOrderId(order.id),
      this.fulfillments.findByOrderId(order.id),
      this.orders.findInvoiceByOrderId(order.id),
    ]);
    return {
      order,
      lines,
      fulfillment: fulfillments[0],
      invoice: invoice as InvoiceSnapshot,
      replay,
    };
  }
}
