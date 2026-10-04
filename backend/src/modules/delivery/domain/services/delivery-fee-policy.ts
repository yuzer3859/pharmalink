import { DeliveryErrors } from '../errors';
import { Money } from '../value-objects/money.vo';

/**
 * How a particular fee was arrived at — the "pricing basis/type" a quote must report.
 *
 *  - **`ZONE`** — the routed distance fell inside a configured band, and that band's flat fee is
 *    the charge. Nothing about the distance beyond which band it landed in affects the price.
 *  - **`DISTANCE`** — no band applied, so the fee is `base + rate × kilometres`.
 *  - **`BASE`** — the distance is *unknown*, so only the distance-independent part applies. See
 *    `DeliveryFeePolicy.quote` for why an unknown distance is not the same thing as a failure.
 */
export type DeliveryFeeBasis = 'ZONE' | 'DISTANCE' | 'BASE';

/** One configured pricing band, as the policy consumes it. `uptoMeters` is inclusive. */
export interface DeliveryFeeZone {
  id: string;
  uptoMeters: number;
  /** The flat charge for this band, in ETB minor units. */
  fee: number;
}

/**
 * The rate card, as a value.
 *
 * Passed **in** rather than read from configuration, for the reason `ProofOfDeliveryPolicy` states
 * about its own settings: a domain policy that reached for `IConfigPort` could not be tested
 * against a rate card without a container, could not be reasoned about without knowing the
 * environment, and would make the fee a property of the process rather than of its inputs. The
 * application layer resolves these once (`resolveDeliveryFeeSettings`) and hands them over.
 *
 * Every field is ETB minor units except `zones`, whose `uptoMeters` is metres, and
 * `pricingVersion`, which is a label.
 */
export interface DeliveryFeeSettings {
  /** The operator's name for this rate card, carried onto every quote it produces. */
  pricingVersion: string;
  base: number;
  perKm: number;
  minimum: number;
  /** `null` for no cap. The configuration layer's zero-as-absent is resolved before it gets here. */
  maximum: number | null;
  /** The minor-unit step the final amount is rounded to the nearest of. `1` rounds to the santim. */
  roundTo: number;
  /** Ascending by `uptoMeters`. An empty list means every quote takes the `DISTANCE` basis. */
  zones: DeliveryFeeZone[];
}

/**
 * What the policy produces: the amount, and everything needed to explain it later.
 *
 * The components are not decoration. A delivery fee is a charge on somebody's medicines, and six
 * months later the only defensible answer to "why was I charged this?" is the arithmetic itself —
 * which rate card, which basis, which band, and over what distance. `fee` is the number; the rest
 * is the working.
 */
export interface DeliveryFeeQuote {
  pricingVersion: string;
  basis: DeliveryFeeBasis;
  /** The band that priced it, or `null` on the `DISTANCE`/`BASE` bases. */
  zoneId: string | null;
  /** The routed road distance, or `null` when it could not be established. */
  distanceMeters: number | null;
  /** The distance-independent component that went into the calculation, before rounding. */
  baseFee: number;
  /** The distance-dependent component, before rounding. Always `0` on the `ZONE` basis. */
  distanceFee: number;
  /** The charge, after rounding and clamping. */
  fee: Money;
}

const METRES_PER_KILOMETRE = 1000;

/**
 * `DeliveryFeeCalculator` (§3.5 F-FEE-01, BR-DEL-09, §6's
 * `CreateDeliveryJob → DeliveryFeeCalculator (distance/zone)`, §10's `domain/services`) — the one
 * place on this platform that decides what a customer pays for delivery.
 *
 * ## Pure, and deliberately ignorant
 *
 * No I/O, no configuration reads, no NestJS, no clock. It is handed a distance and a rate card and
 * returns an amount. It does not know which order it is pricing, who the customer is, which
 * pharmacy is dispatching, or whether a delivery job exists — and that ignorance is what makes it
 * safe to call at checkout-quote time, at checkout time and at job-creation time and get the same
 * answer from the same inputs every time (§15's "deterministic repeated quote behaviour").
 *
 * ## What it is not allowed to become
 *
 * **It is not Module 06's `PricingCalculator` and must never grow into one.** It returns *one
 * number*: the delivery charge. Subtotal, platform fee, discount and grand total belong to
 * `PricingCalculator`, which remains the sole owner of what the customer is charged in total;
 * this produces an input to that calculation and nothing more. The boundary is visible in the
 * return type — there is no `grandTotal` here and there is nowhere to put one.
 *
 * **It is not the driver's earning.** A delivery fee is what the customer pays; what the driver is
 * paid is a separate figure, funded by a decision nobody has taken yet (the design's Open
 * Question 4: "base + per-km + incentives; who funds it — platform vs delivery fee split?").
 * Deriving one from the other here would answer that question by accident. Work 10 reads the
 * charged fee from the delivery job's snapshot and applies its own rules.
 *
 * ## The three bases, and the ordering between them
 *
 * A zone, when one matches, *replaces* the distance formula rather than adding to it. That is what
 * a zoned rate card means commercially — "anywhere in the inner ring is 20 birr" — and mixing the
 * two would produce a charge no published price list would explain.
 *
 * Bands are matched nearest-first, so overlapping bands resolve to the cheapest applicable one
 * rather than to whichever the operator happened to type first. A distance past the furthest band
 * falls through to the distance formula, which is the deterministic no-match behaviour §8 asks
 * for: the rate card has said nothing about that distance, and the formula is what the platform
 * says when the rate card is silent.
 */
