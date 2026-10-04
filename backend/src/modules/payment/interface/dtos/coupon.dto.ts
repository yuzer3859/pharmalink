import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_COUPON_PAGE_SIZE } from '../../application/queries/get-coupon.query';
import { DiscountType } from '../../domain/enums';
import { MAX_COUPON_CODE_LENGTH } from '../../domain/value-objects/coupon-code.vo';

const MAX_SCOPE_IDS = 200;
const MAX_ID_LENGTH = 64;
const MAX_CART_ITEMS = 200;

/** One id list of a coupon's scope. Shared by the three dimensions §7 defines. */
function ScopeIds() {
  return [
    IsOptional(),
    IsArray(),
    ArrayNotEmpty(),
    ArrayMaxSize(MAX_SCOPE_IDS),
    IsString({ each: true }),
    MaxLength(MAX_ID_LENGTH, { each: true }),
  ];
}

function applyAll(decorators: PropertyDecorator[]): PropertyDecorator {
  return (target, key) => decorators.forEach((decorate) => decorate(target, key));
}

/**
 * §7's `scope` jsonb, typed. Exactly the three dimensions the design names — product, category
 * and pharmacy — and `forbidNonWhitelisted` rejects anything else, so a typo in an admin payload
 * cannot silently widen a coupon to the whole platform instead of narrowing it.
 */
export class CouponScopeDto {
  @applyAll(ScopeIds())
  productIds?: string[];

  @applyAll(ScopeIds())
  categoryIds?: string[];

  @applyAll(ScopeIds())
  pharmacyIds?: string[];
}

/**
 * `POST /admin/finance/coupons` (§9.5's admin CRUD, F-CPN-01).
 *
 * The DTO checks shape only; every business rule — a percentage of 1–100, a window that starts
 * before it ends, a per-user limit no larger than the global one — lives in the `Coupon`
 * aggregate, so an in-process caller cannot bypass it by not going through HTTP.
 */
export class CreateCouponDto {
  /**
   * Normalized to trimmed upper case before storage, so `save10` and `SAVE10` are one coupon
   * (see `CouponCode`). Accepted in any case here; the canonical form is what is persisted.
   */
  @IsString()
  @MaxLength(MAX_COUPON_CODE_LENGTH)
  code!: string;

  @IsEnum(DiscountType)
  discountType!: DiscountType;

  /** Whole percent (1–100) for `PERCENT`; ETB minor units for `FIXED`. See `CouponProps.value`. */
  @IsInt()
  @Min(1)
  value!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minSpend?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxDiscount?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => CouponScopeDto)
  scope?: CouponScopeDto;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimitGlobal?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimitPerUser?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * `PATCH /admin/finance/coupons/:id`. Every field optional; absent means "leave alone".
 *
 * There is no `code` field, deliberately. A coupon's code is printed on flyers and typed by
 * customers; changing it would silently break every place it was published, and the redemptions
 * already recorded against it would refer to a promotion under a different name. An admin who
 * needs a different code creates a new coupon and deactivates this one.
 *
 * There is no `isActive` field either — activation has its own route, so "withdraw this
 * promotion" is an explicit, separately audited act rather than one field of a bulk edit.
 */
export class UpdateCouponDto {
  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  @IsOptional()
  @IsInt()
  @Min(1)
  value?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minSpend?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxDiscount?: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CouponScopeDto)
  scope?: CouponScopeDto | null;

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimitGlobal?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimitPerUser?: number | null;
}

/** `POST /admin/finance/coupons/:id/status` — F-CPN-01's activate/deactivate. */
export class SetCouponActiveDto {
  @IsBoolean()
  isActive!: boolean;
}

/** `GET /admin/finance/coupons` — same page/size convention as every other list in the project. */
export class ListCouponsQueryDto {
  @IsOptional()
  @Transform(({ obj }) => {
    const raw = (obj as Record<string, unknown>).isActive;
    if (raw === 'true' || raw === true) return true;
    if (raw === 'false' || raw === false) return false;
    return raw;
  })
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_COUPON_CODE_LENGTH)
  code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_COUPON_PAGE_SIZE)
  size?: number = 20;
}

/** One line of §9.5's `items` — see {@link ValidateCouponDto} for why it is not authoritative. */
export class ValidateCouponItemDto {
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * `POST /coupons/validate` — §9.5's `{ code, cartTotal, items }`.
 *
 * ## Why `cartTotal` and `items` are accepted but not believed
 *
 * They are the client's **display assertions**, not inputs. The coupon is evaluated against the
 * caller's real active cart, resolved from their access token and priced from Module 03: a
 * discount computed from a client-supplied item list is a discount the client chose — send one
 * expensive item to clear a `minSpend` and a cheap one to be discounted, or quote yourself a
 * discount on a cart you do not have. `cartTotal` is compared with the server's own subtotal and
 * the disagreement is reported back as `cartTotalMismatch`, which is what a display assertion is
 * for.
 *
 * There is no `userId` field, and `forbidNonWhitelisted` makes sending one a `400` rather than a
 * silently ignored extra: a customer cannot validate against another customer's cart or spend
 * another customer's per-user allowance.
 */
export class ValidateCouponDto {
  @IsString()
  @MaxLength(MAX_COUPON_CODE_LENGTH)
  code!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  cartTotal?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CART_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => ValidateCouponItemDto)
  items?: ValidateCouponItemDto[];
}
