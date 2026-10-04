import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  CouponValidationView,
  ValidateCouponQuery,
} from '../../application/queries/validate-coupon.query';
import { ValidateCouponDto } from '../dtos/coupon.dto';

/**
 * Customer coupon surface (`architecture/module-07-payment-wallet.md` §9.5).
 *
 * One route, and it changes nothing: `POST /coupons/validate` answers "would this code help me,
 * and by how much". No redemption row, no usage consumed, no ledger posting, no outbox event.
 * `ApplyCouponCommand` is what spends a usage, and it is reached only in-process through
 * `ICouponPort` — §9.5 defines no customer route that applies a coupon, and adding one would let a
 * customer consume their own allowance outside a checkout.
 *
 * **Identity always comes from the verified access token.** The DTO has no `userId` field and
 * `forbidNonWhitelisted` rejects one, so a customer cannot validate against someone else's cart or
 * spend someone else's per-user allowance. `cartTotal` and `items` are accepted because §9.5's
 * request shape includes them, but they are assertions to check rather than inputs — see
 * `ValidateCouponDto`.
 *
 * `200`, not `201`: nothing is created. And a coupon that does not apply is still a `200` with
 * `valid: false`, because §9.5's documented response is `{ valid, discountAmount, reason? }` —
 * "this code will not help you" is the successful answer to a validation question. §12's
 * `COUPON_INVALID`/`COUPON_EXPIRED`/`COUPON_USAGE_EXCEEDED` are raised where a coupon actually
 * blocks an operation, which is application, not validation.
 *
 * `payment:create:own` is the permission, not a new `coupon:validate:own`: validating a coupon is
 * part of the customer's own checkout/payment journey, the catalog defines no customer coupon
 * permission, and §9.5 names one only for the admin side. Inventing a second customer permission
 * for a read that changes nothing would widen the catalog for no gain.
 */
@Controller('coupons')
export class CouponController {
  constructor(private readonly validateCoupon: ValidateCouponQuery) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payment:create:own')
  validate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: ValidateCouponDto,
  ): Promise<CouponValidationView> {
    return this.validateCoupon.execute({
      // From the verified token, never the body.
      customerUserId: user.userId,
      code: dto.code,
      cartTotal: dto.cartTotal,
      // `dto.items` is deliberately not forwarded. The query resolves the caller's real active
      // cart; a client-supplied item list would let the caller choose what gets discounted.
    });
  }
}
