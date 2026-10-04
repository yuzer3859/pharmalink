import { DeliveryErrors } from '../errors';
import { Money } from '../value-objects/money.vo';

/**
 * The earning agreement, as a value.
 *
 * Passed **in** rather than read from configuration, for the reason `DeliveryFeePolicy` and
 * `ProofOfDeliveryPolicy` both state about their own settings: a domain policy that reached for
 * `IConfigPort` could not be tested against an agreement without a container, and would make a
 * driver's pay a property of the process rather than of its inputs.
 *
 * Every amount is ETB minor units except `feeSharePercent`, a `0`–`1` fraction, and
 * `calculationVersion`, a label.
 */
export interface DriverEarningSettings {
  /** The operator's name for this agreement, stamped onto every earning it produces. */
  calculationVersion: string;
  /** Flat amount per completed delivery. */
  base: number;
  /** Amount per kilometre of the job's frozen distance. */
  perKm: number;
  /** Fraction of the customer's delivery fee passed through to the driver. `0`–`1`. */
  feeSharePercent: number;
  /** Guaranteed minimum per delivery. */
  minimum: number;
  /** Cap per delivery, or `null` for none. The config layer's zero-as-absent is resolved before here. */
  maximum: number | null;
  /** Minor-unit step the total is rounded to the nearest of. `1` rounds to the santim. */
  roundTo: number;
}

/**
 * The authoritative delivery facts an earning is computed from.
 *
 * Both are **historical** — read off the delivery job as Work 09 froze them — and that is the
 * point of the type. There is no driver location here, no live route, no current rate card and no
 * order total: nothing that could be re-derived at accrual time from a world that has moved on
 * since the delivery happened.
 */
export interface EarnableDelivery {
  /** `delivery_jobs.distanceMeters`, frozen at job creation. `null` when the job never had one. */
  distanceMeters: number | null;
  /** `delivery_jobs.deliveryFee` — what the customer was actually charged, frozen at checkout. */
  deliveryFee: number;
}

/** The computed earning: the amount, and the four components that explain it. */
export interface DriverEarningBreakdown {
  calculationVersion: string;
  base: number;
  distanceComponent: number;
  feeShare: number;
  /** Always `0` — see `DriverEarning`'s note on why the component exists without a rule. */
  incentive: number;
  /** The distance the calculation used, echoed so the record says what it was computed from. */
  distanceMeters: number | null;
  /** The amount owed, after rounding and clamping. */
  total: Money;
}

const METRES_PER_KILOMETRE = 1000;

/**
 * `DriverEarningPolicy` (§3.5 F-ERN-01's "base + distance + incentives", BR-DEL-10, §10's
 * `domain/services`) — how much a driver is owed for a delivery they have completed.
 *
 * ## Pure, and deliberately ignorant
 *
 * No I/O, no configuration read, no clock, no NestJS. It is handed two frozen facts about a
 * delivery and an agreement, and it returns an amount. It does not know which driver, which
 * customer, which pharmacy, or when — so the same delivery and the same agreement produce the same
 * number every time it is asked, which is what makes a re-run of a failed accrual safe.
 *
 * ## A driver's earning is not the customer's delivery fee
 *
 * This is the single most important thing the policy asserts, and it asserts it by default:
 * `feeSharePercent` is `0`, so under the shipped configuration the earning has **no arithmetic
 * relationship at all** to what the customer paid. Delivery pricing (Work 09) and driver pay are
 * two agreements with two different counterparties, and the design's Open Question 4 — "who funds
 * it (platform vs delivery fee split)?" — is precisely the question of whether they are connected.
 * Wiring them together here would answer it silently.
 *
 * An operator who decides the fee funds the driver sets `feeSharePercent`, and the share is then
 * computed from the **frozen** `deliveryFee` — the amount that customer really paid — never from
 * today's rate card. That is what makes an earning accrued long after the delivery reproducible.
 *
 * ## The distance is historical or the answer is "no"
 *
 * `distanceMeters` comes from the job. When the agreement charges by the kilometre and the job has
 * none, this policy **refuses** — `requiresDistance` says so, and the caller turns that into a
 * retriable business-rule refusal (§10). It does not substitute a fresh route, and it does not
 * quietly treat the missing distance as zero: the first would pay a driver for a journey measured
 * after the fact between places they are no longer at, and the second would underpay them for a
 * journey they really made. Neither is a rounding error; both are somebody's wages.
 *
 * When the per-kilometre rate is zero the distance is irrelevant, so a job without one accrues
 * normally — which is every delivery on the platform today.
 *
 * ## What it must never become
 *
 * It computes **one number**: what is owed. It does not create a ledger entry, decide a payout
 * date, apply tax or withholding, net anything off, or know that Module 07 exists. Each of those
 * is a financial operation belonging to a module that owns money, and none has been specified.
 */
