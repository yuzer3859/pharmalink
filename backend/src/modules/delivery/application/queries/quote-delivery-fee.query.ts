import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { DeliveryErrors } from '../../domain/errors';
import {
  DeliveryFeeBasis,
  DeliveryFeePolicy,
} from '../../domain/services/delivery-fee-policy';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';
import { IDeliveryPricingPort } from '../ports/inbound/delivery-pricing.port';
import { ADDRESS_PORT, IAddressPort } from '../ports/outbound/address.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { IRoutingPort, ROUTING_PORT } from '../ports/outbound/routing.port';
import { resolveDeliveryFeeSettings } from '../services/delivery-fee-settings';

/**
 * What a quote is asked for.
 *
 * Three identifiers and nothing else — no distance, no coordinates, no amount. Every input that
 * could change the price is resolved by this query from the module that owns it, which is what
 * makes §2's "do not trust a client-supplied distance" and §4's "do not let the endpoint accept an
 * arbitrary price and treat it as authoritative" structural rather than aspirational: there is no
 * field here through which either could arrive.
 */
export interface DeliveryQuoteInput {
  /** The authenticated subject. Never a value a request body or query string supplied. */
  customerUserId: string;
  /** A Module 02 address id belonging to that subject — ownership is enforced by the port. */
  addressId: string;
  /** The Module 04 branch the goods would be collected from. */
  branchId: string;
}

/** The priced answer: the charge, the distance behind it, and the working. */
export interface DeliveryQuoteView {
  branchId: string;
  pharmacyId: string;
  /** Always present: a fee is never reported without the distance it was computed from. */
  distanceMeters: number | null;
  /** The routing provider's travel-time estimate, when it produced one. */
  estimatedDurationSeconds: number | null;
  basis: DeliveryFeeBasis;
  zoneId: string | null;
  baseFee: number;
  distanceFee: number;
  /** The delivery charge, in ETB minor units (ADR-005). */
  deliveryFee: number;
  currency: string;
  pricingVersion: string;
}

/**
 * `GET /delivery/quote` (§9.2, §3.5 F-FEE-01, BR-DEL-09) — **the** delivery-fee calculation on this
 * platform.
 *
 * ## One path, four callers
 *
 * The HTTP quote route, Module 06's `/checkout/quote`, Module 06's `/checkout`, and — indirectly,
 * through the amount Module 06 froze — the delivery job's fee snapshot all resolve their price
 * here. That is the same discipline `GetJobTrackingQuery` applies to tracking and for the same
 * reason: two pricing paths that start identical are two pricing paths that drift, and the way a
 * customer discovers the drift is being charged more than they were quoted.
 *
 * ## The quote route is authoritative because it resolves its own inputs
 *
 * A caller names an address and a branch. This query then asks Module 02 what that address is
 * (ownership-filtered in the query, so it can only ever be the caller's own), asks Module 04 where
 * that branch is, and asks `IRoutingPort` how far apart they are. The client contributes two
 * identifiers; everything that moves the price comes from the module that owns it.
 *
 * A client that sends its own `distanceMeters` or its own `deliveryFee` is not overridden — there
 * is nowhere for those values to go. `DeliveryQuoteInput` has no such field, and the controller's
 * DTO rejects unknown properties outright.
 *
 * ## Distance comes from the routing abstraction, and only from there
 *
 * `IRoutingPort` — Work 07's — is the single source of road distance. There is deliberately no
 * second haversine here: `dispatch-policy.ts` keeps one for *ranking* candidates against each
 * other, where a provider round-trip per candidate would sit on the dispatch path and where the
 * absolute number never leaves the module. A price is a claim about the real world made to a
 * customer, so it comes from the thing that models the real world.
 *
 * ## Two different failures, told apart
 *
 *  - **The provider was asked and could not answer** — `DEPENDENCY_UNAVAILABLE` (§10). No fee, no
 *    fabricated distance, no delivery job, no order touched, no money moved. This query does not
 *    write anything under any circumstances, so all four of those are guaranteed by construction
 *    rather than by care.
 *  - **There was nothing to ask about** — the address or the branch has no coordinates, which
 *    Module 02 and Module 04 both permit. The routing provider is never called, `distanceMeters`
 *    is reported as `null`, and `DeliveryFeePolicy` charges only the distance-independent
 *    component on its `BASE` basis. Nothing is invented: the answer says outright that the
 *    distance is unknown.
 *
 * ## No cache
 *
 * §11 allows one and this work does not take it, which is a decision rather than an omission. The
 * only step here that could be expensive is the routing call, and when a real provider replaces
 * `HaversineRoutingAdapter` the right place to cache a route is *behind* `ROUTING_PORT`, keyed by
 * coordinates — vendor-agnostic, reusable by the ETA path that already caches exactly that, and
 * incapable of outliving a rate-card change. Caching a *priced* quote instead would key a money
 * answer on a customer's address id, put a TTL in front of a configuration change, and create the
 * one thing §11 warns about: a cached result whose inputs included an authorization decision.
 */
