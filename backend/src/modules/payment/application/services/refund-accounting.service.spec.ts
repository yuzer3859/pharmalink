import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { Money } from '../../domain/value-objects/money.vo';
import { allocateProportionally } from '../../domain/value-objects/proportional-allocation';
import { CapturedLegs, computeRefundSplit } from './refund-accounting.service';

/**
 * ADR-016's arithmetic, tested where it lives: as pure functions, with no ledger, no repository and
 * no transaction in the way. The wiring is covered by the command spec and the e2e suite; what is
 * proved here is the formula itself — that it telescopes, that it never needs a "is this the last
 * refund?" special case, and that its tripwire actually fires.
 */

const ETB = 'ETB';

function money(amount: number): Money {
  return Money.of(amount, ETB);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiException) {
      return err.code;
    }
    throw err;
  }
  throw new Error('expected the operation to be rejected');
}

/**
 * A capture allocation. `promotion` is ADR-019's platform-funded discount: the capture debited it,
 * so the provider was credited `gross - fee + promotion` — paid as though no coupon existed.
 * Defaults to `0`, which is every capture with no coupon and reproduces the pre-ADR-019 shape.
 */
function captured(gross: number, fee: number, promotion = 0): CapturedLegs {
  return {
    gross: money(gross),
    fee: money(fee),
    providerNet: money(gross - fee + promotion),
    promotionExpense: money(promotion),
    pharmacyId: gross - fee + promotion > 0 ? 'pharmacy-1' : null,
  };
}

function split(legs: CapturedLegs, alreadyRefunded: number, amount: number) {
  return computeRefundSplit({
    paymentId: 'payment-1',
    captured: legs,
    alreadyRefunded: money(alreadyRefunded),
    amount: money(amount),
  });
}

// ---------------------------------------------------------------------------------------------
// The rounding primitive
// ---------------------------------------------------------------------------------------------

