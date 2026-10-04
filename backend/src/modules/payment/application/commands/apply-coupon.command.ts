import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { CouponProps } from '../../domain/entities/coupon.entity';
import { CouponRedemption } from '../../domain/entities/coupon-redemption.entity';
import { RedemptionStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { couponRedeemedEvent } from '../../domain/events';
import {
  COUPON_REPOSITORY,
  ICouponRepository,
} from '../../domain/repositories/coupon.repository';
import { CouponRejected, CouponValidator } from '../../domain/services/coupon-validator';
import { CouponCode } from '../../domain/value-objects/coupon-code.vo';
import { IOrderPort, ORDER_PORT } from '../ports/outbound/order.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { CouponLineResolver } from '../services/coupon-line-resolver.service';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';

export interface ApplyCouponInput {
  code: string;
  orderId: string;
  /**
   * Whose usage is being consumed. Comes from the calling saga's own context — the order's
   * `customerUserId` — and is checked against the order, so a caller cannot spend one customer's
   * per-user allowance on another's order.
   */
  customerUserId: string;
  actorUserId?: string | null;
}

export interface ApplyCouponResult {
  redemptionId: string;
  couponId: string;
  code: string;
  orderId: string;
  customerUserId: string;
  discountAmount: number;
  currency: string;
  status: RedemptionStatus;
  /** `true` when an already-committed redemption was returned rather than a new one created. */
  replay: boolean;
}

const BASE_CURRENCY = 'ETB';

/**
 * F-CPN-02's *apply* half: validate, then consume a usage, atomically.
 *
 * Called by Module 06's checkout saga once the order exists, through `ICouponPort`. §11.7 records
 * the split: the discount is *quoted* at step 5 (which has no order yet, and so cannot write a
 * redemption) and *redeemed* here against that order's own committed lines. Because those lines
 * are created from exactly the figures the quote scored, the two discounts agree — and the caller
 * compares them, so a disagreement surfaces instead of silently mispricing an order.
 *
 * ## Why the whole thing sits in one Serializable transaction
 *
 * F-CPN-02's limits are `Σ APPLIED redemptions < limit`, which no row-level constraint can
 * express for the *global* case. Counting in one transaction and inserting in another is the
 * textbook write-skew: two concurrent applications each count 99 against a limit of 100, each find
 * room, and together make 101. Counting and inserting inside one `Serializable` transaction closes
 * it — PostgreSQL's SSI detects that each transaction inserted into the range the other counted
 * and aborts one. `runWithPaymentRetry` re-runs the loser, which then counts the winner's row and
 * correctly refuses with `COUPON_USAGE_EXCEEDED`. The retry is safe because this transaction
 * contains no external side effect.
 *
 * The **per-order** case additionally has a real constraint behind it — §7's
 * `@@unique([couponId, orderId])` — so even a serialization failure that slipped through could not
 * write two redemptions for one coupon on one order. That unique index is also this command's
 * idempotency identity.
 *
 * ## Idempotency
 *
 * The identity of an application is `(coupon, order)`, not a caller-supplied key — the same
 * mechanism capture, refund, top-up and wallet spend already use, rather than a second one racing
 * them. That index makes *this* coupon idempotent on this order; ADR-021's "only one coupon per
 * order at all" is the separate `APPLIED`-count check below, which two concurrent applications of
 * *different* coupons race under SSI exactly as the usage limits do — each counts zero, each
 * inserts into the range the other counted, and PostgreSQL aborts one.
 *
 * A retry finds the committed redemption and returns it; nothing is counted twice and no
 * second row appears. A `REVERSED` redemption is *not* replayed as a success: reversal was a
 * deliberate decision to give the usage back, and quietly resurrecting it would undo that.
 *
 * ## What is discounted
 *
 * The order's own committed `order_lines`, scored by `CouponValidator` — never a cart, never
 * anything the caller supplies. The discount is recomputed here rather than carried over from a
 * validation response, because a validation is a quote against a cart and this is a decision
 * against an order.
 */
@Injectable()
export class ApplyCouponCommand {
  constructor(
    @Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository,
    @Inject(ORDER_PORT) private readonly orders: IOrderPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly lines: CouponLineResolver,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ApplyCouponInput): Promise<ApplyCouponResult> {
    const code = CouponCode.of(input.code).value;
    const orderId = requireText(input.orderId, 'orderId');
    const customerUserId = requireText(input.customerUserId, 'customerUserId');

    const order = await this.orders.getOrder(orderId);
    if (!order) {
      throw PaymentErrors.orderNotFound({ orderId });
    }
    if (order.customerUserId !== customerUserId) {
      // A coupon's per-user allowance belongs to the order's own customer. Same shape as a
      // missing order, so this cannot be used to probe for someone else's.
      throw PaymentErrors.orderNotFound({ orderId });
    }

    // Read outside the transaction: the order's lines and the catalog are not what races here,
    // and keeping catalog I/O out of a Serializable transaction keeps the retried section short.
    const resolved = await this.lines.forOrder(orderId);

    try {
      return await runWithPaymentRetry(this.uow, async (tx) => {
        const coupon = await this.coupons.findByCode(code, tx);
        if (!coupon) {
          throw PaymentErrors.couponInvalid('This coupon code is not valid.', { code });
        }

        const existing = await this.coupons.findRedemptionByCouponAndOrder(
          coupon.id,
          orderId,
          tx,
        );
        if (existing) {
          if (existing.status === RedemptionStatus.REVERSED) {
            throw PaymentErrors.couponInvalid(
              'This coupon was already reversed on this order.',
              { code, orderId, redemptionId: existing.id },
            );
          }
          return { ...toResult(coupon, existing), replay: true };
        }

        // ADR-021 — exactly one coupon per order. A cross-row condition no row-level constraint
        // can express, so it is counted inside the same Serializable transaction that inserts, for
        // the same reason the usage limits are. Deliberately **not** a `@@unique([orderId])`: a
        // `REVERSED` row would then permanently block a legitimate re-application after a
        // cancellation, which F-CPN-03 explicitly allows.
        const appliedOnOrder = (await this.coupons.findRedemptionsByOrder(orderId, tx)).filter(
          (row) => row.status === RedemptionStatus.APPLIED,
        );
        if (appliedOnOrder.length > 0) {
          throw PaymentErrors.couponInvalid('This order already has a coupon applied.', {
            code,
            orderId,
            appliedCouponId: appliedOnOrder[0].couponId,
          });
        }

        // Counted inside the transaction that inserts — see the class doc.
        const evaluation = CouponValidator.evaluate({
          coupon,
          lines: resolved.lines,
          usage: {
            global: await this.coupons.countAppliedForCoupon(coupon.id, tx),
            perUser: await this.coupons.countAppliedForCouponAndUser(
              coupon.id,
              customerUserId,
              tx,
            ),
          },
        });
        if (!evaluation.valid) {
          throw toError(evaluation, coupon);
        }

        const redemption = CouponRedemption.create({
          id: randomUUID(),
          couponId: coupon.id,
          userId: customerUserId,
          orderId,
          discountAmount: evaluation.discountAmount,
        }).toProps();
        const row = await this.coupons.createRedemption(redemption, tx);

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? customerUserId,
            action: 'COUPON_REDEEMED',
            resourceType: 'CouponRedemption',
            resourceId: row.id,
            context: {
              couponId: coupon.id,
              // The code is safe to record: it is a promotion identifier, not a secret, and §13
              // requires the coupon be identifiable in the trail.
              code: coupon.code,
              orderId,
              userId: customerUserId,
              discountAmount: row.discountAmount,
              eligibleSubtotal: evaluation.eligibleSubtotal,
              currency: evaluation.currency,
              outcome: 'APPLIED',
            },
          },
          tx,
        );

        await this.outbox.write(
          couponRedeemedEvent({
            couponId: coupon.id,
            userId: customerUserId,
            orderId,
            discountAmount: row.discountAmount,
          }),
          tx as OutboxCapableClient,
        );

        return { ...toResult(coupon, row), replay: false };
      });
    } catch (err) {
      // Two concurrent applications of the same coupon to the same order raced §7's unique index.
      // The loser returns the winner's committed redemption rather than counting a second usage.
      if (isUniqueConstraintViolation(err)) {
        const coupon = await this.coupons.findByCode(code);
        const winner = coupon
          ? await this.coupons.findRedemptionByCouponAndOrder(coupon.id, orderId)
          : null;
        if (coupon && winner && winner.status === RedemptionStatus.APPLIED) {
          return { ...toResult(coupon, winner), replay: true };
        }
      }
      throw err;
    }
  }
}