@Injectable()
export class QuoteDeliveryFeeQuery implements IDeliveryPricingPort {
  constructor(
    @Inject(ADDRESS_PORT) private readonly addresses: IAddressPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    @Inject(ROUTING_PORT) private readonly routing: IRoutingPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
  ) {}

  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuoteView> {
    const customerUserId = requireText(input.customerUserId, 'customerUserId');
    const addressId = requireText(input.addressId, 'addressId');
    const branchId = requireText(input.branchId, 'branchId');

    // Ownership is applied inside the query, so a mismatch is reported as a miss. Resolved before
    // the branch so that probing branch ids tells an unauthorized caller nothing either.
    const address = await this.addresses.getAddress(addressId, customerUserId);
    if (!address) {
      throw DeliveryErrors.notFound('Address not found.', { addressId });
    }

    const branch = await this.pharmacies.getBranchPickup(branchId);
    if (!branch) {
      throw DeliveryErrors.notFound('Pharmacy branch not found.', { branchId });
    }

    const dropoff = GeoPoint.optional(address.lat, address.lng);
    const pickup = GeoPoint.optional(branch.lat, branch.lng);

    const route =
      pickup === null || dropoff === null
        ? null
        : await this.route(pickup, dropoff, branchId, addressId);

    const quote = DeliveryFeePolicy.quote(
      route?.distanceMeters ?? null,
      resolveDeliveryFeeSettings(this.config),
    );

    return {
      branchId: branch.branchId,
      pharmacyId: branch.pharmacyId,
      distanceMeters: quote.distanceMeters,
      estimatedDurationSeconds: route?.durationSeconds ?? null,
      basis: quote.basis,
      zoneId: quote.zoneId,
      baseFee: quote.baseFee,
      distanceFee: quote.distanceFee,
      deliveryFee: quote.fee.amountMinor,
      currency: quote.fee.currency,
      pricingVersion: quote.pricingVersion,
    };
  }

  /**
   * The one routing call, with the port's two failure shapes collapsed into one refusal.
   *
   * `IRoutingPort.route` contracts `null` for "no route this time" and states that an
   * implementation which throws instead is a broken one — but the eventual implementation is
   * somebody else's HTTP client, so the throw is caught here rather than trusted away, exactly as
   * `EtaService` guards the same contract. Both become `routingUnavailable`, because from a
   * customer's side there is no difference between a provider that said no and a provider that
   * fell over, and pricing must not depend on which it was.
   *
   * The refusal carries the two ids and never the coordinates: a 503 body is the wrong place for
   * somebody's home location.
   */
  private async route(
    pickup: GeoPoint,
    dropoff: GeoPoint,
    branchId: string,
    addressId: string,
  ): Promise<{ distanceMeters: number; durationSeconds: number } | null> {
    let result: Awaited<ReturnType<IRoutingPort['route']>> = null;
    try {
      result = await this.routing.route({ origin: pickup, destination: dropoff });
    } catch {
      throw DeliveryErrors.routingUnavailable({ branchId, addressId });
    }
    if (result === null) {
      throw DeliveryErrors.routingUnavailable({ branchId, addressId });
    }
    return { distanceMeters: result.distanceMeters, durationSeconds: result.durationSeconds };
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
