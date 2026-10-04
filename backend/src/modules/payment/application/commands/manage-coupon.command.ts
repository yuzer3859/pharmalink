import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { Coupon, CouponProps } from '../../domain/entities/coupon.entity';
import { DiscountType } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import {
  COUPON_REPOSITORY,
  ICouponRepository,
} from '../../domain/repositories/coupon.repository';
import { CouponCode } from '../../domain/value-objects/coupon-code.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';

export interface CreateCouponInput {
  actorUserId: string;
  code: string;
  discountType: DiscountType;
  value: number;
  minSpend?: number | null;
  maxDiscount?: number | null;
  scope?: unknown;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  usageLimitGlobal?: number | null;
  usageLimitPerUser?: number | null;
  isActive?: boolean;
}

export interface UpdateCouponInput {
  actorUserId: string;
  couponId: string;
  discountType?: DiscountType;
  value?: number;
  minSpend?: number | null;
  maxDiscount?: number | null;
  scope?: unknown;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  usageLimitGlobal?: number | null;
  usageLimitPerUser?: number | null;
}

export interface SetCouponActiveInput {
  actorUserId: string;
  couponId: string;
  isActive: boolean;
}

/**
 * Admin coupon curation behind §9.5's `/admin/finance/coupons` (F-CPN-01).
 *
 * **All the business rules live here and in the `Coupon` aggregate, none in the controller.** The
 * controller maps HTTP to these methods and nothing else, exactly as every other Module 07
 * controller does. Authorization is the guard's `coupon:manage`; this command owns *what a valid
 * coupon is*, which is the aggregate's `assertConfiguration`.
 *
 * ## Audit, and why there is no event
 *
 * §13 requires "coupon create/redeem/reverse" in the hash-chained audit log, so every method here
 * records the actor, the coupon, the operation and what changed. No outbox event is written:
 * `coupon.created`/`coupon.updated` are not catalogued anywhere, creating a promotion moves no
 * money and changes no other module's state, and inventing an event with no consumer is the
 * speculative-event trap this module has avoided throughout.
 *
 * ## Deleting
 *
 * There is none. §7 gives `coupons` no soft-delete column and `coupon_redemptions` holds a foreign
 * key to it, so a hard delete would orphan records describing money that was genuinely discounted.
 * `setActive(false)` is the withdrawal mechanism — the coupon stops validating immediately while
 * its history stays intact.
 */
@Injectable()
export class ManageCouponCommand {
  constructor(
    @Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateCouponInput): Promise<CouponProps> {
    const coupon = Coupon.create({
      id: randomUUID(),
      code: input.code,
      discountType: input.discountType,
      value: input.value,
      minSpend: input.minSpend,
      maxDiscount: input.maxDiscount,
      scope: input.scope,
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      usageLimitGlobal: input.usageLimitGlobal,
      usageLimitPerUser: input.usageLimitPerUser,
      isActive: input.isActive,
    }).toProps();

    try {
      return await runWithPaymentRetry(this.uow, async (tx) => {
        const row = await this.coupons.create(coupon, tx);
        await this.record(input.actorUserId, 'COUPON_CREATED', row, {
          discountType: row.discountType,
          value: row.value,
          minSpend: row.minSpend,
          maxDiscount: row.maxDiscount,
          scope: row.scope,
          startsAt: row.startsAt,
          expiresAt: row.expiresAt,
          usageLimitGlobal: row.usageLimitGlobal,
          usageLimitPerUser: row.usageLimitPerUser,
          isActive: row.isActive,
        }, tx);
        return row;
      });
    } catch (err) {
      // `coupons.code` is `@unique` on the canonical form, so `save10` and `SAVE10` collide here
      // exactly as they should — one promotion, one code.
      if (isUniqueConstraintViolation(err)) {
        throw PaymentErrors.couponCodeTaken(CouponCode.of(input.code).value);
      }
      throw err;
    }
  }

  async update(input: UpdateCouponInput): Promise<CouponProps> {
    return runWithPaymentRetry(this.uow, async (tx) => {
      const existing = await this.load(input.couponId, tx);
      const aggregate = Coupon.rehydrate(existing);
      aggregate.update({
        discountType: input.discountType,
        value: input.value,
        minSpend: input.minSpend,
        maxDiscount: input.maxDiscount,
        scope: input.scope,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        usageLimitGlobal: input.usageLimitGlobal,
        usageLimitPerUser: input.usageLimitPerUser,
      });

      const next = aggregate.toProps();
      const row = await this.coupons.update(input.couponId, stripIdentity(next), tx);
      await this.record(input.actorUserId, 'COUPON_UPDATED', row, {
        // Both sides of the change, so the trail answers "what did it used to be" without a
        // second lookup — which is the question an audit of a promotion is usually asked.
        before: stripIdentity(existing),
        after: stripIdentity(row),
      }, tx);
      return row;
    });
  }

  /** F-CPN-01's active flag, used for both activate and deactivate. */
  async setActive(input: SetCouponActiveInput): Promise<CouponProps> {
    return runWithPaymentRetry(this.uow, async (tx) => {
      const existing = await this.load(input.couponId, tx);
      const aggregate = Coupon.rehydrate(existing);
      aggregate.setActive(input.isActive);

      const row = await this.coupons.update(
        input.couponId,
        stripIdentity(aggregate.toProps()),
        tx,
      );
      await this.record(
        input.actorUserId,
        input.isActive ? 'COUPON_ACTIVATED' : 'COUPON_DEACTIVATED',
        row,
        { isActive: row.isActive, previousIsActive: existing.isActive },
        tx,
      );
      return row;
    });
  }

  private async load(couponId: string, tx: unknown): Promise<CouponProps> {
    const existing = await this.coupons.findById(couponId, tx);
    if (!existing) {
      throw PaymentErrors.notFound('Coupon not found.', { couponId });
    }
    return existing;
  }

  /** §13's coupon-management trail: actor, coupon, code, operation, changes, outcome. */
  private record(
    actorUserId: string,
    action: string,
    coupon: CouponProps,
    changes: Record<string, unknown>,
    tx: unknown,
  ): Promise<unknown> {
    return this.audit.record(
      {
        actorUserId,
        action,
        resourceType: 'Coupon',
        resourceId: coupon.id,
        context: { couponId: coupon.id, code: coupon.code, changes, outcome: 'OK' },
      },
      tx,
    );
  }
}

/**
 * The fields an update may carry — never `id`, `code` or `createdAt`. Listed explicitly rather
 * than destructured-and-spread so that a new column added to `coupons` has to be considered here
 * before it becomes editable, instead of silently joining the update by default.
 */
function stripIdentity(props: CouponProps): Omit<CouponProps, 'id' | 'code' | 'createdAt'> {
  return {
    discountType: props.discountType,
    value: props.value,
    minSpend: props.minSpend,
    maxDiscount: props.maxDiscount,
    scope: props.scope,
    startsAt: props.startsAt,
    expiresAt: props.expiresAt,
    usageLimitGlobal: props.usageLimitGlobal,
    usageLimitPerUser: props.usageLimitPerUser,
    isActive: props.isActive,
  };
}
