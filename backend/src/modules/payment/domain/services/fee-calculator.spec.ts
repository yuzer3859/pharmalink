import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { Money } from '../value-objects/money.vo';
import { FeeCalculator } from './fee-calculator';

function expectApiError(fn: () => unknown, code: ErrorCode): void {
  expect(fn).toThrow(ApiException);
  try {
    fn();
  } catch (error) {
    expect((error as ApiException).code).toBe(code);
  }
}

describe('FeeCalculator.splitCapture (§11.3, BRULE-23)', () => {
  it("reproduces the design's own example: 100 ETB gross, 10 ETB fee", () => {
    const split = FeeCalculator.splitCapture({
      gross: Money.base(10_000),
      platformFee: Money.base(1_000),
    });

    expect(split.gross.amountMinor).toBe(10_000);
    expect(split.providerNet.amountMinor).toBe(9_000);
    expect(split.fee.amountMinor).toBe(1_000);
  });

  it('always reconciles: providerNet + fee === gross', () => {
    const cases: Array<[number, number]> = [
      [10_000, 1_000],
      [1, 0],
      [99_999, 12_345],
      [2_147_483_647, 1],
      [7, 7],
    ];
    for (const [gross, fee] of cases) {
      const split = FeeCalculator.splitCapture({
        gross: Money.base(gross),
        platformFee: Money.base(fee),
      });
      expect(split.providerNet.amountMinor + split.fee.amountMinor).toBe(gross);
    }
  });

  it('gives the provider the whole gross when the fee is zero (today\'s configured rate)', () => {
    const split = FeeCalculator.splitCapture({
      gross: Money.base(11_500),
      platformFee: Money.base(0),
    });

    expect(split.fee.amountMinor).toBe(0);
    expect(split.providerNet.amountMinor).toBe(11_500);
  });

  it('allows a fee equal to the gross, leaving a zero provider net', () => {
    const split = FeeCalculator.splitCapture({
      gross: Money.base(500),
      platformFee: Money.base(500),
    });
    expect(split.fee.amountMinor).toBe(500);
    expect(split.providerNet.amountMinor).toBe(0);
  });

  it('rejects a fee larger than the gross — it would post a negative provider payable', () => {
    expectApiError(
      () =>
        FeeCalculator.splitCapture({
          gross: Money.base(10_000),
          platformFee: Money.base(10_001),
        }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a negative fee', () => {
    expectApiError(
      () =>
        FeeCalculator.splitCapture({
          gross: Money.base(10_000),
          platformFee: Money.base(-1),
        }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it.each([0, -100])('rejects the non-positive gross %p', (gross) => {
    expectApiError(
      () =>
        FeeCalculator.splitCapture({
          gross: Money.base(gross),
          platformFee: Money.base(0),
        }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a fee in a different currency from the gross', () => {
    expectApiError(
      () =>
        FeeCalculator.splitCapture({
          gross: Money.of(10_000, 'ETB'),
          platformFee: Money.of(1_000, 'USD'),
        }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('keeps every leg in the gross currency', () => {
    const split = FeeCalculator.splitCapture({
      gross: Money.base(10_000),
      platformFee: Money.base(1_000),
    });
    for (const leg of [split.gross, split.fee, split.providerNet]) {
      expect(leg.currency.code).toBe('ETB');
    }
  });
});

/**
 * ADR-019's platform-funded coupon discount, at the level of the pure arithmetic. The posting
 * these numbers become, and the refund that reverses it, are proved against real PostgreSQL in
 * `test/payment/platform-funded-coupon.e2e-spec.ts`.
 */
describe('FeeCalculator.splitCapture with a platform-funded discount (ADR-019)', () => {
  it('pays the provider as if no coupon existed, and books the discount as an expense', () => {
    // subtotal 9_000 + delivery 1_000 + fee 1_000 - discount 2_000 = 9_000 collected.
    const split = FeeCalculator.splitCapture({
      gross: Money.base(9_000),
      platformFee: Money.base(1_000),
      discountTotal: Money.base(2_000),
    });

    expect(split.gross.amountMinor).toBe(9_000);
    expect(split.fee.amountMinor).toBe(1_000);
    // 9_000 - 1_000 + 2_000 = 10_000 = subtotal + deliveryFee. Not reduced by the coupon.
    expect(split.providerNet.amountMinor).toBe(10_000);
    expect(split.promotionExpense.amountMinor).toBe(2_000);
  });

  it('balances: debits (gross + expense) equal credits (providerNet + fee)', () => {
    const split = FeeCalculator.splitCapture({
      gross: Money.base(8_221),
      platformFee: Money.base(333),
      discountTotal: Money.base(1_000),
    });

    expect(split.gross.add(split.promotionExpense).amountMinor).toBe(
      split.providerNet.add(split.fee).amountMinor,
    );
  });

  it('leaves the commission alone — the expense is never netted out of revenue', () => {
    const withCoupon = FeeCalculator.splitCapture({
      gross: Money.base(9_000),
      platformFee: Money.base(1_000),
      discountTotal: Money.base(2_000),
    });
    const withoutCoupon = FeeCalculator.splitCapture({
      gross: Money.base(11_000),
      platformFee: Money.base(1_000),
    });

    // Same order, one discounted and one not: identical fee, identical provider payable. Only the
    // customer's gross and the platform's expense differ.
    expect(withCoupon.fee.amountMinor).toBe(withoutCoupon.fee.amountMinor);
    expect(withCoupon.providerNet.amountMinor).toBe(withoutCoupon.providerNet.amountMinor);
    expect(withoutCoupon.promotionExpense.amountMinor).toBe(0);
  });

  it('is exactly the old two-credit split when there is no discount', () => {
    const omitted = FeeCalculator.splitCapture({
      gross: Money.base(10_000),
      platformFee: Money.base(1_000),
    });
    const explicitZero = FeeCalculator.splitCapture({
      gross: Money.base(10_000),
      platformFee: Money.base(1_000),
      discountTotal: Money.base(0),
    });

    // An absent discount and a zero discount are the same capture, and both reproduce the
    // pre-ADR-019 arithmetic — so no historical capture is reinterpreted.
    expect(omitted.providerNet.amountMinor).toBe(9_000);
    expect(omitted.promotionExpense.amountMinor).toBe(0);
    expect(explicitZero).toEqual(omitted);
  });

  it('rejects a negative discount rather than quietly paying the provider less', () => {
    expectApiError(
      () =>
        FeeCalculator.splitCapture({
          gross: Money.base(10_000),
          platformFee: Money.base(1_000),
          discountTotal: Money.base(-500),
        }),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a discount in a different currency from the gross', () => {
    expectApiError(
      () =>
        FeeCalculator.splitCapture({
          gross: Money.of(10_000, 'ETB'),
          platformFee: Money.of(1_000, 'ETB'),
          discountTotal: Money.of(1_000, 'USD'),
        }),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});
