import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ManageCouponCommand } from '../../application/commands/manage-coupon.command';
import {
  CouponListView,
  CouponRedemptionView,
  CouponView,
  GetCouponQuery,
  ListCouponsQuery,
} from '../../application/queries/get-coupon.query';
import {
  CreateCouponDto,
  ListCouponsQueryDto,
  SetCouponActiveDto,
  UpdateCouponDto,
} from '../dtos/coupon.dto';
import { toCouponResponse, CouponResponse } from '../dtos/coupon.response';

/**
 * Admin coupon curation (§9.5 — "Admin CRUD `/admin/finance/coupons` — `coupon:manage` (Admin)").
 *
 * Thin, like every other Module 07 controller: it maps HTTP to `ManageCouponCommand` and the two
 * read queries and owns no business rule of its own. What a valid coupon *is* — a percentage of
 * 1–100, a window that starts before it ends, a per-user limit no larger than the global one,
 * scope dimensions limited to the three §7 names — lives in the `Coupon` aggregate, so a future
 * in-process caller cannot reach a configuration this route would have refused.
 *
 * `@RequirePermissions('coupon:manage')` sits on the class, so every route inherits it and a new
 * one cannot be added unguarded by forgetting a decorator. §9.5 assigns it to Admin, and the RBAC
 * catalog grants it to `ADMIN` alone — deliberately not to `FINANCE_OFFICER`, whose finance
 * permissions are payout and refund authority rather than promotion curation.
 *
 * **There is no delete route.** §7 gives `coupons` no soft-delete column and `coupon_redemptions`
 * holds a foreign key to it, so a hard delete would orphan records describing money that was
 * genuinely discounted. `POST :id/status` with `isActive: false` is the withdrawal mechanism: the
 * coupon stops validating immediately and its history stays intact.
 */
@Controller('admin/finance/coupons')
@RequirePermissions('coupon:manage')
export class AdminCouponController {
  constructor(
    private readonly manageCoupon: ManageCouponCommand,
    private readonly getCoupon: GetCouponQuery,
    private readonly listCoupons: ListCouponsQuery,
  ) {}

  /** F-CPN-01. `201` — a coupon is created. */
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: CreateCouponDto,
  ): Promise<CouponResponse> {
    return toCouponResponse(
      await this.manageCoupon.create({
        actorUserId: user.userId,
        code: dto.code,
        discountType: dto.discountType,
        value: dto.value,
        minSpend: dto.minSpend,
        maxDiscount: dto.maxDiscount,
        scope: dto.scope,
        startsAt: toDate(dto.startsAt),
        expiresAt: toDate(dto.expiresAt),
        usageLimitGlobal: dto.usageLimitGlobal,
        usageLimitPerUser: dto.usageLimitPerUser,
        isActive: dto.isActive,
      }),
    );
  }

  @Get()
  list(@Query() query: ListCouponsQueryDto): Promise<CouponListView> {
    return this.listCoupons.execute({
      isActive: query.isActive,
      codeContains: query.code,
      page: query.page,
      size: query.size,
    });
  }

  @Get(':id')
  getOne(@Param('id') couponId: string): Promise<CouponView> {
    return this.getCoupon.execute(couponId);
  }

  /**
   * Which orders consumed this promotion. Admin-only, and the reason it exists is that "how much
   * of this coupon has been given away" is derived from these rows rather than stored — an admin
   * who needs to check the figure needs to be able to see what it was computed from.
   */
  @Get(':id/redemptions')
  redemptions(@Param('id') couponId: string): Promise<CouponRedemptionView[]> {
    return this.getCoupon.redemptions(couponId);
  }

  /** `PATCH`, not `PUT`: an absent field means "leave alone", never "clear". */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') couponId: string,
    @Body() dto: UpdateCouponDto,
  ): Promise<CouponResponse> {
    return toCouponResponse(
      await this.manageCoupon.update({
        actorUserId: user.userId,
        couponId,
        discountType: dto.discountType,
        value: dto.value,
        minSpend: dto.minSpend,
        maxDiscount: dto.maxDiscount,
        scope: dto.scope,
        startsAt: toDate(dto.startsAt),
        expiresAt: toDate(dto.expiresAt),
        usageLimitGlobal: dto.usageLimitGlobal,
        usageLimitPerUser: dto.usageLimitPerUser,
      }),
    );
  }

  /** F-CPN-01's activate/deactivate. `200` — it transitions an existing coupon. */
  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  async setActive(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') couponId: string,
    @Body() dto: SetCouponActiveDto,
  ): Promise<CouponResponse> {
    return toCouponResponse(
      await this.manageCoupon.setActive({
        actorUserId: user.userId,
        couponId,
        isActive: dto.isActive,
      }),
    );
  }
}

/**
 * `undefined` stays `undefined` ("leave alone"); an explicit `null` clears the field. The DTO's
 * `@IsDateString` has already rejected anything that is not a valid ISO date, so this cannot
 * produce an `Invalid Date`.
 */
function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : new Date(value);
}