export const DriverEarningPolicy = {
  /**
   * Whether this agreement cannot be applied without a distance.
   *
   * Exposed separately so the caller can refuse *before* building anything, and so the refusal can
   * say which input was missing rather than reporting a generic failure.
   */
  requiresDistance(settings: DriverEarningSettings): boolean {
    return settings.perKm > 0;
  },

  /** Computes what the driver is owed, or throws if the agreement needs a distance it lacks. */
  calculate(delivery: EarnableDelivery, settings: DriverEarningSettings): DriverEarningBreakdown {
    assertSettings(settings);
    const distance = normaliseDistance(delivery.distanceMeters);
    const deliveryFee = normaliseFee(delivery.deliveryFee);

    if (this.requiresDistance(settings) && distance === null) {
      // Reported as a validation failure from the domain; `AccrueDriverEarningCommand` catches the
      // condition earlier and raises the retriable business-rule refusal the boundary needs. This
      // is the backstop that makes the rule true even for a caller that forgot to ask.
      throw DeliveryErrors.validation(
        'This earning agreement charges by distance and the delivery has none recorded.',
        { field: 'distanceMeters' },
      );
    }

    const distanceComponent =
      distance === null
        ? 0
        : // Integer multiplication first, then one division and one rounding. Computing
          // `perKm * (metres / 1000)` would carry a binary fraction through the multiplication and
          // round a value that had already drifted — the float arithmetic money must never use.
          Math.round((settings.perKm * distance) / METRES_PER_KILOMETRE);

    const feeShare = Math.round(deliveryFee * settings.feeSharePercent);

    // No rule produces one, and there is no knob that could. See `DriverEarning`.
    const incentive = 0;

    const gross = Money.base(settings.base)
      .add(Money.base(distanceComponent))
      .add(Money.base(feeShare))
      .add(Money.base(incentive));

    const total = gross
      .roundToNearest(settings.roundTo)
      .clamp(
        Money.base(settings.minimum),
        settings.maximum === null ? null : Money.base(settings.maximum),
      );

    return {
      calculationVersion: settings.calculationVersion,
      base: settings.base,
      distanceComponent,
      feeShare,
      incentive,
      distanceMeters: distance,
      total,
    };
  },
};

/**
 * A distance is whole, non-negative metres, or it is absent.
 *
 * A fractional metre from a routing provider is rounded — no plausible rate turns a sub-metre
 * difference into a santim — but a negative or non-finite value is rejected, because the only thing
 * that produces one is a broken write, and paying a driver from a broken write is how an earnings
 * ledger stops being trustworthy.
 */
function normaliseDistance(distanceMeters: number | null | undefined): number | null {
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

function normaliseFee(deliveryFee: number): number {
  if (!Number.isInteger(deliveryFee) || deliveryFee < 0) {
    throw DeliveryErrors.validation('deliveryFee must be a non-negative integer (minor units).', {
      field: 'deliveryFee',
      value: deliveryFee,
    });
  }
  return deliveryFee;
}

function assertSettings(settings: DriverEarningSettings): void {
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
  if (
    typeof settings.feeSharePercent !== 'number' ||
    !Number.isFinite(settings.feeSharePercent) ||
    settings.feeSharePercent < 0 ||
    settings.feeSharePercent > 1
  ) {
    throw DeliveryErrors.validation('feeSharePercent must be a number between 0 and 1.', {
      field: 'feeSharePercent',
      value: settings.feeSharePercent,
    });
  }
}
