import { PaymentErrors } from '../errors';
import { Fee } from '../value-objects/fee.vo';
import { Money } from '../value-objects/money.vo';

/**
 * The three legs of a capture posting (§11.3): what the gateway owes the platform, what the
 * platform keeps, and what the platform owes the provider.
 */
export interface CaptureSplit {
  /** Total collected — debited to `GATEWAY_CLEARING`. */
  gross: Money;
  /** Platform commission — credited to `PLATFORM_REVENUE` (BRULE-23). */
  fee: Money;
  /**
   * What the pharmacy is owed — credited to `PROVIDER_PAYABLE`. Under ADR-019's platform funding
   * this is `gross - fee + promotionExpense`: the pharmacy is paid **as if no coupon existed**,
   * so a discount never reduces it.
   */
  providerNet: Money;
  /**
   * The platform-funded coupon discount — debited to `PROMOTION_EXPENSE` (ADR-019). Zero when the
   * order carried no discount, which is every order today.
   */
  promotionExpense: Money;
}

/**
 * `FeeCalculator` (§10 `domain/services/FeeCalculator`) — the pure arithmetic behind §11.3's
 * capture posting. No I/O, no configuration reads, no account knowledge: it is given the amount
 * being captured and the fee that applies, and it produces a split that is guaranteed to balance.
 *
 * ## Where the fee comes from, and the open question behind it
 *
 * The fee is **`Order.platformFee`** — the commission Module 06 computed in its checkout
 * transaction and *already charged the customer* (it is a component of `grandTotal`). Module 07
 * reads that number rather than re-deriving a percentage at capture time. Two reasons, both
 * money-safety rather than convenience:
 *
 *  1. Capture happens at fulfillment, potentially days after checkout. Re-deriving the fee from a
 *     configured rate would credit `PLATFORM_REVENUE` an amount the customer never paid the
 *     moment that rate changed, and the capture posting would no longer reconcile against the
 *     order the customer agreed to.
 *  2. It keeps one formula in charge of one number. `PricingCalculator` (Module 06) owns what the
 *     customer is charged; duplicating a fee formula here would create a second source of truth
 *     for the same value — the exact failure mode §5's "the platform is a ledger" principle
 *     exists to prevent.
 *
 * §8 says fees are "configurable (NFR-MAINT-03)" and §11.3 names a `FeeCalculator` at capture.
 * That is satisfied here: this *is* that calculator, and it applies the configured fee — the
 * configuration simply lives at the point of sale, where the customer was quoted it.
 *
 * **Unresolved, and deliberately not invented here:** the design's own Open Question 3 leaves the
 * production fee model undecided ("flat %, per-category %, or fixed+%; who pays delivery fee
 * accounting-wise"). Concretely, today: `orders.platformFeePercent` is read through `IConfigPort`
 * by Module 06 but is not declared in `env.validation.ts`, so it resolves to `0` — every order
 * currently stores `platformFee = 0`, and a capture therefore credits `PLATFORM_REVENUE` nothing
 * and `PROVIDER_PAYABLE` the full gross. That is the correct behaviour for a zero fee, not a bug
 * in this calculator, and it starts producing real revenue the moment the rate is configured. The
 * second half of that open question is also still open: the delivery fee flows to
 * `PROVIDER_PAYABLE`. Deciding otherwise is a product/finance call, and inventing a delivery-fee
 * leg here would be exactly the kind of unasked-for business rule a money module must not add.
 *
 * ## Coupons are funded by the platform (ADR-019, resolved)
 *
 * `PricingCalculator` computes `platformFee` from the **undiscounted** subtotal and subtracts the
 * discount from what the customer pays, so `gross` arrives here already net of it. ADR-019 now
 * resolves who absorbs that discount: **the platform**. Concretely, for a discount `D`:
 *
 * ```
 * gross       = subtotal + deliveryFee + platformFee - D     (what the customer actually paid)
 * fee         = platformFee                                  (unchanged — the historical figure)
 * providerNet = gross - fee + D = subtotal + deliveryFee     (as if there had been no coupon)
 * promotion   = D                                            (the platform's expense)
 * ```
 *
 * The pharmacy is therefore paid exactly what it would have been paid without the coupon, and the
 * platform's net position is `fee - D`. The expense is **not** netted out of `PLATFORM_REVENUE`:
 * commission earned and promotional spend are two different facts, and merging them would make
 * revenue unreportable. It becomes its own `PROMOTION_EXPENSE` debit leg instead, which is also
 * the only way the posting can balance — see `CaptureAccountingService`.
 */
export const FeeCalculator = {
  /**
   * Splits a captured amount into its provider-payable and platform-revenue legs.
   *
   * Uses the `Fee` value object so the existing guards apply: same currency, non-negative, and a
   * fee that cannot exceed the amount it is charged on (which would otherwise post a negative
   * `PROVIDER_PAYABLE` credit). The fee is expressed as `Fee.of({ fixed })` because it is an
   * already-computed amount, not a rate to apply — `Fee`'s percentage component exists for a
   * future caller that genuinely computes at capture time.
   */
  splitCapture(input: {
    gross: Money;
    platformFee: Money;
    /**
     * `Order.discountTotal` — the platform-funded coupon discount already subtracted from
     * `gross` by `PricingCalculator`. Optional so every existing caller keeps its meaning: absent
     * is a capture with no discount, which is arithmetically identical to the pre-ADR-019 split.
     */
    discountTotal?: Money;
  }): CaptureSplit {
    const { gross, platformFee } = input;

    if (!gross.isPositive) {
      throw PaymentErrors.validation('A capture amount must be positive.', {
        field: 'amount',
        value: gross.amountMinor,
      });
    }
    gross.assertSameCurrency(platformFee);

    const promotionExpense = input.discountTotal ?? Money.zero(gross.currency);
    gross.assertSameCurrency(promotionExpense);
    if (promotionExpense.isNegative) {
      throw PaymentErrors.validation('A discount total must not be negative.', {
        field: 'discountTotal',
        value: promotionExpense.amountMinor,
      });
    }

    // `Fee.applyTo` re-validates non-negativity and rejects a fee larger than the gross. That
    // bound still holds under a discount because `CouponValidator` clamps a discount to the
    // eligible subtotal, which keeps `grandTotal >= platformFee` (ADR-019 clause 3).
    const fee = Fee.of({ fixed: platformFee }).applyTo(gross);

    // ADR-019, platform-funded: the provider is made whole as though no coupon had been used, and
    // the platform carries the difference as an expense. `gross` is what the customer actually
    // paid (already net of the discount), so adding the discount back is what "not reduced by the
    // coupon" means arithmetically — `gross - fee + D === subtotal + deliveryFee`.
    const providerNet = gross.subtract(fee).add(promotionExpense);

    // The invariant the ledger posting depends on: debits (`gross` + the promotion expense) equal
    // credits (`providerNet` + `fee`). `LedgerService` enforces balance again on the entries
    // themselves; this asserts it on the arithmetic that produces them, so a defect is caught at
    // its source rather than as an opaque LEDGER_UNBALANCED further downstream.
    if (!providerNet.add(fee).equals(gross.add(promotionExpense))) {
      throw PaymentErrors.validation('Capture split does not reconcile to the gross amount.', {
        gross: gross.amountMinor,
        fee: fee.amountMinor,
        providerNet: providerNet.amountMinor,
        promotionExpense: promotionExpense.amountMinor,
      });
    }

    return { gross, fee, providerNet, promotionExpense };
  },
};
