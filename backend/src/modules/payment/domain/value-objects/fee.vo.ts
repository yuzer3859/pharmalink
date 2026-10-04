import { PaymentErrors } from '../errors';
import { Money } from './money.vo';

export interface FeeProps {
  /** Commission share, `0`–`1`. Same shape and range as Module 06's
   * `PricingCalculator.platformFeePercent`, so one configured value can drive both. */
  percent?: number;
  /** Flat component, in minor units of the fee's currency. */
  fixed?: Money;
}

/**
 * `Fee` (§5.2, §8) — the configurable platform commission deducted before provider settlement
 * (BRULE-23). Percentage and/or fixed; the design leaves the exact model to product (§Open
 * Questions 3), so both components exist and either may be zero.
 *
 * Rounding matches Module 06's `PricingCalculator` exactly (`Math.round` to whole minor units) —
 * the platform fee a customer is quoted at checkout and the fee credited to `PLATFORM_REVENUE`
 * at capture must not drift apart because two code paths rounded differently.
 */
export class Fee {
  private constructor(
    readonly percent: number,
    readonly fixed: Money,
  ) {}

  static of(props: FeeProps = {}): Fee {
    const percent = props.percent ?? 0;
    if (typeof percent !== 'number' || Number.isNaN(percent) || percent < 0 || percent > 1) {
      throw PaymentErrors.validation('fee percent must be a number between 0 and 1.', {
        field: 'percent',
        value: percent,
      });
    }
    const fixed = props.fixed ?? Money.base(0);
    if (fixed.isNegative) {
      throw PaymentErrors.validation('fee fixed component must not be negative.', {
        field: 'fixed',
        value: fixed.amountMinor,
      });
    }
    return new Fee(percent, fixed);
  }

  static none(): Fee {
    return new Fee(0, Money.base(0));
  }

  get isZero(): boolean {
    return this.percent === 0 && this.fixed.isZero;
  }

  /**
   * Computes the fee owed on `base`. Rejects a fee that would exceed the amount it is charged on
   * — that would post a negative `PROVIDER_PAYABLE` credit at capture (§11.3), which is a
   * misconfiguration, not a legitimate posting. Failing loudly here keeps it out of the ledger.
   */
  applyTo(base: Money): Money {
    if (base.isNegative) {
      throw PaymentErrors.validation('A fee cannot be charged on a negative amount.', {
        field: 'amount',
        value: base.amountMinor,
      });
    }
    base.assertSameCurrency(this.fixed);
    const fee = Money.of(Math.round(base.amountMinor * this.percent), base.currency).add(
      this.fixed,
    );
    if (fee.isGreaterThan(base)) {
      throw PaymentErrors.validation(
        `Computed fee (${fee}) exceeds the amount it is charged on (${base}).`,
        { field: 'fee', fee: fee.amountMinor, base: base.amountMinor },
      );
    }
    return fee;
  }
}
