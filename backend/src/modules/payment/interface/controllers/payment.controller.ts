import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { AuthorizePaymentCommand } from '../../application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../application/commands/capture-payment.command';
import { VoidPaymentCommand } from '../../application/commands/void-payment.command';
import { GetPaymentQuery, PaymentView } from '../../application/queries/get-payment.query';
import { RequireIdempotencyKey } from '../decorators/idempotency-key.decorator';
import {
  AuthorizePaymentDto,
  CapturePaymentDto,
  VoidPaymentDto,
} from '../dtos/payment.dto';
import {
  AuthorizePaymentResponse,
  CapturePaymentResponse,
  toAuthorizeResponse,
  toCaptureResponse,
  toVoidResponse,
  VoidPaymentResponse,
} from '../dtos/payment.response';

/**
 * Payments HTTP surface (`architecture/module-07-payment-wallet.md` §9.1).
 *
 * Deliberately thin, exactly like `CheckoutController`: gateway selection, the intent-first
 * persistence, provider idempotency, the §6 state machine, ledger postings, audit and outbox all
 * live in the commands and are neither re-implemented nor second-guessed here. This class maps
 * HTTP ↔ command and nothing else.
 *
 * **Identity always comes from the verified access token.** No route reads a customer id from a
 * body, query or path, and the DTOs have no such field for a client to supply. Ownership itself
 * is enforced inside the commands and `GetPaymentQuery`, so this controller adds no parallel
 * check that could drift from theirs.
 *
 * Errors are not caught. Every failure the application layer raises is already an `ApiException`
 * carrying a canonical `ErrorCode` — `PAYMENT_AUTH_FAILED` (402), `PAYMENT_CAPTURE_FAILED` (402),
 * `PAYMENT_ALREADY_CAPTURED` (409), `INVALID_PAYMENT_STATE_TRANSITION` (409),
 * `IDEMPOTENCY_CONFLICT` (409), `DEPENDENCY_UNAVAILABLE` (503), `ORDER_NOT_FOUND` (404),
 * `NOT_FOUND` (404), `VALIDATION_ERROR` (400) — and the global `AllExceptionsFilter` maps each to
 * its status and error envelope. A try/catch here would duplicate that mapping and risk diverging
 * from it.
 *
 * §9.3's refund routes live in `PaymentRefundController` — same prefix, same conventions, kept
 * separate because they are their own slice of the design. §9.4–§9.6's wallet, coupon and
 * settlement routes are still absent: their application features do not exist yet, and a route
 * without a command behind it is not an API.
 */
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly authorizePayment: AuthorizePaymentCommand,
    private readonly capturePayment: CapturePaymentCommand,
    private readonly voidPayment: VoidPaymentCommand,
    private readonly getPayment: GetPaymentQuery,
  ) {}

  /**
   * §9.1 `POST /payments/authorize` → `{ paymentId, status, providerRedirect? }`.
   *
   * `201` (Nest's `@Post` default) because a `Payment` is created — including in the async case,
   * where the payment exists as `INITIATED` and only the gateway confirmation is outstanding.
   */
  @Post('authorize')
  @RequirePermissions('payment:create:own')
  async authorize(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: AuthorizePaymentDto,
    @RequireIdempotencyKey() idempotencyKey: string,
  ): Promise<AuthorizePaymentResponse> {
    return toAuthorizeResponse(
      await this.authorizePayment.execute({
        // From the verified token, never the body (§7's own-resource discipline).
        customerUserId: user.userId,
        orderId: dto.orderId,
        method: dto.method,
        amount: dto.amount,
        currency: dto.currency,
        providerToken: dto.token,
        returnUrl: dto.returnUrl,
        idempotencyKey,
      }),
    );
  }

  /**
   * §9.1 `GET /payments/{id}` — status + refs, scoped to the caller.
   *
   * The customer id is passed into the query so a payment belonging to someone else resolves to
   * the same `404` as one that does not exist.
   */
  @Get(':id')
  @RequirePermissions('payment:read:own')
  get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') paymentId: string,
  ): Promise<PaymentView> {
    return this.getPayment.execute({ paymentId, customerUserId: user.userId });
  }

  /**
   * §9.1 `POST /payments/{id}/capture`. `200`, not `201`: capture transitions an existing payment
   * rather than creating a resource.
   *
   * `payment:capture:any` (finance/admin), not a customer or pharmacy permission: §9.1 describes
   * capture as an internal saga operation, whose normal path is Module 06 calling the exported
   * inbound port in-process. This route exists for operational intervention.
   *
   * The body is empty by contract — the amount, currency, gateway and provider payable owner all
   * come from the persisted payment and its order.
   */
  @Post(':id/capture')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payment:capture:any')
  async capture(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') paymentId: string,
    // Both parameters exist for their decorators' validation side effects and are intentionally
    // not read: `@Body()` makes `forbidNonWhitelisted` reject any field a client tries to send,
    // and `@RequireIdempotencyKey()` enforces §9's header requirement. Removing them would
    // silently drop both checks.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Body() _dto: CapturePaymentDto,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @RequireIdempotencyKey() _idempotencyKey: string,
  ): Promise<CapturePaymentResponse> {
    // The key is required by §9 and validated on the way in, but capture's idempotency identity
    // is the payment itself: `CapturePaymentCommand` replays from the payment's own state and the
    // unique `CAPTURE-<paymentId>` ledger reference, not from a caller-supplied key. Passing one
    // in would imply a second, weaker guard.
    return toCaptureResponse(
      await this.capturePayment.execute({ paymentId, actorUserId: user.userId }),
    );
  }

  /** §9.1 `POST /payments/{id}/void` — releases an authorization hold before capture. */
  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payment:void:any')
  async void(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') paymentId: string,
    @Body() dto: VoidPaymentDto,
    // Enforces §9's header requirement; void's idempotency identity is the payment's own state.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @RequireIdempotencyKey() _idempotencyKey: string,
  ): Promise<VoidPaymentResponse> {
    return toVoidResponse(
      await this.voidPayment.execute({
        paymentId,
        actorUserId: user.userId,
        reason: dto.reason,
      }),
    );
  }
}
