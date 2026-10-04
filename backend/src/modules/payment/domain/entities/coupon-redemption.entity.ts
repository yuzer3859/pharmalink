import { RedemptionStatus } from '../enums';
import { PaymentErrors } from '../errors';

/**
 * The persisted shape of §7's `coupon_redemptions` row, field-for-field. §7 lists no
 * `reversedAt`, so none is added — the audit log records when and by whom (§13), which is where
 * that question belongs.
 */
export interface CouponRedemptionProps {
  id: string;
  couponId: string;
  userId: string;
  orderId: string;
  discountAmount: number;
  status: RedemptionStatus;
  createdAt: Date;
}

export interface NewCouponRedemptionInput {
  id: string;
  couponId: string;
  userId: string;
  orderId: string;
  discountAmount: number;
}

/**
 * `CouponRedemption` (§5.1 usage record, §7 `coupon_redemptions`).
 *
 * **A redemption row is the unit of usage.** Both of F-CPN-02's limits are counted from these
 * rows — global usage is `Σ APPLIED` for the coupon, per-user usage is `Σ APPLIED` for the
 * coupon and user — never from a counter column. That is the same discipline the ledger applies
 * to balances, and for the same reason: a counter can drift from the records it claims to
 * summarize, and there is no way to tell which one is wrong.
 *
 * It follows that a row exists **only** when a coupon is actually applied to an order. Validating
 * a coupon (§9.5's `POST /coupons/validate`) creates nothing: it is a read, it commits no
 * customer to anything, and a row written for it would consume a usage that was never spent.
 *
 * ## The two states, and only two
 *
 * §7 defines `APPLIED | REVERSED` and no others. `APPLIED -> REVERSED` is the only transition,
 * and there is no path back: a coupon reversed on cancellation frees its usage, and re-applying
 * it to the same order means a new decision, recorded by whatever applies it. There is
 * deliberately no `PENDING`/`RESERVED` state — see the reversal command for why a hold is not
 * invented here.
 */
export class CouponRedemption {
  private constructor(private readonly props: CouponRedemptionProps) {}

  static create(
    input: NewCouponRedemptionInput,
    now: Date = new Date(),
  ): CouponRedemption {
    if (!Number.isInteger(input.discountAmount) || input.discountAmount < 1) {
      // A zero-value redemption would consume a usage while discounting nothing.
      throw PaymentErrors.validation('discountAmount must be a positive integer.', {
        field: 'discountAmount',
        value: input.discountAmount,
      });
    }
    return new CouponRedemption({
      id: requireText(input.id, 'id'),
      couponId: requireText(input.couponId, 'couponId'),
      userId: requireText(input.userId, 'userId'),
      orderId: requireText(input.orderId, 'orderId'),
      discountAmount: input.discountAmount,
      status: RedemptionStatus.APPLIED,
      createdAt: now,
    });
  }

  static rehydrate(props: CouponRedemptionProps): CouponRedemption {
    return new CouponRedemption({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get status(): RedemptionStatus {
    return this.props.status;
  }
  get isApplied(): boolean {
    return this.props.status === RedemptionStatus.APPLIED;
  }

  /**
   * F-CPN-03's reversal. Refuses a second reversal rather than treating it as a no-op: the
   * *command* decides that a repeat request is an idempotent replay, and it does so by seeing the
   * row is already `REVERSED` before ever reaching the aggregate. If a caller gets this far with
   * an already-reversed row, the two disagree, and that is a defect worth surfacing.
   */
  reverse(): void {
    if (this.props.status !== RedemptionStatus.APPLIED) {
      throw PaymentErrors.invalidRedemptionStateTransition({
        redemptionId: this.props.id,
        from: this.props.status,
        to: RedemptionStatus.REVERSED,
      });
    }
    this.props.status = RedemptionStatus.REVERSED;
  }

  toProps(): CouponRedemptionProps {
    return { ...this.props };
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
