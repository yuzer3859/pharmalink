import { ErrorCode } from '../../../../shared/errors/error-codes';
import { ApiException } from '../../../../shared/errors/api-exception';
import { LedgerAccountType } from '../enums';
import { AccountRef } from './account-ref.vo';
import { BASE_CURRENCY, Currency } from './currency.vo';
import { Fee } from './fee.vo';
import { FxRate } from './fx-rate.vo';
import {
  IdempotencyKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MIN_IDEMPOTENCY_KEY_LENGTH,
} from './idempotency-key.vo';
import { MAX_PERSISTABLE_MINOR_UNITS, Money } from './money.vo';

/** Every rejection in this module must be an `ApiException` carrying a canonical code — a raw
 * `Error` would bypass the error envelope. */
function expectApiError(fn: () => unknown, code: ErrorCode): void {
  expect(fn).toThrow(ApiException);
  try {
    fn();
  } catch (error) {
    expect((error as ApiException).code).toBe(code);
  }
}

describe('Currency', () => {
  it('accepts an ISO-4217 code and exposes the base currency', () => {
    expect(Currency.of('ETB').code).toBe('ETB');
    expect(Currency.base().code).toBe(BASE_CURRENCY);
    expect(Currency.base().isBase).toBe(true);
    expect(Currency.of('USD').isBase).toBe(false);
  });

  it.each(['etb', 'ET', 'ETBB', '', 'E1B', '   '])('rejects %p', (code) => {
    expectApiError(() => Currency.of(code as string), ErrorCode.VALIDATION_ERROR);
  });

  it('assertBase accepts ETB and rejects anything else (BRULE-22)', () => {
    expect(() => Currency.base().assertBase()).not.toThrow();
    expectApiError(() => Currency.of('USD').assertBase(), ErrorCode.VALIDATION_ERROR);
  });
});

