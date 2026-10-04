import { PaymentErrors } from '../errors';
import { Currency } from './currency.vo';
import { Money } from './money.vo';

export interface FxRateProps {
  /** Multiplier taking one minor unit of the source currency to minor units of ETB. */
  rate: number;
  /** Provenance of the rate (gateway name, NBE feed, …) — §8 requires rate + source + time. */
  source: string;
  capturedAt: Date;
}

const MAX_SOURCE_LENGTH = 64;

/**
 * `FxRate` (§5.2, §8) — the exchange rate applied to a cross-border/diaspora payment, together
 * with **where it came from and when it was captured**. The design is explicit that all three
 * are recorded on the payment (`fx_rate`, `fx_source`, plus the original amount/currency), so a
 * settled ETB amount can always be re-derived and audited.
 *
 * `rate` is the one place in this module where a non-integer number is legitimate: it is a rate,
 * not an amount. Amounts stay integers — `convert()` rounds to whole minor units immediately
 * (ADR-005), so no fractional santim ever propagates into the ledger.
 */
export class FxRate {
  private constructor(
    readonly rate: number,
    readonly source: string,
    readonly capturedAt: Date,
  ) {}

  static of(props: FxRateProps): FxRate {
    if (typeof props.rate !== 'number' || !Number.isFinite(props.rate) || props.rate <= 0) {
      throw PaymentErrors.validation('fxRate must be a finite positive number.', {
        field: 'fxRate',
        value: props.rate,
      });
    }
    const source = typeof props.source === 'string' ? props.source.trim() : '';
    if (source.length === 0 || source.length > MAX_SOURCE_LENGTH) {
      throw PaymentErrors.validation(
        `fxSource must be a non-empty string of at most ${MAX_SOURCE_LENGTH} characters.`,
        { field: 'fxSource' },
      );
    }
    if (!(props.capturedAt instanceof Date) || Number.isNaN(props.capturedAt.getTime())) {
      throw PaymentErrors.validation('fxRate capturedAt must be a valid date.', {
        field: 'capturedAt',
      });
    }
    return new FxRate(props.rate, source, new Date(props.capturedAt.getTime()));
  }

  /**
   * Converts a foreign-currency amount to `target` (ETB by default, BRULE-22). Rounds half-up to
   * whole minor units — a converted amount is money, and money is an integer.
   */
  convert(original: Money, target: Currency = Currency.base()): Money {
    if (original.currency.equals(target)) {
      throw PaymentErrors.validation(
        `Refusing to apply an FX rate from ${original.currency} to itself.`,
        { field: 'currency', value: target.code },
      );
    }
    return Money.of(Math.round(original.amountMinor * this.rate), target);
  }
}
