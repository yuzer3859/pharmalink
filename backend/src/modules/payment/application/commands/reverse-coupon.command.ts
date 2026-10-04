import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { CouponRedemption } from '../../domain/entities/coupon-redemption.entity';
import { RedemptionStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { couponReversedEvent } from '../../domain/events';
import {
  COUPON_REPOSITORY,
  ICouponRepository,
} from '../../domain/repositories/coupon.repository';
import { CouponCode } from '../../domain/value-objects/coupon-code.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithPaymentRetry } from '../support/payment-retry';

export interface ReverseCouponInput {
  orderId: string;
  /** Either identifies the redemption. `code` is the natural handle for a cancelling saga. */
  code?: string | null;
  redemptionId?: string | null;
  /** `null` for a system-driven reversal — an order cancellation compensating itself. */
  actorUserId?: string | null;
  reason?: string | null;
}

export interface ReverseCouponResult {
  redemptionId: string;
  couponId: string;
  orderId: string;
  customerUserId: string;
  discountAmount: number;
  status: RedemptionStatus;
  /** `true` when the redemption was already `REVERSED` and nothing changed. */
  replay: boolean;
}

/**
 * F-CPN-03 — "reverse coupon usage on order cancellation".
 *
 * Called by Module 06's `CancelOrderCommand` through `ICouponPort`, alongside the reservation
 * release and on the same best-effort, own-transaction terms (ADR-014).
 *
 * The caller may identify the redemption by `redemptionId`, by `code`, or by **neither** — in
 * which case this reverses the order's own `APPLIED` redemption. That last form is what a
 * cancelling saga uses: it holds an order id and has no reason to know which promotion was used.
 * It is unambiguous only because ADR-021 limits an order to one applied coupon; see {@link
 * ReverseCouponCommand.locate}.
 *
 * ## What reversing actually does
 *
 * It flips one redemption from `APPLIED` to `REVERSED` — and that is the whole mechanism, because
 * usage is *counted* from `APPLIED` rows. Giving the usage back is therefore not a separate step
 * that could be forgotten or double-applied: the count simply stops including this row. There is
 * no counter to decrement and no way for the count to drift from the records.
 *
 * No money moves. A coupon reduced what a customer was charged at checkout; unwinding that charge
 * is the payment's refund path (§11.4), which has its own command. Posting anything to the ledger
 * from here would double-count the same cancellation.
 *
 * ## Idempotency, and why a second reversal is a no-op rather than an error
 *
 * A cancelling saga retries. A redemption that is already `REVERSED` is exactly the state the
 * caller asked for, so this returns it with `replay: true` instead of failing — a compensating
 * saga that cannot safely retry is a saga that gets stuck. It writes no second audit entry and no
 * second event, so a retry storm cannot inflate the trail.
 *
 * What it never does is create a redemption. If none exists for the order, there is nothing to
 * give back and that is reported as `NOT_FOUND`, never papered over with a new row.
 *
 * ## Why there is no hold or reservation
 *
 * A coupon's usage is consumed when it is applied to an order and released when that application
 * is reversed. Nothing in §3.4, §5.1, §7, §9.5 or §12 describes an intermediate reserved state,
 * §7's `coupon_redemptions.status` has exactly two values, and an expiry rule for a hold would
 * have to be invented wholesale. So none is invented here.
 */
@Injectable()
export class ReverseCouponCommand {
  constructor(
    @Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ReverseCouponInput): Promise<ReverseCouponResult> {
    const orderId = requireText(input.orderId, 'orderId');
    const redemptionId = input.redemptionId?.trim() || null;
    const code = input.code ? CouponCode.of(input.code).value : null;

    return runWithPaymentRetry(this.uow, async (tx) => {
      const existing = await this.locate(orderId, code, redemptionId, tx);
      if (!existing) {
        throw PaymentErrors.notFound('No coupon redemption found for this order.', {
          orderId,
          ...(code ? { code } : {}),
        });
      }

      if (existing.status === RedemptionStatus.REVERSED) {
        // Already where the caller wants it. No second audit entry, no second event.
        return { ...toResult(existing), replay: true };
      }

      const aggregate = CouponRedemption.rehydrate(existing);
      aggregate.reverse();
      const row = await this.coupons.updateRedemptionStatus(
        existing.id,
        aggregate.toProps().status,
        tx,
      );

      await this.audit.record(
        {
          // `null` for a saga-driven reversal — recording a fabricated actor would corrupt the
          // very trail the field exists for (the same rule `RefundInitiator.SYSTEM` follows).
          actorUserId: input.actorUserId ?? null,
          action: 'COUPON_REVERSED',
          resourceType: 'CouponRedemption',
          resourceId: row.id,
          context: {
            couponId: row.couponId,
            orderId: row.orderId,
            userId: row.userId,
            discountAmount: row.discountAmount,
            reason: input.reason ?? null,
            outcome: 'REVERSED',
          },
        },
        tx,
      );

      await this.outbox.write(
        couponReversedEvent({
          couponId: row.couponId,
          userId: row.userId,
          orderId: row.orderId,
          discountAmount: row.discountAmount,
        }),
        tx as OutboxCapableClient,
      );

      return { ...toResult(row), replay: false };
    });
  }

  private async locate(
    orderId: string,
    code: string | null,
    redemptionId: string | null,
    tx: unknown,
  ) {
    if (redemptionId) {
      const byId = await this.coupons.findRedemptionById(redemptionId, tx);
      // The order must match: a redemption id alone must not be able to reverse a redemption
      // belonging to a different order than the one the caller named.
      return byId && byId.orderId === orderId ? byId : null;
    }
    if (code) {
      const coupon = await this.coupons.findByCode(code, tx);
      return coupon
        ? await this.coupons.findRedemptionByCouponAndOrder(coupon.id, orderId, tx)
        : null;
    }
    // Neither given — "reverse this order's coupon". Unambiguous only because ADR-021 makes an
    // order carry at most one `APPLIED` redemption, which `ApplyCouponCommand` now enforces inside
    // the transaction that inserts. A cancelling saga is the caller this exists for: Module 06
    // holds an order id and has no reason to know which promotion was used, and requiring it to
    // supply a code would mean either storing the code on the order or letting the caller name a
    // coupon it did not verify.
    //
    // `APPLIED` only, and the first of them. A `REVERSED` row is already where a caller would want
    // it, and returning one here would report a no-op replay while leaving a live redemption
    // untouched. If several were somehow `APPLIED` — which ADR-021's check prevents — reversing
    // one per call is still correct and repeatable; inventing a bulk reversal is not.
    const onOrder = await this.coupons.findRedemptionsByOrder(orderId, tx);
    return onOrder.find((row) => row.status === RedemptionStatus.APPLIED) ?? null;
  }
}

function toResult(redemption: {
  id: string;
  couponId: string;
  orderId: string;
  userId: string;
  discountAmount: number;
  status: RedemptionStatus;
}): Omit<ReverseCouponResult, 'replay'> {
  return {
    redemptionId: redemption.id,
    couponId: redemption.couponId,
    orderId: redemption.orderId,
    customerUserId: redemption.userId,
    discountAmount: redemption.discountAmount,
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
