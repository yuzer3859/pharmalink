import { Inject, Injectable } from '@nestjs/common';
import { CouponProps } from '../../domain/entities/coupon.entity';
import { DiscountType, RedemptionStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import {
  COUPON_REPOSITORY,
  ICouponRepository,
  ListCouponsCriteria,
} from '../../domain/repositories/coupon.repository';
import { CouponScopeProps } from '../../domain/value-objects/coupon-scope.vo';

/**
 * The admin projection of a coupon — every configured field, plus the derived usage an admin
 * actually needs to manage a promotion.
 *
 * `timesRedeemed` is **counted from `APPLIED` redemption rows**, never read from a column, because
 * no such column exists and deliberately so: a stored counter is a second source of truth for how
 * much of a promotion has been given away, free to drift from the records it claims to summarize.
 *
 * This shape is admin-only. Nothing customer-facing returns it — `POST /coupons/validate` answers
 * with `{ valid, discountAmount, reason? }` and never reveals a coupon's limits, its remaining
 * usage or its scope, which together would let a customer map out an unpublished promotion.
 */
export interface CouponView {
  id: string;
  code: string;
  discountType: DiscountType;
  value: number;
  minSpend: number | null;
  maxDiscount: number | null;
  scope: CouponScopeProps | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  usageLimitGlobal: number | null;
  usageLimitPerUser: number | null;
  isActive: boolean;
  createdAt: Date;
  /** Σ `APPLIED` redemptions. Reversed ones are excluded — their usage went back to the pool. */
  timesRedeemed: number;
}

export interface CouponListView {
  items: CouponView[];
  total: number;
  page: number;
  size: number;
}

/** One redemption, for the admin's per-coupon view. */
export interface CouponRedemptionView {
  id: string;
  couponId: string;
  userId: string;
  orderId: string;
  discountAmount: number;
  status: RedemptionStatus;
  createdAt: Date;
}

export const MAX_COUPON_PAGE_SIZE = 50;

/**
 * `GET /admin/finance/coupons/{id}` and `GET /admin/finance/coupons` (§9.5's admin CRUD).
 *
 * Both are admin reads behind `coupon:manage`. Neither exposes any ledger, payment or wallet data:
 * a coupon knows nothing about them, and this projection is built from `coupons` and
 * `coupon_redemptions` alone.
 */
@Injectable()
export class GetCouponQuery {
  constructor(@Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository) {}

  async execute(couponId: string): Promise<CouponView> {
    const id = (couponId ?? '').trim();
    if (!id) {
      throw PaymentErrors.validation('couponId is required.', { field: 'couponId' });
    }
    const coupon = await this.coupons.findById(id);
    if (!coupon) {
      throw PaymentErrors.notFound('Coupon not found.', { couponId: id });
    }
    return toView(coupon, await this.coupons.countAppliedForCoupon(coupon.id));
  }

  /** The coupon's redemptions, newest-first ordering left to the repository's own ordering. */
  async redemptions(couponId: string): Promise<CouponRedemptionView[]> {
    await this.execute(couponId);
    const rows = await this.coupons.findRedemptionsByCoupon(couponId.trim());
    return rows.map((row) => ({
      id: row.id,
      couponId: row.couponId,
      userId: row.userId,
      orderId: row.orderId,
      discountAmount: row.discountAmount,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }
}

@Injectable()
export class ListCouponsQuery {
  constructor(@Inject(COUPON_REPOSITORY) private readonly coupons: ICouponRepository) {}

  async execute(criteria: Partial<ListCouponsCriteria>): Promise<CouponListView> {
    const page = Math.max(Math.trunc(criteria.page ?? 1), 1);
    const size = Math.min(Math.max(Math.trunc(criteria.size ?? 20), 1), MAX_COUPON_PAGE_SIZE);

    const { items, total } = await this.coupons.list({
      isActive: criteria.isActive,
      // Codes are canonical, so a search term is normalized the same way before matching —
      // otherwise searching `save` would find nothing at all.
      codeContains: criteria.codeContains?.trim().toUpperCase() || undefined,
      page,
      size,
    });

    // One count per coupon rather than a join: the page is at most 50 rows, and keeping the count
    // in the repository's own derived-usage method means there is exactly one definition of
    // "times redeemed" in the codebase.
    const views = await Promise.all(
      items.map(async (coupon) =>
        toView(coupon, await this.coupons.countAppliedForCoupon(coupon.id)),
      ),
    );

    return { items: views, total, page, size };
  }
}

function toView(coupon: CouponProps, timesRedeemed: number): CouponView {
  return {
    id: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType,
    value: coupon.value,
    minSpend: coupon.minSpend,
    maxDiscount: coupon.maxDiscount,
    scope: coupon.scope,
    startsAt: coupon.startsAt,
    expiresAt: coupon.expiresAt,
    usageLimitGlobal: coupon.usageLimitGlobal,
    usageLimitPerUser: coupon.usageLimitPerUser,
    isActive: coupon.isActive,
    createdAt: coupon.createdAt,
    timesRedeemed,
  };
}
