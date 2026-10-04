import { CouponProps } from '../entities/coupon.entity';
import { DiscountType } from '../enums';
import { PaymentErrors } from '../errors';
import { CouponScope } from '../value-objects/coupon-scope.vo';
import { Money } from '../value-objects/money.vo';
import { allocateProportionally } from '../value-objects/proportional-allocation';

/**
 * One priced line of a cart or order, with everything the three scope dimensions need. Assembled
 * by the application layer from real Module 03/06 data — never from a request body.
 */
export interface DiscountableLine {
  productId: string;
  /** The categories the product actually belongs to (Module 03 `product_categories`). */
  categoryIds: readonly string[];
  /** `null` when nothing has chosen a pharmacy yet — a cart before checkout. */
  pharmacyId: string | null;
  /** `unitPrice × quantity` in ETB minor units, already computed by the caller. */
  lineTotal: number;
}

/** Usage already recorded against a coupon — derived from `coupon_redemptions`, never a counter. */
export interface CouponUsage {
  global: number;
  perUser: number;
}

/** Why a coupon does not apply. Mapped 1:1 onto §12's three coupon error codes by the caller. */
export type CouponRejectionReason =
  | 'NOT_FOUND'
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'MIN_SPEND_NOT_MET'
  | 'NOT_IN_SCOPE'
  | 'PHARMACY_SCOPE_UNRESOLVABLE'
  | 'GLOBAL_LIMIT_REACHED'
  | 'PER_USER_LIMIT_REACHED';

export interface CouponRejected {
  valid: false;
  reason: CouponRejectionReason;
  message: string;
  details?: Record<string, unknown>;
}

export interface CouponAccepted {
  valid: true;
  discountAmount: number;
  /** Σ of the line totals the coupon may discount — what the discount was computed against. */
  eligibleSubtotal: number;
  currency: string;
}

export type CouponEvaluation = CouponAccepted | CouponRejected;

export interface EvaluateCouponInput {
  coupon: CouponProps;
  lines: readonly DiscountableLine[];
  usage: CouponUsage;
  now?: Date;
  currency?: string;
}

const BASE_CURRENCY = 'ETB';
const PERCENT_DENOMINATOR = 100;

/**
 * `CouponValidator` (§10's own `domain/services/` listing, F-CPN-01/F-CPN-02) — the single place
 * that decides whether a coupon applies and, if so, for how much.
 *
 * **Pure.** No repository, no clock of its own, no I/O: the caller supplies the coupon, the priced
 * lines, the already-recorded usage and the current time. That is what lets validation
 * (`POST /coupons/validate`) and application (`ApplyCouponCommand`) share one implementation
 * instead of two that can disagree about what a customer was promised and what they were given.
 *
 * ## What the discount is computed against
 *
 * The **eligible subtotal** — Σ of the line totals that fall inside the coupon's scope — and
 * nothing else. Specifically not the delivery fee, not out-of-scope lines, and not the platform
 * fee. Discounting a delivery fee would be inventing a rule the design does not state, and §7's
 * scope exists precisely so a coupon can be narrower than the cart.
 *
 * ## Rounding
 *
 * `PERCENT` is `round(eligibleSubtotal × value / 100)`, half-up, through the same integer-exact
 * `allocateProportionally` primitive ADR-016 uses for the refund fee clawback. No floating point
 * anywhere: `eligibleSubtotal × value` can reach ~2×10^11 for a large cart, and while that is
 * still inside the safe-integer range today, the BigInt path costs nothing and removes the
 * question. Half-up matches `Fee.applyTo` and Module 06's `PricingCalculator`, so a discount
 * quoted at validation and a discount applied at checkout round identically.
 *
 * ## What this service deliberately does not decide
 *
 * Whether the platform commission is computed before or after the discount, and who ends up
 * funding the discount. That ordering is Module 06's — `PricingCalculator` already computes
 * `platformFee` from the *undiscounted* subtotal and then subtracts `discountTotal` from the grand
 * total — and this service never sees a platform fee at all. It answers one question: how much is
 * this coupon worth on these lines. ADR-019 records the funding question as open and makes the
 * `discount <= eligible subtotal` clamp below load-bearing: it is what keeps `PROVIDER_PAYABLE`
 * non-negative once a commission is configured.
 */
