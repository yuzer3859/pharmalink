import { DiscountType } from '../enums';
import { PaymentErrors } from '../errors';
import { CouponCode } from '../value-objects/coupon-code.vo';
import { CouponScope, CouponScopeProps } from '../value-objects/coupon-scope.vo';

/** The maximum a `PERCENT` coupon's `value` may be — see `CouponProps.value`. */
export const MAX_PERCENT_VALUE = 100;

/**
 * The persisted shape of §7's `coupons` row. Field-for-field, with nothing added: there is no
 * usage counter here, because usage is derived from `coupon_redemptions` (§18's rule and this
 * module's standing "a balance is never stored" discipline, ADR-006).
 *
 * `scope` is the raw JSON as stored; `CouponScope.parse` turns it into the value object.
 */
export interface CouponProps {
  id: string;
  /** Canonical form — trimmed and upper-cased by `CouponCode` before it is ever written. */
  code: string;
  discountType: DiscountType;
  /**
   * For `FIXED`, the discount in ETB minor units. For `PERCENT`, **whole percent, 1–100**.
   *
   * The unit for `PERCENT` is a decision the design does not make: §7 gives only `value Int`, and
   * an integer column could equally mean whole percent or basis points. Whole percent is chosen
   * because it is the plain reading of "discount_type PERCENT, value 10" and matches how a
   * promotion is written on a flyer. The cost is that fractional rates such as 12.5% cannot be
   * expressed. If a promotion ever needs one, the change is basis points (`value` 1250 = 12.5%)
   * plus a data migration multiplying existing values by 100 — a migration, not a redesign.
   */
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

/** What an admin may set when creating a coupon (§9.5's admin CRUD, F-CPN-01). */
export interface NewCouponInput {
  id: string;
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

/** What an admin may change afterwards. Every field optional; absent means "leave alone". */
export interface CouponUpdateInput {
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

/**
 * `Coupon` (§5.1 aggregate root, §7 `coupons`).
 *
 * The aggregate owns its **configuration** invariants — a percentage is 1–100, a fixed discount is
 * positive, a window starts before it ends, a limit is at least one. It deliberately owns *no*
 * usage state: how many times it has been redeemed is `Σ APPLIED redemptions`, derived by the
 * repository from `coupon_redemptions`, never a counter on this row that could drift from the
 * records it summarizes.
 *
 * The `code` is never mutable. A code is printed on flyers and typed by customers; changing it
 * would silently break every place it was published, and the redemptions already recorded against
 * it would refer to a promotion under a different name. An admin who needs a different code
 * creates a different coupon and deactivates this one.
 */
export class Coupon {
  private constructor(private readonly props: CouponProps) {}

  static create(input: NewCouponInput, now: Date = new Date()): Coupon {
    const code = CouponCode.of(input.code);
    const scope = CouponScope.parse(input.scope ?? null);

    const props: CouponProps = {
      id: requireText(input.id, 'id'),
      code: code.value,
      discountType: input.discountType,
      value: input.value,
      minSpend: input.minSpend ?? null,
      maxDiscount: input.maxDiscount ?? null,
      scope: scope.toJSON(),
      startsAt: input.startsAt ?? null,
      expiresAt: input.expiresAt ?? null,
      usageLimitGlobal: input.usageLimitGlobal ?? null,
      usageLimitPerUser: input.usageLimitPerUser ?? null,
      isActive: input.isActive ?? true,
      createdAt: now,
    };
    assertConfiguration(props);
    return new Coupon(props);
  }

  static rehydrate(props: CouponProps): Coupon {
    return new Coupon({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get code(): string {
    return this.props.code;
  }
  get isActive(): boolean {
    return this.props.isActive;
  }
  get scope(): CouponScope {
    return CouponScope.parse(this.props.scope);
  }

  /** Applies an admin edit, re-validating the whole configuration rather than only the delta. */
  update(input: CouponUpdateInput): void {
    const next: CouponProps = {
      ...this.props,
      ...(input.discountType !== undefined ? { discountType: input.discountType } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.minSpend !== undefined ? { minSpend: input.minSpend } : {}),
      ...(input.maxDiscount !== undefined ? { maxDiscount: input.maxDiscount } : {}),
      ...(input.scope !== undefined ? { scope: CouponScope.parse(input.scope).toJSON() } : {}),
      ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.usageLimitGlobal !== undefined
        ? { usageLimitGlobal: input.usageLimitGlobal }
        : {}),
      ...(input.usageLimitPerUser !== undefined
        ? { usageLimitPerUser: input.usageLimitPerUser }
        : {}),
    };
    assertConfiguration(next);
    Object.assign(this.props, next);
  }

  /**
   * F-CPN-01's active flag. Deactivating is **not** a delete: redemptions already recorded stay
   * exactly as they are, because they describe money that was actually discounted. A deactivated
   * coupon simply stops validating for new requests.
   */
  setActive(isActive: boolean): void {
    this.props.isActive = isActive;
  }

  toProps(): CouponProps {
    return { ...this.props };
  }
}

/**
 * Every configuration invariant in one place, applied identically on create and on update — so an
 * edit cannot reach a state a creation would have refused.
 */
function assertConfiguration(props: CouponProps): void {
  if (props.discountType !== DiscountType.PERCENT && props.discountType !== DiscountType.FIXED) {
    throw PaymentErrors.validation('discountType must be PERCENT or FIXED.', {
      field: 'discountType',
      value: props.discountType,
    });
  }

  assertPositiveInteger(props.value, 'value');
  if (props.discountType === DiscountType.PERCENT && props.value > MAX_PERCENT_VALUE) {
    // A discount over 100% would pay the customer to order.
    throw PaymentErrors.validation(
      `A PERCENT coupon's value must be between 1 and ${MAX_PERCENT_VALUE}.`,
      { field: 'value', value: props.value },
    );
  }

  if (props.minSpend !== null) {
    assertPositiveInteger(props.minSpend, 'minSpend');
  }
  if (props.maxDiscount !== null) {
    assertPositiveInteger(props.maxDiscount, 'maxDiscount');
  }
  if (props.usageLimitGlobal !== null) {
    assertPositiveInteger(props.usageLimitGlobal, 'usageLimitGlobal');
  }
  if (props.usageLimitPerUser !== null) {
    assertPositiveInteger(props.usageLimitPerUser, 'usageLimitPerUser');
  }

  if (
    props.startsAt !== null &&
    props.expiresAt !== null &&
    props.startsAt.getTime() >= props.expiresAt.getTime()
  ) {
    throw PaymentErrors.validation('startsAt must be before expiresAt.', { field: 'startsAt' });
  }

  if (
    props.usageLimitGlobal !== null &&
    props.usageLimitPerUser !== null &&
    props.usageLimitPerUser > props.usageLimitGlobal
  ) {
    // Not fatal to correctness — the global limit still binds — but it is always a mistake, and
    // silently accepting it hides a promotion configured to do something it cannot do.
    throw PaymentErrors.validation(
      'usageLimitPerUser cannot exceed usageLimitGlobal.',
      { field: 'usageLimitPerUser' },
    );
  }
}

/**
 * Zero is rejected everywhere, not only negatives: a zero-value coupon discounts nothing, a zero
 * `maxDiscount` caps every discount at nothing, and a zero usage limit makes the coupon unusable.
 * Each is a misconfiguration that would otherwise fail silently at redemption time.
 */
function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw PaymentErrors.validation(`${field} must be a positive integer.`, { field, value });
  }
  if (!Number.isSafeInteger(value)) {
    throw PaymentErrors.validation(`${field} exceeds the safe integer range.`, { field, value });
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
