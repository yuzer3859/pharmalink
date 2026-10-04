import { Injectable } from '@nestjs/common';
import {
  ApplyCouponCommand,
  ApplyCouponInput,
  ApplyCouponResult,
} from '../../commands/apply-coupon.command';
import {
  ReverseCouponCommand,
  ReverseCouponInput,
  ReverseCouponResult,
} from '../../commands/reverse-coupon.command';
import {
  CouponValidationView,
  ValidateCouponInput,
  ValidateCouponQuery,
} from '../../queries/validate-coupon.query';

export const COUPON_PORT = Symbol('COUPON_PORT');

/**
 * Module 07's exported coupon contract, consumed in-process by other modules via Nest DI, never
 * over HTTP — the same inbound-port shape as `IPaymentAuthorizationPort` and `IWalletPort`
 * (ADR-002).
 *
 * **This is the seam F-CPN-02 and F-CPN-03 will be satisfied through**, and it is deliberately the
 * smallest thing that integration will need rather than a speculative coupon facade. Module 06's
 * checkout saga has no coupon step today — `CheckoutCommand`, the checkout DTO, the cart flow and
 * order pricing are all untouched by the coupon slice — so nothing consumes this yet;
 * `PaymentModule` exports it so the integration task can inject it without new wiring.
 *
 * The three methods are the three moments a checkout cares about:
 *
 *  - `validate` — quote a discount without consuming anything (a customer typing a code);
 *  - `apply` — consume a usage against a committed order, atomically (checkout);
 *  - `reverse` — give that usage back (cancellation, F-CPN-03).
 *
 * ## The three decisions that govern the integration
 *
 *  - **ADR-019 — resolved: the platform funds the discount.** The pharmacy is credited
 *    `grandTotal - fee + discountTotal`, i.e. exactly what an un-discounted order would have paid
 *    it, and the discount is booked as a `PROMOTION_EXPENSE` leg at capture. Nothing in this port
 *    depends on that: `apply` returns a `discountAmount` and says nothing about how it composes
 *    into an order's totals. What the integration must honour is that the figure it quotes has to
 *    reach Module 07 as `Order.discountTotal` — capture reads only that, never `coupon_redemptions`
 *    — so the order's `discountTotal` and its redemption must be written for the same amount.
 *  - **ADR-020 — evaluate after matching.** Module 06 §6's saga chooses the pharmacy at step 3 and
 *    computes totals at step 5, so every scope dimension is decidable by the time `apply` runs.
 *    `validate` is a pre-checkout preview and answers `PHARMACY_SCOPE_UNRESOLVABLE` for a
 *    pharmacy-scoped coupon; that is provisional by design.
 *  - **ADR-021 — one coupon per order.** The integration must refuse a second coupon on an order
 *    that already holds an `APPLIED` redemption. `ApplyCouponCommand` does **not** enforce this
 *    yet — it rejects only a repeat of the *same* coupon — so the check belongs to the caller until
 *    that follow-up lands.
 *
 * ## What the integration still has to build — this contract is not sufficient as it stands
 *
 * §11.7.1 of the design carries the checked-against-the-code version; the three that change *this*
 * file's shape or its caller's obligations:
 *
 *  1. **`validate` cannot answer checkout's question.** `ValidateCouponInput` is
 *     `{ customerUserId, code, cartTotal? }` and the query always scores the caller's active cart,
 *     whose lines carry `pharmacyId: null`. A step-5 caller has already matched a pharmacy and
 *     already re-priced its lines, so it needs to quote against *those* — otherwise it gets
 *     `PHARMACY_SCOPE_UNRESOLVABLE` for precisely the coupon ADR-020 says is decidable there. The
 *     extension is **in-process only**: `POST /coupons/validate` must keep its cart-only shape,
 *     because a pharmacy accepted over HTTP is the client-chosen pharmacy ADR-020 forbids.
 *  2. **`apply` cannot join the order-creation transaction.** No inbound port here takes a `tx`,
 *     and ADR-014 explains why: a single Prisma `$transaction` cannot span two module-owned
 *     unit-of-work implementations without collapsing ADR-001/ADR-002's boundary. `apply` opens its
 *     own `Serializable` transaction, so it runs *after* the order commits, over ADR-014's accepted
 *     eventual-consistency seam. The caller owns the window that opens if it fails — an order with
 *     `discountTotal > 0` and no redemption means the customer paid the discount and the code is
 *     still spendable. Retry or compensate; do not ignore it.
 *  3. **The one-coupon-per-order check is the caller's** until it moves in here — see ADR-021 above.
 *
 * The ADR-019 funding gate that previously came before all three is **lifted**: the decision is
 * made (platform-funded) and implemented, so a non-zero `orders.platformFeePercent` no longer
 * blocks the integration. The fourth obligation it leaves behind is the `Order.discountTotal`
 * one noted above — writing a redemption without the matching `discountTotal` gives the customer
 * no discount and the platform no expense.
 *
 * See `architecture/module-07-payment-wallet.md` §11.7 for the full integration contract.
 */
export interface ICouponPort {
  validate(input: ValidateCouponInput): Promise<CouponValidationView>;
  apply(input: ApplyCouponInput): Promise<ApplyCouponResult>;
  reverse(input: ReverseCouponInput): Promise<ReverseCouponResult>;
}

/**
 * Implements `ICouponPort` as a thin facade over the already-tested commands and query — a 1:1,
 * unmodified delegation owning no logic of its own, exactly like `WalletPortAdapter`. The facade
 * exists only so the exported token is bound to an interface rather than to concrete classes.
 */
@Injectable()
export class CouponPortAdapter implements ICouponPort {
  constructor(
    private readonly validateCouponQuery: ValidateCouponQuery,
    private readonly applyCouponCommand: ApplyCouponCommand,
    private readonly reverseCouponCommand: ReverseCouponCommand,
  ) {}

  validate(input: ValidateCouponInput): Promise<CouponValidationView> {
    return this.validateCouponQuery.execute(input);
  }

  apply(input: ApplyCouponInput): Promise<ApplyCouponResult> {
    return this.applyCouponCommand.execute(input);
  }

  reverse(input: ReverseCouponInput): Promise<ReverseCouponResult> {
    return this.reverseCouponCommand.execute(input);
  }
}
