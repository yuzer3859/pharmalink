import { DeliveryQuoteView } from '../../application/queries/quote-delivery-fee.query';

/**
 * What a customer is told a delivery will cost (§9.2, F-FEE-01).
 *
 * ## An estimate, and the response says so
 *
 * `isEstimate` is `true` and is not a field that can ever be `false` on this route. That is the
 * quote/charge boundary §6 asks for, stated on the wire rather than only in a comment: **this
 * number is not a charge**. What a customer actually pays is computed again inside
 * `CheckoutCommand`'s transaction, from the branch matching selected and the address the order is
 * placed against, and frozen onto `Order.deliveryFee`. A quote read an hour earlier, or read
 * against a branch the customer did not end up ordering from, has no bearing on it.
 *
 * Nothing a client sends back is trusted either. There is no quote token, no signed amount and no
 * `deliveryFee` input anywhere in the checkout contract, so a stale or edited quote has no route
 * into the price — checkout does not read one. A rate card that changes between the two moments
 * changes the charge, exactly as a product price changing between them does.
 *
 * ## The breakdown, and why it is here
 *
 * `basis`, `zoneId`, `distanceMeters` and the two components are the working behind the number. A
 * delivery fee is a charge on somebody's medicines, and "why is it 40 birr when my neighbour pays
 * 25" deserves an answer better than a support ticket. `pricingVersion` names the rate card, so an
 * amount charged months ago can be explained by the price list that was in force rather than
 * inferred from today's configuration.
 *
 * None of it is sensitive: the branch is one the customer was already shown, the distance is
 * between two places they chose, and the rates are the ones they are being charged. Notably absent
 * is anything about the *driver* — there is no earning, no driver share and no split, because
 * those do not exist yet and because what a driver is paid is not a customer's business.
 */
export interface DeliveryQuoteResponse {
  /** Where the goods would be collected from, and who owns it. */
  branchId: string;
  pharmacyId: string;
  /** Road distance from `IRoutingPort`; `null` when a coordinate is missing and none was asked. */
  distanceMeters: number | null;
  /** The routing provider's travel-time estimate, when it produced one. */
  estimatedDurationSeconds: number | null;
  /** `ZONE`, `DISTANCE` or `BASE` — how the amount below was arrived at. */
  basis: string;
  /** The pricing band that applied, on the `ZONE` basis only. */
  zoneId: string | null;
  /** The distance-independent component, before rounding and clamping. */
  baseFee: number;
  /** The distance-dependent component, before rounding and clamping. */
  distanceFee: number;
  /** The quoted charge, in ETB minor units (ADR-005). */
  deliveryFee: number;
  currency: string;
  /** The operator's label for the rate card that produced this. */
  pricingVersion: string;
  /** Always `true`. See the type's note on why this is not, and cannot become, a charge. */
  isEstimate: true;
}

export function toDeliveryQuoteResponse(view: DeliveryQuoteView): DeliveryQuoteResponse {
  return {
    branchId: view.branchId,
    pharmacyId: view.pharmacyId,
    distanceMeters: view.distanceMeters,
    estimatedDurationSeconds: view.estimatedDurationSeconds,
    basis: view.basis,
    zoneId: view.zoneId,
    baseFee: view.baseFee,
    distanceFee: view.distanceFee,
    deliveryFee: view.deliveryFee,
    currency: view.currency,
    pricingVersion: view.pricingVersion,
    isEstimate: true,
  };
}
