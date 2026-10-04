import { CouponProps } from '../entities/coupon.entity';
import { CouponRedemptionProps } from '../entities/coupon-redemption.entity';

export const COUPON_REPOSITORY = Symbol('COUPON_REPOSITORY');

/** One page of coupons for the admin list (§9.5's admin CRUD). */
export interface CouponPage {
  items: CouponProps[];
  total: number;
}

export interface ListCouponsCriteria {
  /** `undefined` = both. Filters on `coupons.isActive`. */
  isActive?: boolean;
  /** Substring match on the canonical (upper-cased) code. */
  codeContains?: string;
  page: number;
  size: number;
}

/**
 * Persistence port for §7's `coupons` and `coupon_redemptions` (§10's own `ICouponRepository`).
 * Domain-facing snapshots only — no Prisma type crosses this boundary, per ADR-002.
 *
 * **There is no `incrementUsage` and there never will be.** Usage is counted from `APPLIED`
 * redemption rows by {@link countAppliedForCoupon} and {@link countAppliedForCouponAndUser}, so
 * the rows and the count can never disagree — the same "derive, never store" rule the ledger
 * applies to balances (ADR-006, §5.3). A counter column would be a second source of truth for how
 * much of a promotion has been given away.
 *
 * Every method takes an optional `tx`, so a redemption's count-then-insert can happen inside one
 * `Serializable` transaction. That composition is what makes F-CPN-02's limits hold under
 * concurrency; see `ApplyCouponCommand`.
 */
export interface ICouponRepository {
  findById(id: string, tx?: unknown): Promise<CouponProps | null>;
  /** Lookup by the **canonical** code — the caller normalizes through `CouponCode` first. */
  findByCode(code: string, tx?: unknown): Promise<CouponProps | null>;
  list(criteria: ListCouponsCriteria, tx?: unknown): Promise<CouponPage>;

  create(coupon: CouponProps, tx?: unknown): Promise<CouponProps>;
  /** Persists an admin edit. `code` and `createdAt` are never part of the update. */
  update(
    id: string,
    changes: Omit<CouponProps, 'id' | 'code' | 'createdAt'>,
    tx?: unknown,
  ): Promise<CouponProps>;

  /**
   * Global usage: how many `APPLIED` redemptions this coupon has. `REVERSED` rows are excluded,
   * which is what makes F-CPN-03's reversal actually give the usage back.
   */
  countAppliedForCoupon(couponId: string, tx?: unknown): Promise<number>;
  /** Per-user usage, counted the same way. */
  countAppliedForCouponAndUser(couponId: string, userId: string, tx?: unknown): Promise<number>;

  findRedemptionById(id: string, tx?: unknown): Promise<CouponRedemptionProps | null>;
  /**
   * The redemption for one coupon on one order — §7's `@@unique([couponId, orderId])`, which is
   * both the idempotency identity of an application and the guarantee that one coupon can be
   * applied to an order at most once.
   */
  findRedemptionByCouponAndOrder(
    couponId: string,
    orderId: string,
    tx?: unknown,
  ): Promise<CouponRedemptionProps | null>;
  /** Every redemption on an order, whatever its status — the admin/support read. */
  findRedemptionsByOrder(orderId: string, tx?: unknown): Promise<CouponRedemptionProps[]>;
  findRedemptionsByCoupon(couponId: string, tx?: unknown): Promise<CouponRedemptionProps[]>;

  createRedemption(
    redemption: CouponRedemptionProps,
    tx?: unknown,
  ): Promise<CouponRedemptionProps>;
  /**
   * The only mutation a redemption ever receives: `APPLIED -> REVERSED`. Deliberately narrower
   * than a general `update` — a redemption's coupon, user, order and amount describe money that
   * was already discounted and must not be editable.
   */
  updateRedemptionStatus(
    id: string,
    status: CouponRedemptionProps['status'],
    tx?: unknown,
  ): Promise<CouponRedemptionProps>;
}
