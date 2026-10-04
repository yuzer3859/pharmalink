import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { CheckoutCommand, CheckoutResult } from '../../application/commands/checkout.command';
import { QuoteCheckoutCommand } from '../../application/commands/quote-checkout.command';
import { CheckoutDto, CheckoutQuoteDto } from '../dtos/checkout.dto';
import { CheckoutResponse, toCheckoutResponse } from '../dtos/checkout.response';

/**
 * COD checkout (`06-orders-spec.md` §9.2, customer — `order:create:own` per §241). Returns `201`,
 * Nest's default for `@Post`, matching §287's documented `201 { orderId, orderNumber, status }`.
 *
 * Deliberately thin: the Rx gate, matching, stock reservation, pricing, order/fulfillment/invoice
 * creation, the `Serializable` transaction, compensation and idempotency all live in
 * `CheckoutCommand` (Task 5) and are not re-implemented, re-ordered or second-guessed here. This
 * class only maps HTTP <-> command, exactly like `MatchingController` does for Module 05.
 *
 * Errors are not caught: every failure the saga raises is already an `ApiException` carrying a
 * canonical `ErrorCode` (`RX_REQUIRED`/`PRESCRIPTION_EXPIRED`/`PRESCRIPTION_EXHAUSTED` via
 * `OrdersErrors.rxGateBlocked`, `NO_PHARMACY_MATCH`/`MATCH_CANDIDATE_UNAVAILABLE`/
 * `INSUFFICIENT_STOCK` from Modules 04/05's ports, `IDEMPOTENCY_CONFLICT`, `NOT_FOUND`,
 * `CATALOG_PRODUCT_NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`), and the global
 * `AllExceptionsFilter` maps each to its HTTP status and error envelope. Adding a try/catch here
 * would duplicate that mapping and risk diverging from it.
 */
@Controller('checkout')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutCommand,
    private readonly quote: QuoteCheckoutCommand,
  ) {}

  /**
   * §9.2 `POST /checkout/quote` → `200 { rxGateResult, candidates, totals }`, no order created.
   * 200 rather than `@Post`'s default 201 precisely because nothing is created.
   */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:create:own')
  createQuote(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CheckoutQuoteDto) {
    return this.quote.execute({
      customerUserId: user.userId,
      addressId: dto.addressId,
      deliverySlot: dto.deliverySlot,
    });
  }

  @Post()
  @RequirePermissions('order:create:own')
  async create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: CheckoutDto,
  ): Promise<CheckoutResponse> {
    // `customerUserId` comes from the verified access token, never from the request body — the
    // DTO has no customer/user field for a client to supply (§7's own-resource discipline).
    const result: CheckoutResult = await this.checkout.execute({
      customerUserId: user.userId,
      addressId: dto.addressId,
      deliverySlot: dto.deliverySlot,
      idempotencyKey: dto.idempotencyKey,
      // Only the code. Which pharmacy it is scored against, which lines are eligible and what the
      // discount is worth are all decided server-side (ADR-020) — the DTO carries none of them.
      couponCode: dto.couponCode,
    });

    return toCheckoutResponse(result);
  }
}
