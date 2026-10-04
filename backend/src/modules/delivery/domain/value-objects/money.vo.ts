import { DeliveryErrors } from '../errors';

/**
 * The platform's settlement currency, and the only one Slice 1 has ever supported (ADR-005).
 *
 * A constant rather than an enum because there is exactly one value and a single-member enum is a
 * costume. When a second currency arrives it arrives with an exchange-rate decision, a settlement
 * decision and a Module 07 conversation, none of which a delivery module should be anticipating.
 */
export const DELIVERY_BASE_CURRENCY = 'ETB';

/**
 * `{ amountMinor, currency }` (§5.2's money handling, ADR-005) — **Module 08's own copy**, per
 * ADR-002's no-cross-module-import rule, exactly as Modules 04 and 07 each keep theirs.
 *
 * The shape is shared; the rules are not, and the difference is the reason a copy exists rather
 * than an import. Module 04's `Money` refuses zero because it only ever expresses a shelf price.
 * Module 07's accepts negatives because it also expresses derived ledger balances. **This one
 * accepts zero and refuses negatives**, because the one thing it expresses is a delivery charge: a
 * free delivery is an ordinary commercial decision and is in fact the platform's current default
 * (see `DEFAULT_DELIVERY_FEE_BASE`), while a negative delivery fee would be the platform paying a
 * customer to receive their medicines — a refund, which is Module 07's word and Module 07's ledger.
 *
 * All arithmetic is exact integer arithmetic on minor units (santim). **There is no `number` path
 * through this class that carries a fraction**, which is §9's requirement stated as a type rather
 * than as a convention: a float can only enter through `of`, and `of` rejects it.
 */
export class Money {
  private constructor(
    readonly amountMinor: number,
    readonly currency: string,
  ) {}

  static of(amountMinor: number, currency: string = DELIVERY_BASE_CURRENCY): Money {
    if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor)) {
      throw DeliveryErrors.validation('amount must be an integer number of minor units.', {
        field: 'amount',
        value: amountMinor,
      });
    }
    if (!Number.isSafeInteger(amountMinor)) {
      throw DeliveryErrors.validation('amount exceeds the safe integer range.', {
        field: 'amount',
        value: amountMinor,
      });
    }
    if (amountMinor < 0) {
      throw DeliveryErrors.validation('amount must not be negative.', {
        field: 'amount',
        value: amountMinor,
      });
    }
    if (currency !== DELIVERY_BASE_CURRENCY) {
      throw DeliveryErrors.validation(
        `Unsupported currency: ${currency}. Only ${DELIVERY_BASE_CURRENCY} is supported.`,
        { field: 'currency', value: currency },
      );
    }
    return new Money(amountMinor, currency);
  }

  /** An amount in the platform's settlement currency — the only form a delivery fee ever takes. */
  static base(amountMinor: number): Money {
    return Money.of(amountMinor, DELIVERY_BASE_CURRENCY);
  }

  static zero(currency: string = DELIVERY_BASE_CURRENCY): Money {
    return Money.of(0, currency);
  }

  get isZero(): boolean {
    return this.amountMinor === 0;
  }

  /** Exact integer sum. Refuses to mix currencies silently. */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amountMinor + other.amountMinor, this.currency);
  }

  /**
   * Rounds up to `floor` and down to `ceiling`, in that order.
   *
   * The order is deliberate and is the one place a clamp can be got wrong: applying the ceiling
   * last means a rate card whose minimum exceeds its maximum resolves to the *maximum*, never to
   * an amount above a cap the operator set. A cap is a promise to the customer; a floor is a
   * commercial preference, and when the two contradict each other the promise wins.
   *
   * `ceiling` is `null` for "no cap", which is how `delivery.feeMaximum`'s zero-as-absent reaches
   * the domain — the encoding stays at the configuration boundary and never leaks in here as a
   * magic zero.
   */
  clamp(floor: Money, ceiling: Money | null): Money {
    this.assertSameCurrency(floor);
    let amount = Math.max(this.amountMinor, floor.amountMinor);
    if (ceiling !== null) {
      this.assertSameCurrency(ceiling);
      amount = Math.min(amount, ceiling.amountMinor);
    }
    return amount === this.amountMinor ? this : Money.of(amount, this.currency);
  }

  /**
   * Rounds to the nearest multiple of `step` minor units.
   *
   * `Math.round`, which is the convention `PricingCalculator.computeTotals` already uses for the
   * platform fee — one shared rounding rule across every money this platform computes, rather than
   * a delivery fee that rounds half-up while a commission rounds half-even.
   *
   * A step of `1` is the identity, so the caller never has to branch on whether rounding is
   * configured.
   */
  roundToNearest(step: number): Money {
    if (!Number.isInteger(step) || step < 1) {
      throw DeliveryErrors.validation('rounding step must be a positive integer.', {
        field: 'roundTo',
        value: step,
      });
    }
    if (step === 1) {
      return this;
    }
    return Money.of(Math.round(this.amountMinor / step) * step, this.currency);
  }

  equals(other: Money): boolean {
    return this.amountMinor === other.amountMinor && this.currency === other.currency;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw DeliveryErrors.validation(
        `Cannot combine ${this.currency} with ${other.currency}.`,
        { field: 'currency' },
      );
    }
  }
}
