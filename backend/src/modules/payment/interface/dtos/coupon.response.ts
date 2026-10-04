import { CouponProps } from '../../domain/entities/coupon.entity';
import { DiscountType } from '../../domain/enums';
import { CouponScopeProps } from '../../domain/value-objects/coupon-scope.vo';

/**
 * The admin response for a coupon **mutation** — every configured field, and nothing derived.
 *
 * An explicit allow-list rather than a pass-through of `CouponProps`, for the same reason
 * `toCaptureResponse` is one: a later field added to the persisted shape must not silently widen
 * what HTTP exposes.
 *
 * `timesRedeemed` is deliberately absent here while `CouponView` (the read projection) carries it.
 * A create/update/activate response describes the coupon the admin just wrote; counting its
 * redemptions would be a second query answering a question nobody asked at that moment, and the
 * `GET` routes already provide it.
 *
 * Nothing here is customer-facing. `POST /coupons/validate` answers with
 * `{ valid, discountAmount, reason? }` and never reveals a coupon's limits, scope or remaining
 * usage — together those would let a customer map out an unpublished promotion.
 */
export interface CouponResponse {
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
}

export function toCouponResponse(coupon: CouponProps): CouponResponse {
  return {
    id: coupon.id,
    // The canonical, upper-cased form — what was actually stored, so an admin who typed `save10`
    // sees the `SAVE10` a customer will type.
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
  };
}
