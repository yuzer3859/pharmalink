import { Inject, Injectable } from '@nestjs/common';
import {
  COUPON_REPOSITORY,
  ICouponRepository,
} from '../../domain/repositories/coupon.repository';
import { CouponEvaluation, CouponValidator } from '../../domain/services/coupon-validator';
import { CouponCode } from '../../domain/value-objects/coupon-code.vo';
import { CouponLineResolver } from '../services/coupon-line-resolver.service';

/** One already-priced checkout line, as Module 06 will commit it to `order_lines`. */
export interface CheckoutQuoteLine {
  catalogProductId: string;
  quantity: number;
  /** Module 06's fresh Module 03 price for this line — the price the order will be created at. */
  unitPrice: number;
}

/**
 * The checkout saga's own evaluation context — **in-process callers only** (ADR-020).
 *
 * `POST /coupons/validate` must never expose this. Its `pharmacyId` is Module 05's chosen match,
 * platform-determined data; accepted over HTTP it would become the client-chosen dispensing
 * pharmacy ADR-020 clause 3 forbids, and its `lines`/`unitPrice` would let a caller quote itself a
 * discount on a basket it does not have. `CouponValidateDto` carries neither field, so the only
 * way to populate this is a Nest-injected `COUPON_PORT` call from inside the process.
 */
export interface CheckoutQuoteContext {
  /** The pharmacy Module 05's matching chose, so a pharmacy-scoped coupon is decidable. */
  pharmacyId: string;
  lines: CheckoutQuoteLine[];
}

export interface ValidateCouponInput {
  /** Resolved from the access token by the caller — never from the request body. */
  customerUserId: string;
  code: string;
  /**
   * §9.5's `cartTotal` — the total the client is **displaying**. Purely an assertion: it is
   * compared against the server-computed subtotal and reported back, never used to compute a
   * discount. See {@link ValidateCouponQuery}.
   */
  cartTotal?: number | null;
  /**
   * Present only for the checkout saga. When set, the coupon is scored against **these** lines at
   * **this** pharmacy instead of the caller's active cart — see {@link ValidateCouponQuery}.
   */
  checkout?: CheckoutQuoteContext;
}

/** §9.5's documented response, `{ valid, discountAmount, reason? }`, plus what a client needs. */
export interface CouponValidationView {
  valid: boolean;
  /** `0` when the coupon does not apply — never `null`, so a client can always render a figure. */
  discountAmount: number;
  /** Machine-readable rejection reason; absent when `valid`. */
  reason?: string;
  /** Human-readable explanation; absent when `valid`. */
  message?: string;
  code: string;
  currency: string;
  /** The server's own subtotal for the caller's cart — what the discount was measured against. */
  cartSubtotal: number;
  /** Σ of the lines this coupon may discount. `0` when nothing is in scope. */
  eligibleSubtotal: number;
  /**
   * `true` when the client's asserted `cartTotal` disagreed with the server's subtotal. The
   * response is still authoritative; this flag tells the client its display is stale and it
   * should re-quote before checking out.
   */
  cartTotalMismatch?: boolean;
}

const BASE_CURRENCY = 'ETB';

