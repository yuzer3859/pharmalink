import { PaymentErrors } from '../errors';
import { BASE_CURRENCY, Currency } from './currency.vo';

/**
 * The widest amount a money column can hold. Every monetary column in
 * `prisma/schema/07-payment.prisma` is a Prisma `Int` (Postgres `int4`), so a value outside this
 * range cannot be persisted — rejecting it in the domain turns a database-level overflow into a
 * validated domain error at the point the amount is constructed.
 */
export const MAX_PERSISTABLE_MINOR_UNITS = 2_147_483_647;

/**
 * `{ amountMinor, currency }` (§5.2, ADR-005) — integer minor units (santim), never a float.
 *
 * Module 07's own copy (ADR-002), and it deliberately differs from Module 04's `Money` in one
 * respect: **it accepts zero and negative amounts.** Module 04's `Money` only ever expresses a
 * shelf price, so `<= 0` is meaningless there. Module 07's `Money` also expresses *derived
 * ledger balances* (`Σ credits − Σ debits`, §5.3), which are legitimately zero and, for some
 * account types, negative. Positivity is therefore enforced where the business rule actually
 * lives — a ledger entry's amount, a payment's amount (§5.3, and the
 * `ledger_entries_amount_positive_check` / `payments_amount_positive_check` database
 * constraints) — rather than in the value object shared by both concepts.
 *
 * All arithmetic is exact integer arithmetic and refuses to mix currencies silently.
 */
export class Money {
  private constructor(
    readonly amountMinor: number,
    readonly currency: Currency,
  ) {}

  static of(amountMinor: number, currency: string | Currency = BASE_CURRENCY): Money {
    if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor)) {
      throw PaymentErrors.validation('amount must be an integer number of minor units.', {
        field: 'amount',
        value: amountMinor,
      });
    }
    if (!Number.isSafeInteger(amountMinor)) {
      throw PaymentErrors.validation('amount exceeds the safe integer range.', {
        field: 'amount',
        value: amountMinor,
      });
    }
    const resolved = currency instanceof Currency ? currency : Currency.of(currency);
    return new Money(amountMinor, resolved);
  }

  /** An amount in the platform's settlement currency (ETB) — the only form a ledger entry, a
   * payment amount or a settlement may take (BRULE-22). */
  static base(amountMinor: number): Money {
    return Money.of(amountMinor, Currency.base());
  }

  static zero(currency: string | Currency = BASE_CURRENCY): Money {
    return Money.of(0, currency);
  }

  /** Exact integer sum. An empty list has no currency of its own, so one must be supplied. */
  static sum(values: readonly Money[], currency: string | Currency = BASE_CURRENCY): Money {
    return values.reduce<Money>((total, value) => total.add(value), Money.zero(currency));
  }

  get isZero(): boolean {
    return this.amountMinor === 0;
  }

  get isPositive(): boolean {
    return this.amountMinor > 0;
  }

  get isNegative(): boolean {
    return this.amountMinor < 0;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amountMinor - other.amountMinor, this.currency);
  }

  negate(): Money {
    return Money.of(-this.amountMinor, this.currency);
  }

  equals(other: Money): boolean {
    return this.amountMinor === other.amountMinor && this.currency.equals(other.currency);
  }

  /** `-1 | 0 | 1`, comparable only within one currency. */
  compareTo(other: Money): number {
    this.assertSameCurrency(other);
    return Math.sign(this.amountMinor - other.amountMinor);
  }

  isGreaterThan(other: Money): boolean {
    return this.compareTo(other) > 0;
  }

  isLessThan(other: Money): boolean {
    return this.compareTo(other) < 0;
  }

  /** Never silently mix currencies (§5.3) — 100 ETB + 100 USD is a defect, not a conversion. */
  assertSameCurrency(other: Money): void {
    if (!this.currency.equals(other.currency)) {
      throw PaymentErrors.validation(
        `Cannot combine amounts in different currencies (${this.currency} vs ${other.currency}).`,
        { field: 'currency', left: this.currency.code, right: other.currency.code },
      );
    }
  }

  /** Guard for an amount about to be written to an `Int` money column. */
  assertPersistable(field = 'amount'): Money {
    if (Math.abs(this.amountMinor) > MAX_PERSISTABLE_MINOR_UNITS) {
      throw PaymentErrors.validation(
        `${field} exceeds the maximum storable amount (${MAX_PERSISTABLE_MINOR_UNITS} minor units).`,
        { field, value: this.amountMinor },
      );
    }
    return this;
  }

  toString(): string {
    return `${this.amountMinor} ${this.currency.code}`;
  }
}