export const DeliveryFeePolicy = {
  /**
   * Prices one delivery.
   *
   * `distanceMeters` is `null` when the platform genuinely does not know how far the delivery is —
   * an address or a branch stored without coordinates, which Module 02 and Module 04 both permit.
   * That is **not** the same as a routing failure and is not treated as one: the policy charges
   * only the distance-independent component and reports `basis: 'BASE'` with `distanceMeters:
   * null`, which fabricates nothing. A routing provider that was *asked* and could not answer is
   * a different situation entirely, and it never reaches this function — `QuoteDeliveryFeeQuery`
   * refuses the quote outright (§10), because a fee computed from a distance the platform failed
   * to measure would be a guess presented as a price.
   */
  quote(distanceMeters: number | null, settings: DeliveryFeeSettings): DeliveryFeeQuote {
    assertSettings(settings);
    const distance = normaliseDistance(distanceMeters);

    const zone = distance === null ? null : matchZone(distance, settings.zones);

    let basis: DeliveryFeeBasis;
    let baseFee: number;
    let distanceFee: number;

    if (zone !== null) {
      basis = 'ZONE';
      baseFee = zone.fee;
      distanceFee = 0;
    } else if (distance === null) {
      basis = 'BASE';
      baseFee = settings.base;
      distanceFee = 0;
    } else {
      basis = 'DISTANCE';
      baseFee = settings.base;
      // Integer multiplication first, then a single division and a single rounding. Computing
      // `perKm * (metres / 1000)` instead would carry a binary fraction through the multiplication
      // and round a value that had already drifted — the float arithmetic §9 forbids for money.
      distanceFee = Math.round((settings.perKm * distance) / METRES_PER_KILOMETRE);
    }

    const gross = Money.base(baseFee).add(Money.base(distanceFee));
    const fee = gross
      .roundToNearest(settings.roundTo)
      .clamp(
        Money.base(settings.minimum),
        settings.maximum === null ? null : Money.base(settings.maximum),
      );

    return {
      pricingVersion: settings.pricingVersion,
      basis,
      zoneId: zone?.id ?? null,
      distanceMeters: distance,
      baseFee,
      distanceFee,
      fee,
    };
  },
};

/** The nearest band whose ceiling the distance is at or below, or `null` when none applies. */
function matchZone(distanceMeters: number, zones: DeliveryFeeZone[]): DeliveryFeeZone | null {
  const ordered = [...zones].sort((a, b) => a.uptoMeters - b.uptoMeters);
  return ordered.find((zone) => distanceMeters <= zone.uptoMeters) ?? null;
}

/**
 * A distance is metres, whole and non-negative, or it is not a distance.
 *
 * A routing provider returning a fractional metre is rounded rather than refused — a sub-metre
 * difference cannot change a price at any plausible rate — but a negative or non-finite value is
 * rejected, because the only thing that produces one is a broken adapter, and pricing a delivery
 * from a broken adapter's output is how a customer ends up charged for a journey to nowhere.
 */
function normaliseDistance(distanceMeters: number | null): number | null {
  if (distanceMeters === null || distanceMeters === undefined) {
    return null;
  }
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw DeliveryErrors.validation('distanceMeters must be a non-negative number.', {
      field: 'distanceMeters',
      value: distanceMeters,
    });
  }
  return Math.round(distanceMeters);
}

function assertSettings(settings: DeliveryFeeSettings): void {
  for (const [field, value] of [
    ['base', settings.base],
    ['perKm', settings.perKm],
    ['minimum', settings.minimum],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw DeliveryErrors.validation(`${field} must be a non-negative integer (minor units).`, {
        field,
        value,
      });
    }
  }
  if (settings.maximum !== null && (!Number.isInteger(settings.maximum) || settings.maximum < 0)) {
    throw DeliveryErrors.validation('maximum must be a non-negative integer (minor units).', {
      field: 'maximum',
      value: settings.maximum,
    });
  }
  if (!Number.isInteger(settings.roundTo) || settings.roundTo < 1) {
    throw DeliveryErrors.validation('roundTo must be a positive integer (minor units).', {
      field: 'roundTo',
      value: settings.roundTo,
    });
  }
}