describe('Money — creation and validation', () => {
  it('defaults to the base currency and keeps integer minor units', () => {
    const money = Money.of(1000);
    expect(money.amountMinor).toBe(1000);
    expect(money.currency.code).toBe('ETB');
  });

  it.each([10.5, Number.NaN, Number.POSITIVE_INFINITY, '100' as unknown as number])(
    'rejects the non-integer amount %p (ADR-005: money is never a float)',
    (amount) => {
      expectApiError(() => Money.of(amount as number), ErrorCode.VALIDATION_ERROR);
    },
  );

  it('rejects an amount beyond the safe integer range', () => {
    expectApiError(() => Money.of(Number.MAX_SAFE_INTEGER + 2), ErrorCode.VALIDATION_ERROR);
  });

  it('accepts zero and negative amounts — a derived ledger balance is legitimately either', () => {
    expect(Money.of(0).isZero).toBe(true);
    expect(Money.of(-500).isNegative).toBe(true);
    expect(Money.of(500).isPositive).toBe(true);
  });

  it('assertPersistable rejects an amount that would overflow the Int money column', () => {
    expect(() => Money.of(MAX_PERSISTABLE_MINOR_UNITS).assertPersistable()).not.toThrow();
    expectApiError(
      () => Money.of(MAX_PERSISTABLE_MINOR_UNITS + 1).assertPersistable(),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe('Money — arithmetic', () => {
  it('adds and subtracts exactly, in integer minor units', () => {
    expect(Money.of(1999).add(Money.of(1)).amountMinor).toBe(2000);
    expect(Money.of(10_000).subtract(Money.of(1000)).amountMinor).toBe(9000);
    // The classic float failure: 0.1 + 0.2 !== 0.3. In minor units it simply cannot occur.
    expect(Money.of(10).add(Money.of(20)).amountMinor).toBe(30);
  });

  it('subtraction may go negative (a payable can be over-refunded into a debit position)', () => {
    expect(Money.of(100).subtract(Money.of(250)).amountMinor).toBe(-150);
  });

  it('negates and sums', () => {
    expect(Money.of(750).negate().amountMinor).toBe(-750);
    expect(Money.sum([Money.of(10), Money.of(20), Money.of(30)]).amountMinor).toBe(60);
    expect(Money.sum([], 'ETB').amountMinor).toBe(0);
  });

  it('compares within a currency', () => {
    expect(Money.of(100).isGreaterThan(Money.of(99))).toBe(true);
    expect(Money.of(100).isLessThan(Money.of(101))).toBe(true);
    expect(Money.of(100).equals(Money.of(100))).toBe(true);
    expect(Money.of(100).equals(Money.of(100, 'USD'))).toBe(false);
  });

  it.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['compareTo', (a: Money, b: Money) => a.compareTo(b)],
  ])('%s never silently mixes currencies', (_name, operation) => {
    expectApiError(
      () => operation(Money.of(100, 'ETB'), Money.of(100, 'USD')),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('Money.sum rejects a list that mixes currencies', () => {
    expectApiError(
      () => Money.sum([Money.of(100, 'ETB'), Money.of(100, 'USD')], 'ETB'),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe('FxRate (§8)', () => {
  const capturedAt = new Date('2026-09-08T10:00:00.000Z');

  it('records rate, source and capture time', () => {
    const rate = FxRate.of({ rate: 57.5, source: 'nbe-daily', capturedAt });
    expect(rate.rate).toBe(57.5);
    expect(rate.source).toBe('nbe-daily');
    expect(rate.capturedAt).toEqual(capturedAt);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects the rate %p', (value) => {
    expectApiError(
      () => FxRate.of({ rate: value, source: 'nbe-daily', capturedAt }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a missing source or an invalid capture time', () => {
    expectApiError(
      () => FxRate.of({ rate: 57.5, source: '   ', capturedAt }),
      ErrorCode.VALIDATION_ERROR,
    );
    expectApiError(
      () => FxRate.of({ rate: 57.5, source: 'nbe', capturedAt: new Date('nope') }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('converts a foreign amount to whole ETB minor units, rounding half-up', () => {
    const rate = FxRate.of({ rate: 57.5, source: 'nbe-daily', capturedAt });
    // 10.00 USD -> 1000 * 57.5 = 57 500 santim, exactly.
    expect(rate.convert(Money.of(1000, 'USD')).amountMinor).toBe(57_500);
    expect(rate.convert(Money.of(1000, 'USD')).currency.code).toBe('ETB');
    // 1 cent at 57.5 is 57.5 santim — rounded, never carried as a fraction.
    expect(rate.convert(Money.of(1, 'USD')).amountMinor).toBe(58);
  });

  it('refuses to convert a currency to itself', () => {
    const rate = FxRate.of({ rate: 57.5, source: 'nbe-daily', capturedAt });
    expectApiError(() => rate.convert(Money.of(1000, 'ETB')), ErrorCode.VALIDATION_ERROR);
  });
});

describe('Fee (BRULE-23)', () => {
  it('applies a percentage, rounding to whole minor units like Module 06 PricingCalculator', () => {
    expect(Fee.of({ percent: 0.1 }).applyTo(Money.of(10_000)).amountMinor).toBe(1000);
    expect(Fee.of({ percent: 0.1 }).applyTo(Money.of(1005)).amountMinor).toBe(101);
  });

  it('applies a fixed component and a combination of both', () => {
    expect(Fee.of({ fixed: Money.of(250) }).applyTo(Money.of(10_000)).amountMinor).toBe(250);
    expect(
      Fee.of({ percent: 0.05, fixed: Money.of(250) }).applyTo(Money.of(10_000)).amountMinor,
    ).toBe(750);
    expect(Fee.none().applyTo(Money.of(10_000)).isZero).toBe(true);
    expect(Fee.none().isZero).toBe(true);
  });

  it.each([-0.1, 1.5, Number.NaN])('rejects the percent %p (must be 0..1)', (percent) => {
    expectApiError(() => Fee.of({ percent }), ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a negative fixed component', () => {
    expectApiError(() => Fee.of({ fixed: Money.of(-1) }), ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a fee larger than the amount it is charged on (it would post a negative payable)', () => {
    expectApiError(
      () => Fee.of({ fixed: Money.of(20_000) }).applyTo(Money.of(10_000)),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a fee on a negative amount, and a fee in a different currency', () => {
    expectApiError(() => Fee.none().applyTo(Money.of(-1)), ErrorCode.VALIDATION_ERROR);
    expectApiError(
      () => Fee.of({ fixed: Money.of(100, 'USD') }).applyTo(Money.of(10_000, 'ETB')),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe('AccountRef (§5.2, §7 natural key)', () => {
  it('builds owner-scoped accounts', () => {
    const wallet = AccountRef.customerWallet('user-1');
    expect(wallet.toKey()).toEqual({
      type: LedgerAccountType.CUSTOMER_WALLET,
      ownerId: 'user-1',
      currency: 'ETB',
    });
    expect(AccountRef.providerPayable('pharmacy-1').type).toBe(
      LedgerAccountType.PROVIDER_PAYABLE,
    );
  });

  it('builds platform accounts with a null owner', () => {
    const revenue = AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE);
    expect(revenue.toKey()).toEqual({
      type: LedgerAccountType.PLATFORM_REVENUE,
      ownerId: null,
      currency: 'ETB',
    });
  });

  it('requires an owner for account types that are meaningless without one', () => {
    expectApiError(
      () => AccountRef.of({ type: LedgerAccountType.CUSTOMER_WALLET }),
      ErrorCode.VALIDATION_ERROR,
    );
    expectApiError(
      () => AccountRef.of({ type: LedgerAccountType.PROVIDER_PAYABLE, ownerId: null }),
      ErrorCode.VALIDATION_ERROR,
    );
    expectApiError(
      () => AccountRef.customerWallet('   '),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects an unknown account type and an invalid currency', () => {
    expectApiError(
      () => AccountRef.of({ type: 'NOPE' as LedgerAccountType, ownerId: 'x' }),
      ErrorCode.VALIDATION_ERROR,
    );
    expectApiError(
      () => AccountRef.customerWallet('user-1', 'birr'),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('compares by natural key, not identity', () => {
    expect(AccountRef.customerWallet('user-1').equals(AccountRef.customerWallet('user-1'))).toBe(
      true,
    );
    expect(AccountRef.customerWallet('user-1').equals(AccountRef.customerWallet('user-2'))).toBe(
      false,
    );
    expect(AccountRef.customerWallet('user-1').toString()).toBe('CUSTOMER_WALLET:user-1:ETB');
  });
});

describe('IdempotencyKey (BRULE-25)', () => {
  it('accepts and trims a well-formed key', () => {
    expect(IdempotencyKey.of('  pay-2026-0908-abc  ').value).toBe('pay-2026-0908-abc');
    expect(IdempotencyKey.of('a'.repeat(MIN_IDEMPOTENCY_KEY_LENGTH)).value).toHaveLength(
      MIN_IDEMPOTENCY_KEY_LENGTH,
    );
    expect(IdempotencyKey.of('a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH)).value).toHaveLength(
      MAX_IDEMPOTENCY_KEY_LENGTH,
    );
  });

  it('rejects a key that is too short, too long, empty or not a string', () => {
    expectApiError(() => IdempotencyKey.of('short'), ErrorCode.VALIDATION_ERROR);
    expectApiError(
      () => IdempotencyKey.of('a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)),
      ErrorCode.VALIDATION_ERROR,
    );
    expectApiError(() => IdempotencyKey.of('        '), ErrorCode.VALIDATION_ERROR);
    expectApiError(
      () => IdempotencyKey.of(undefined as unknown as string),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects embedded whitespace and control characters', () => {
    expectApiError(() => IdempotencyKey.of('pay key 1234'), ErrorCode.VALIDATION_ERROR);
    expectApiError(() => IdempotencyKey.of('pay\nkey-1234'), ErrorCode.VALIDATION_ERROR);
  });

  it('compares by value', () => {
    expect(IdempotencyKey.of('pay-abc-123').equals(IdempotencyKey.of('pay-abc-123'))).toBe(true);
    expect(IdempotencyKey.of('pay-abc-123').equals(IdempotencyKey.of('pay-abc-124'))).toBe(false);
  });
});