export const CouponValidator = {
  /**
   * The eligible subtotal for a coupon's scope. Exposed separately because a caller sometimes
   * needs it without a full evaluation (a client showing "this coupon applies to 2 of 5 items").
   */
  eligibleSubtotal(scope: CouponScope, lines: readonly DiscountableLine[]): number {
    return lines
      .filter((line) => scope.matches(line))
      .reduce((total, line) => total + line.lineTotal, 0);
  },

  /**
   * The full decision. Returns a value rather than throwing, because §9.5's response shape is
   * `{ valid, discountAmount, reason? }` — a coupon that does not apply is a normal answer to a
   * validation request, not an exception. The *application* command turns a rejection into an
   * `ApiException` when it is applying rather than validating.
   */
  evaluate(input: EvaluateCouponInput): CouponEvaluation {
    const { coupon } = input;
    const now = input.now ?? new Date();
    const currency = input.currency ?? BASE_CURRENCY;

    if (!coupon.isActive) {
      return reject('INACTIVE', 'This coupon is not available.');
    }
    if (coupon.startsAt && now.getTime() < coupon.startsAt.getTime()) {
      return reject('NOT_STARTED', 'This coupon is not valid yet.', {
        startsAt: coupon.startsAt,
      });
    }
    if (coupon.expiresAt && now.getTime() >= coupon.expiresAt.getTime()) {
      return reject('EXPIRED', 'This coupon has expired.', { expiresAt: coupon.expiresAt });
    }

    // Limits are checked before the arithmetic: an exhausted coupon should say so, not quote a
    // discount it cannot give. Both counts are derived from APPLIED redemption rows.
    if (coupon.usageLimitGlobal !== null && input.usage.global >= coupon.usageLimitGlobal) {
      return reject('GLOBAL_LIMIT_REACHED', 'This coupon has reached its usage limit.', {
        limit: coupon.usageLimitGlobal,
        used: input.usage.global,
      });
    }
    if (coupon.usageLimitPerUser !== null && input.usage.perUser >= coupon.usageLimitPerUser) {
      return reject(
        'PER_USER_LIMIT_REACHED',
        'You have already used this coupon the maximum number of times.',
        { limit: coupon.usageLimitPerUser, used: input.usage.perUser },
      );
    }

    const scope = CouponScope.parse(coupon.scope);

    // A pharmacy-scoped coupon cannot be decided against lines that have no pharmacy yet. Saying
    // so explicitly is the honest answer; treating unknown as a match would quote a discount the
    // order may not be entitled to once a pharmacy is chosen.
    if (scope.requiresPharmacy && input.lines.some((line) => line.pharmacyId === null)) {
      return reject(
        'PHARMACY_SCOPE_UNRESOLVABLE',
        'This coupon applies to specific pharmacies and can only be applied once a pharmacy has been selected.',
      );
    }

    const eligibleSubtotal = CouponValidator.eligibleSubtotal(scope, input.lines);
    if (eligibleSubtotal <= 0) {
      return reject('NOT_IN_SCOPE', 'This coupon does not apply to the items in your cart.');
    }

    // §7's `min_spend` is a threshold on what the customer is spending on eligible items — not on
    // the whole cart. Measuring it against the full cart would let an unrelated expensive item
    // unlock a coupon for a cheap one it was never meant to cover.
    if (coupon.minSpend !== null && eligibleSubtotal < coupon.minSpend) {
      return reject('MIN_SPEND_NOT_MET', 'This coupon requires a higher spend.', {
        minSpend: coupon.minSpend,
        eligibleSubtotal,
      });
    }

    const discountAmount = computeDiscount(coupon, eligibleSubtotal, currency);

    return { valid: true, discountAmount, eligibleSubtotal, currency };
  },
};

/**
 * The discount itself, clamped in the one direction that matters.
 *
 * Three bounds apply, in order: the coupon's own value, its `maxDiscount` cap where configured,
 * and the eligible subtotal. The last is not a cap for convenience — it is the invariant that
 * stops a coupon creating a negative payable total (`discount <= eligible subtotal`), and it binds
 * whenever a `FIXED` coupon is worth more than the items it covers.
 */
function computeDiscount(coupon: CouponProps, eligibleSubtotal: number, currency: string): number {
  const base = Money.of(eligibleSubtotal, currency);

  let discount: Money;
  if (coupon.discountType === DiscountType.PERCENT) {
    // Half-up, integer-exact. Never `Math.round(subtotal * value / 100)` on floats.
    discount = allocateProportionally(base, coupon.value, PERCENT_DENOMINATOR);
  } else if (coupon.discountType === DiscountType.FIXED) {
    discount = Money.of(coupon.value, currency);
  } else {
    throw PaymentErrors.validation('Unknown coupon discount type.', {
      field: 'discountType',
      value: coupon.discountType,
    });
  }

  if (coupon.maxDiscount !== null) {
    const cap = Money.of(coupon.maxDiscount, currency);
    if (discount.isGreaterThan(cap)) {
      discount = cap;
    }
  }

  // The floor of the whole feature: a coupon may never discount more than the lines it applies to.
  if (discount.isGreaterThan(base)) {
    discount = base;
  }

  return discount.amountMinor;
}

function reject(
  reason: CouponRejectionReason,
  message: string,
  details?: Record<string, unknown>,
): CouponRejected {
  return { valid: false, reason, message, details };
}