/** Maps `CouponValidator`'s rejection onto §12's three coupon error codes. */
function toError(rejection: CouponRejected, coupon: CouponProps) {
  switch (rejection.reason) {
    case 'EXPIRED':
      return PaymentErrors.couponExpired({
        code: coupon.code,
        expiresAt: coupon.expiresAt as Date,
      });
    case 'GLOBAL_LIMIT_REACHED':
      return PaymentErrors.couponUsageExceeded({
        code: coupon.code,
        scope: 'GLOBAL',
        limit: coupon.usageLimitGlobal as number,
        used: (rejection.details?.used as number) ?? 0,
      });
    case 'PER_USER_LIMIT_REACHED':
      return PaymentErrors.couponUsageExceeded({
        code: coupon.code,
        scope: 'PER_USER',
        limit: coupon.usageLimitPerUser as number,
        used: (rejection.details?.used as number) ?? 0,
      });
    default:
      return PaymentErrors.couponInvalid(rejection.message, {
        code: coupon.code,
        reason: rejection.reason,
        ...(rejection.details ?? {}),
      });
  }
}

function toResult(
  coupon: CouponProps,
  redemption: {
    id: string;
    couponId: string;
    userId: string;
    orderId: string;
    discountAmount: number;
    status: RedemptionStatus;
  },
): Omit<ApplyCouponResult, 'replay'> {
  return {
    redemptionId: redemption.id,
    couponId: redemption.couponId,
    code: coupon.code,
    orderId: redemption.orderId,
    customerUserId: redemption.userId,
    discountAmount: redemption.discountAmount,
    currency: BASE_CURRENCY,
    status: redemption.status,
  };
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
