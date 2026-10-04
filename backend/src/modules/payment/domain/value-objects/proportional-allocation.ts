import { PaymentErrors } from '../errors';
import { Money } from './money.vo';

/**
 * Allocates `total` in the proportion `numerator / denominator`, rounded **half-up** to whole minor
 * units (ADR-005, ADR-016).
 *
 * ## Why this exists rather than `Math.round(total * n / d)`
 *
 * The arithmetic is done in `BigInt`, and that is not defensiveness — it is required. Every money
 * column is a Postgres `int4`, so `total` and `numerator` can each reach `2_147_483_647`; their
 * product reaches ~4.6e18, an order of magnitude past `Number.MAX_SAFE_INTEGER` (~9.0e15). A
 * `number` multiply would silently lose precision on large captures and produce a clawback that is
 * off by whole santim, which the ledger would then faithfully record. `BigInt` makes the
 * intermediate exact; the *result* is bounded by `total` and so always converts back safely.
 *
 * ## The rounding convention
 *
 * Half-up, expressed exactly as `floor((2·T·n + d) / (2·d))` — no floating point, no epsilon, no
 * banker's rounding, no truncation. This is deliberately the same convention `Fee.applyTo` and
 * Module 06's `PricingCalculator` use (`Math.round`, which for non-negative values is half-up), so
 * the platform fee a customer is quoted, the fee credited at capture, and the fee clawed back at
 * refund all round the same way. It is a *separate function* rather than a reuse of `Fee.applyTo`
 * because that method applies a fractional *rate* to a base, whereas this apportions an
 * already-decided integer amount across an integer ratio — same convention, different operation.
 *
 * ## Where the caller's correctness actually comes from
 *
 * This function only rounds one ratio. What makes ADR-016's clawback sequence exact is that the
 * caller applies it to the **cumulative** refunded amount and subtracts the previous cumulative
 * result, so the roundings telescope and the final refund absorbs the residue by construction. See
 * `computeRefundSplit`.
 */
export function allocateProportionally(
  total: Money,
  numerator: number,
  denominator: number,
): Money {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw PaymentErrors.validation('A proportional allocation numerator must be a non-negative integer.', {
      field: 'numerator',
      value: numerator,
    });
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw PaymentErrors.validation('A proportional allocation denominator must be a positive integer.', {
      field: 'denominator',
      value: denominator,
    });
  }
  if (total.isNegative) {
    throw PaymentErrors.validation('A proportional allocation total must not be negative.', {
      field: 'total',
      value: total.amountMinor,
    });
  }

  const t = BigInt(total.amountMinor);
  const n = BigInt(numerator);
  const d = BigInt(denominator);

  // floor((2·T·n + d) / (2·d)) — exact half-up for non-negative operands. BigInt division truncates
  // toward zero, which equals floor here because every operand is non-negative.
  const allocated = (2n * t * n + d) / (2n * d);

  return Money.of(Number(allocated), total.currency);
}