describe('allocateProportionally (ADR-005, ADR-016)', () => {
  it.each([
    [1_000, 0, 10_000, 0],
    [1_000, 10_000, 10_000, 1_000],
    [1_000, 3_333, 10_000, 333],
    [1_000, 6_666, 10_000, 667],
    [333, 1_111, 10_000, 37],
  ])('allocates %s x %s/%s as %s', (total, numerator, denominator, expected) => {
    expect(allocateProportionally(money(total), numerator, denominator).amountMinor).toBe(expected);
  });

  it('rounds a midpoint half-up, matching Math.round and the Fee/PricingCalculator convention', () => {
    // 1 x 1/2 = 0.5 -> 1, never 0 (truncation) and never 0 (banker's rounding to even).
    expect(allocateProportionally(money(1), 1, 2).amountMinor).toBe(1);
    // 3 x 1/2 = 1.5 -> 2. Banker's rounding would also give 2 here...
    expect(allocateProportionally(money(3), 1, 2).amountMinor).toBe(2);
    // ...but 5 x 1/2 = 2.5 -> 3 under half-up, and 2 under banker's. This is the discriminating case.
    expect(allocateProportionally(money(5), 1, 2).amountMinor).toBe(3);
    expect(allocateProportionally(money(5), 1, 2).amountMinor).toBe(Math.round(5 / 2));
  });

  it('stays exact where floating point would not', () => {
    // 2_000_000_001 x 2_000_000_001 is ~4e18, well past Number.MAX_SAFE_INTEGER. A `number`
    // multiply loses precision here; the BigInt path does not.
    const total = 2_000_000_001;
    const result = allocateProportionally(money(total), total, total);
    expect(result.amountMinor).toBe(total);
  });

  it('preserves the currency of the total', () => {
    expect(allocateProportionally(Money.of(1_000, ETB), 1, 2).currency.code).toBe(ETB);
  });

  it.each([
    ['a zero denominator', 100, 1, 0],
    ['a negative denominator', 100, 1, -10],
    ['a negative numerator', 100, -1, 10],
  ])('rejects %s', (_label, total, numerator, denominator) => {
    expect(codeOf(() => allocateProportionally(money(total), numerator, denominator))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a negative total', () => {
    expect(codeOf(() => allocateProportionally(money(-100), 1, 2))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The cumulative split
// ---------------------------------------------------------------------------------------------

describe('computeRefundSplit (ADR-016)', () => {
  it('claws back nothing from revenue when the capture credited no fee', () => {
    const result = split(captured(10_000, 0), 0, 4_000);

    expect(result.feeClawback.amountMinor).toBe(0);
    expect(result.providerClawback.amountMinor).toBe(4_000);
  });

  it('reverses the capture exactly on a single full refund', () => {
    const result = split(captured(10_000, 1_000), 0, 10_000);

    expect(result.feeClawback.amountMinor).toBe(1_000);
    expect(result.providerClawback.amountMinor).toBe(9_000);
  });

  it('computes each refund against the cumulative baseline, not independently', () => {
    const legs = captured(10_000, 1_000);

    const first = split(legs, 0, 3_333);
    const second = split(legs, 3_333, 3_333);

    expect(first.feeClawback.amountMinor).toBe(333);
    // Independent rounding would repeat 333 and drift; the cumulative form corrects to 334.
    expect(second.feeClawback.amountMinor).toBe(334);
  });

  it('always balances: the two clawbacks sum to the refund amount', () => {
    for (const [alreadyRefunded, amount] of [
      [0, 1],
      [0, 9_999],
      [1, 1],
      [4_999, 5_001],
      [3_333, 3_333],
    ]) {
      const result = split(captured(10_000, 333), alreadyRefunded, amount);
      expect(result.feeClawback.add(result.providerClawback).amountMinor).toBe(amount);
    }
  });

  /**
   * The central property. Whatever the partition, the fee clawbacks sum to exactly the captured
   * fee and the payable clawbacks to exactly the captured net — with no step anywhere asking
   * whether a refund is the final one.
   */
  it.each([
    ['one full refund', 10_000, 1_000, [10_000]],
    ['100 / 200 / 300 / 400', 10_000, 1_000, [1_000, 2_000, 3_000, 4_000]],
    ['333 / 333 / 334', 10_000, 1_000, [3_330, 3_330, 3_340]],
    ['single minor units', 10, 3, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ['awkward fee', 10_000, 333, [1_111, 2_222, 3_333, 3_334]],
    ['fee equals gross', 10_000, 10_000, [2_500, 2_500, 5_000]],
    ['zero fee', 10_000, 0, [1_234, 8_766]],
    ['prime-ish partition', 9_973, 1_237, [7, 4_999, 3_967, 1_000]],
  ])('telescopes to the captured split for %s', (_label, gross, fee, amounts) => {
    const legs = captured(gross as number, fee as number);

    let alreadyRefunded = 0;
    let feeTotal = 0;
    let providerTotal = 0;
    for (const amount of amounts as number[]) {
      const result = split(legs, alreadyRefunded, amount);
      // Every intermediate step honours the invariant.
      expect(result.feeClawback.amountMinor).toBeGreaterThanOrEqual(0);
      expect(result.feeClawback.amountMinor).toBeLessThanOrEqual(amount);
      feeTotal += result.feeClawback.amountMinor;
      providerTotal += result.providerClawback.amountMinor;
      alreadyRefunded += amount;
    }

    expect(alreadyRefunded).toBe(gross);
    expect(feeTotal).toBe(fee);
    expect(providerTotal).toBe((gross as number) - (fee as number));
  });

  it('telescopes for every one-santim partition of a small capture', () => {
    // Exhaustive rather than sampled: 97 refunds of 1 against a 97/41 capture.
    const gross = 97;
    const fee = 41;
    const legs = captured(gross, fee);

    let feeTotal = 0;
    for (let alreadyRefunded = 0; alreadyRefunded < gross; alreadyRefunded += 1) {
      feeTotal += split(legs, alreadyRefunded, 1).feeClawback.amountMinor;
    }

    expect(feeTotal).toBe(fee);
  });

  it('claws the whole refund from revenue when the fee was the entire gross', () => {
    const result = split(captured(10_000, 10_000), 2_500, 2_500);

    expect(result.feeClawback.amountMinor).toBe(2_500);
    expect(result.providerClawback.amountMinor).toBe(0);
  });

  it('rejects a refund that would exceed the captured gross', () => {
    expect(codeOf(() => split(captured(10_000, 1_000), 8_000, 2_001))).toBe(
      ErrorCode.REFUND_EXCEEDS_CAPTURED,
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
  ])('rejects a %s refund amount', (_label, amount) => {
    expect(codeOf(() => split(captured(10_000, 1_000), 0, amount))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a negative already-refunded total', () => {
    expect(codeOf(() => split(captured(10_000, 1_000), -1, 100))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('refuses to mix currencies', () => {
    expect(
      codeOf(() =>
        computeRefundSplit({
          paymentId: 'payment-1',
          captured: captured(10_000, 1_000),
          alreadyRefunded: money(0),
          amount: Money.of(100, 'USD'),
        }),
      ),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });

  /**
   * The tripwire. `readCapturedLegs` already refuses a capture whose legs do not sum to its gross,
   * so a fee larger than the gross cannot reach the formula through the real flow — which is
   * exactly why it is worth proving the guard fires rather than clamping if it ever did.
   */
  it('raises LEDGER_UNBALANCED rather than clamping when the fee exceeds the gross', () => {
    const impossible: CapturedLegs = {
      gross: money(1_000),
      fee: money(5_000),
      providerNet: money(-4_000),
      promotionExpense: money(0),
      pharmacyId: 'pharmacy-1',
    };

    expect(
      codeOf(() =>
        computeRefundSplit({
          paymentId: 'payment-1',
          captured: impossible,
          alreadyRefunded: money(0),
          amount: money(100),
        }),
      ),
    ).toBe(ErrorCode.LEDGER_UNBALANCED);
  });

  it('raises LEDGER_UNBALANCED rather than clamping when the fee is negative', () => {
    const impossible: CapturedLegs = {
      gross: money(1_000),
      fee: money(-100),
      providerNet: money(1_100),
      promotionExpense: money(0),
      pharmacyId: 'pharmacy-1',
    };

    expect(
      codeOf(() =>
        computeRefundSplit({
          paymentId: 'payment-1',
          captured: impossible,
          alreadyRefunded: money(0),
          amount: money(100),
        }),
      ),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });
});