/**
 * `POST /coupons/validate` (§9.5, F-CPN-02's validate half).
 *
 * A **query**, and named as one: §10's own folder layout lists `ValidateCoupon` under `queries/`,
 * and the reason is substantive rather than cosmetic. Validation must be side-effect free — no
 * redemption row, no usage consumed, no outbox event, no audit entry. A customer checking whether
 * a code is worth using has committed to nothing, and a row written here would spend a usage that
 * was never spent. `ApplyCouponCommand` is the thing that changes state.
 *
 * ## Nothing in the request decides the answer
 *
 * The coupon is scored against **the caller's real active cart**, resolved from their access
 * token's subject and priced from Module 03 — not against `items` from the body. §9.5's request
 * shape includes `cartTotal` and `items`, but treating them as inputs would let a client send one
 * expensive item to clear a `minSpend` and a different cheap one to be discounted, or quote
 * itself a discount on a cart it does not have. `cartTotal` is therefore compared and reported
 * (`cartTotalMismatch`), which is what a display assertion is for.
 *
 * ## Why a rejection is a `200`, not an error
 *
 * §9.5's response is `{ valid, discountAmount, reason? }` — "this coupon does not apply" is the
 * documented *successful* answer to a validation question, and a client renders it as a message
 * beside the field. §12's `COUPON_INVALID`/`COUPON_EXPIRED`/`COUPON_USAGE_EXCEEDED` are raised by
 * `ApplyCouponCommand`, where a coupon that does not apply genuinely prevents an operation.
 *
 * An unknown code returns `valid: false` with the same generic shape as a deactivated one, so the
 * endpoint cannot be used to enumerate which promotional codes exist.
 *
 * ## The checkout path, and why it cannot reuse the cart read
 *
 * ADR-020 makes checkout step 5 — *after* Module 05's matching — the authoritative evaluation
 * point, and the cart read above cannot serve it for two reasons. A cart line carries no pharmacy
 * (`forActiveCart` resolves every line with `pharmacyId: null`), so a pharmacy-scoped coupon would
 * answer `PHARMACY_SCOPE_UNRESOLVABLE` for precisely the coupon ADR-020 says is decidable there.
 * And checkout has already re-priced its lines from Module 03 inside its own request; re-reading
 * the cart here would score the coupon against a second read taken at a different instant than the
 * one the order is about to be committed at, so the quote and the order could disagree.
 *
 * So an in-process caller may pass {@link CheckoutQuoteContext}, and the coupon is scored against
 * those lines at that pharmacy. The prices come from the caller **because the caller is Module 06's
 * saga, holding the very figures it is about to freeze into `order_lines`** — this is not a
 * client-supplied basket, and it is unreachable over HTTP (see `CheckoutQuoteContext`). The
 * redemption that follows re-scores the committed `order_lines` through `forOrder`, so the two
 * figures are computed from the same data and any disagreement is a defect the caller can detect.
 */
@Injectable()
export class ValidateCouponQuery {
  constructor(
    @Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository,
    private readonly lines: CouponLineResolver,
  ) {}

  async execute(input: ValidateCouponInput): Promise<CouponValidationView> {
    const code = CouponCode.normalize(input.code);

    // The checkout saga supplies its own already-matched, already-repriced lines; everyone else
    // gets the cart preview. See the class doc for why these cannot be the same read.
    const resolved = input.checkout
      ? await this.lines.forCheckoutLines(input.checkout)
      : await this.lines.forActiveCart(input.customerUserId);
    const cartSubtotal = resolved?.subtotal ?? 0;
    const base = {
      code,
      currency: BASE_CURRENCY,
      cartSubtotal,
      ...(input.cartTotal !== undefined && input.cartTotal !== null
        ? { cartTotalMismatch: input.cartTotal !== cartSubtotal }
        : {}),
    };

    const coupon = code ? await this.coupons.findByCode(code) : null;
    if (!coupon) {
      // Deliberately indistinguishable from a deactivated coupon.
      return {
        ...base,
        valid: false,
        discountAmount: 0,
        eligibleSubtotal: 0,
        reason: 'NOT_FOUND',
        message: 'This coupon code is not valid.',
      };
    }

    if (!resolved || resolved.lines.length === 0) {
      return {
        ...base,
        valid: false,
        discountAmount: 0,
        eligibleSubtotal: 0,
        reason: 'NOT_IN_SCOPE',
        message: 'This coupon does not apply to the items in your cart.',
      };
    }

    // Usage is counted from APPLIED redemption rows, never a counter (F-CPN-02).
    const evaluation = CouponValidator.evaluate({
      coupon,
      lines: resolved.lines,
      usage: {
        global: await this.coupons.countAppliedForCoupon(coupon.id),
        perUser: await this.coupons.countAppliedForCouponAndUser(
          coupon.id,
          input.customerUserId,
        ),
      },
    });

    return { ...base, ...toView(evaluation) };
  }
}

function toView(
  evaluation: CouponEvaluation,
): Pick<
  CouponValidationView,
  'valid' | 'discountAmount' | 'eligibleSubtotal' | 'reason' | 'message'
> {
  if (evaluation.valid) {
    return {
      valid: true,
      discountAmount: evaluation.discountAmount,
      eligibleSubtotal: evaluation.eligibleSubtotal,
    };
  }
  return {
    valid: false,
    discountAmount: 0,
    eligibleSubtotal: 0,
    reason: evaluation.reason,
    message: evaluation.message,
  };
}
