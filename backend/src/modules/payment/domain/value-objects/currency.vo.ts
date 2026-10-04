import { PaymentErrors } from '../errors';

/**
 * The platform's base/settlement currency (BRULE-22, NFR-LOC-01, ADR-005). Every ledger balance,
 * provider payout and `Payment.amount` is denominated in it; a cross-border payment additionally
 * records the customer's original currency plus the `FxRate` used to reach ETB (§8).
 */
export const BASE_CURRENCY = 'ETB';

const ISO_4217_CODE = /^[A-Z]{3}$/;

/**
 * ISO-4217 currency code (§5.2). Deliberately not restricted to `ETB`: Module 04's `Money.of`
 * could reject anything but ETB because Slice-1 inventory is domestic-only, but Module 07 must
 * also represent the *original* currency of a diaspora payment (§3.1 F-PAY-03, §8) before it is
 * converted. "ETB only" is therefore enforced where the design actually requires it — the
 * amounts that get stored and settled — via `Currency.assertBase()` / `Money.base()`, not by
 * making every currency value in the module unrepresentable.
 */
export class Currency {
  private constructor(readonly code: string) {}

  static of(code: string): Currency {
    if (typeof code !== 'string' || !ISO_4217_CODE.test(code)) {
      throw PaymentErrors.validation(
        'currency must be a three-letter uppercase ISO-4217 code (e.g. ETB).',
        { field: 'currency', value: code },
      );
    }
    return new Currency(code);
  }

  /** The platform's settlement currency — the only currency a ledger balance is ever kept in. */
  static base(): Currency {
    return new Currency(BASE_CURRENCY);
  }

  get isBase(): boolean {
    return this.code === BASE_CURRENCY;
  }

  equals(other: Currency): boolean {
    return this.code === other.code;
  }

  /** Guard for values the design requires to be in ETB (BRULE-22): ledger postings, payment
   * amounts, provider settlements. */
  assertBase(field = 'currency'): Currency {
    if (!this.isBase) {
      throw PaymentErrors.validation(
        `${field} must be ${BASE_CURRENCY}: all platform amounts are recorded and settled in ${BASE_CURRENCY} (BRULE-22).`,
        { field, value: this.code },
      );
    }
    return this;
  }

  toString(): string {
    return this.code;
  }
}
