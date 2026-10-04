import { DeliveryQuoteInput, DeliveryQuoteView } from '../../queries/quote-delivery-fee.query';

export const DELIVERY_PRICING_PORT = Symbol('DELIVERY_PRICING_PORT');

/**
 * Re-exported verbatim from the already-tested application query, never redefined.
 *
 * A second, parallel input/output shape at the module boundary is how two modules come to disagree
 * about what a delivery fee is: the port's copy gains a field, the query's does not, and a mapper
 * in between quietly drops something. There is one shape, and this names it.
 */
export type DeliveryPricingQuoteInput = DeliveryQuoteInput;
export type DeliveryPricingQuote = DeliveryQuoteView;

/**
 * Module 08's exported inbound contract for the **customer delivery charge** (§3.5 F-FEE-01's
 * "provided to Orders pricing", BR-DEL-09), consumed in-process by Module 06 via Nest DI — never
 * over HTTP — mirroring `IMatchingPort`/`ICheckRxGatePort`/`IInventoryPort`.
 *
 * ## What this port is for
 *
 * Module 06 owns what a customer is charged *in total* and must keep owning it. What it has never
 * owned is the delivery component: `orders.deliveryFeeFlat` was a configuration key registered in
 * no namespace, resolving to `undefined` everywhere it was read — a flat fee structurally pinned at
 * zero, with no concept of distance, zone or pharmacy. This port replaces it at the two paths that
 * price a real delivery, `/checkout/quote` and `/checkout`, with a calculation from the module that
 * knows where the goods are going.
 *
 * The cart-level views keep the old key, and that is not an oversight: a cart has no address and no
 * matched pharmacy, so there is nothing to route between and no delivery to price. The fee becomes
 * real at the first moment a candidate branch exists.
 *
 * `PricingCalculator` is untouched and remains the sole author of `grandTotal`. It already declared
 * `deliveryFee` as an input "already resolved by the caller"; the only thing that changes is who
 * the caller asks.
 *
 * ## Why it takes identifiers rather than an address and a distance
 *
 * Because a port that accepted coordinates would make Module 06 the resolver of delivery pricing
 * inputs, and the whole point is that it is not. Module 06 names the customer, the address they
 * chose and the branch matching selected; Module 08 resolves what those *are* — ownership-filtered
 * — measures the distance through `IRoutingPort` and applies the rate card. The HTTP quote route
 * takes exactly the same three identifiers through exactly the same query, so a customer's quote
 * and their checkout cannot be computed from different inputs.
 *
 * `customerUserId` is explicit and mandatory, the same explicit-actor discipline
 * `IMatchingPort.find` and `ICheckRxGatePort.check` already establish: this port narrows *how* the
 * capability is reached, never *who* it may be reached on behalf of. There is no ambient
 * trusted-internal-caller bypass, so a Module 06 command must pass the order's real customer.
 *
 * ## What is deliberately absent
 *
 * **There is no `setDeliveryFee`, no `chargeDelivery` and no write of any kind.** Module 08 does
 * not modify an Order, does not touch Module 06's Prisma repositories and does not own what the
 * customer pays — it answers a question and Module 06 decides what to do with the answer. Adding a
 * write here would be the first step in the delivery module charging people, which is Module 06's
 * authority and Module 07's ledger.
 *
 * **There is no driver earning.** The customer's delivery charge and the driver's pay are two
 * different amounts funded by a decision nobody has taken (the design's Open Question 4), and a
 * port that returned both would answer it by implication.
 */
export interface IDeliveryPricingPort {
  /**
   * The delivery charge for a prospective delivery from `branchId` to `addressId`.
   *
   * Throws rather than returning a fallback when the route cannot be calculated
   * (`DEPENDENCY_UNAVAILABLE`), when the address is not the customer's, or when the branch does not
   * exist (`NOT_FOUND` for both, so neither can be probed). A caller that wants a total without a
   * delivery fee must decide that itself; this port will not quietly supply a zero it does not
   * believe in.
   */
  quote(input: DeliveryPricingQuoteInput): Promise<DeliveryPricingQuote>;
}
