import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  FINANCE_REFUND_PERMISSION,
  RefundInitiator,
  RefundPaymentCommand,
} from '../../application/commands/refund-payment.command';
import { ListPaymentRefundsQuery } from '../../application/queries/list-payment-refunds.query';
import { RequireIdempotencyKey } from '../decorators/idempotency-key.decorator';
import { RefundPaymentDto } from '../dtos/refund.dto';
import {
  PaymentRefundsResponse,
  RefundPaymentResponse,
  toRefundResponse,
} from '../dtos/refund.response';

/**
 * Refunds HTTP surface (`architecture/module-07-payment-wallet.md` §9.3).
 *
 * As thin as `PaymentController`, and for the same reason. Eligibility (`RefundPolicy`),
 * BRULE-24's over-refund invariant, the full-vs-partial classification, provider selection by the
 * gateway that actually took the money, the `Serializable` reservation, ADR-016's cumulative fee
 * clawback, ADR-018's `PARTIALLY_REFUNDED -> REFUNDED` transition, idempotency, audit and outbox
 * all live in `RefundPaymentCommand` and are neither re-implemented nor second-guessed here. This
 * class maps HTTP ↔ command/query and nothing else.
 *
 * **No amount arithmetic happens in this file.** An omitted `amount` is forwarded as omitted, and
 * the command derives the remaining refundable total inside the same transaction that inserts the
 * refund — which is what makes the over-refund check hold under concurrency. A remainder computed
 * here would be stale before it was used.
 *
 * **Identity always comes from the verified access token.** No route reads a customer or actor id
 * from a body, query or path, and `RefundPaymentDto` has no such field for a client to supply.
 *
 * Errors are not caught. Every failure the application layer raises is already an `ApiException`
 * carrying a canonical `ErrorCode` — `REFUND_NOT_ELIGIBLE` (422), `REFUND_EXCEEDS_CAPTURED` (422),
 * `INVALID_PAYMENT_STATE_TRANSITION` (409), `IDEMPOTENCY_CONFLICT` (409), `RBAC_FORBIDDEN` (403),
 * `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `DEPENDENCY_UNAVAILABLE` (503) — and the global
 * `AllExceptionsFilter` maps each to its status and envelope. A try/catch here would duplicate
 * that mapping and risk diverging from it. Provider failures are already sanitized before they
 * are raised or persisted (`sanitizeProviderFailureReason`), so no gateway payload, credential or
 * signature can reach a response through this controller.
 *
 * §9.4–§9.6's wallet, coupon and settlement routes remain absent: their application features do
 * not exist yet, and a route without a command behind it is not an API.
 */
@Controller('payments')
export class PaymentRefundController {
  constructor(
    private readonly refundPayment: RefundPaymentCommand,
    private readonly listRefunds: ListPaymentRefundsQuery,
  ) {}

  /**
   * §9.3 `POST /payments/{id}/refunds` — `{ amount?, reason, destination }`, amount omitted = full.
   *
   * `201` (Nest's `@Post` default) because a `Refund` resource is created — including when the
   * gateway's answer was ambiguous, where the refund exists as `PENDING` and only the provider
   * confirmation is outstanding.
   *
   * ## Authorization
   *
   * `finance:refund:any`, exactly as §9.3 requires, and there is deliberately **no second
   * authorization system here**. The guard is the transport-level boundary; the real check lives
   * in `RefundPaymentCommand.assertMayInitiate`, which this route feeds with the caller's own
   * verified permissions so an in-process caller cannot reach the manual path by bypassing HTTP.
   * Both gates consult the same permission through the same `hasPermission` matcher.
   *
   * There is no customer self-service refund route because there is no customer refund
   * permission: the RBAC catalog grants `finance:refund:any` to `FINANCE_OFFICER` alone, §9.3
   * names only that permission, and the command refuses every `MANUAL` refund without it. A
   * customer's refund therefore reaches Module 07 as an approved manual refund or as a `SYSTEM`
   * refund from the triggering module's saga (ADR-017) — never as a self-served HTTP call. This
   * route does not invent an approval workflow on top of that.
   *
   * `initiator` is fixed to `MANUAL` and never read from the body: an HTTP caller is by
   * definition a human decision, and letting a request name itself `SYSTEM` would be a way to
   * skip the permission check and leave `approvedBy` empty.
   */
  @Post(':id/refunds')
  @RequirePermissions(FINANCE_REFUND_PERMISSION)
  async refund(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') paymentId: string,
    @Body() dto: RefundPaymentDto,
    @RequireIdempotencyKey() idempotencyKey: string,
  ): Promise<RefundPaymentResponse> {
    return toRefundResponse(
      await this.refundPayment.execute({
        // From the route and the verified token, never the body.
        paymentId,
        actorUserId: user.userId,
        actorPermissions: user.permissions ?? [],
        initiator: RefundInitiator.MANUAL,
        // Forwarded as given: `undefined` is §9.3's "refund everything still refundable", and
        // resolving it here would move a money decision out of the transaction that protects it.
        amount: dto.amount,
        reason: dto.reason,
        destination: dto.destination,
        idempotencyKey,
      }),
    );
  }

  /**
   * §9.3 `GET /payments/{id}/refunds` — the payment's refunds, plus the captured, refunded and
   * still-refundable totals the query derives.
   *
   * `payment:read:own` and caller-scoped, exactly like `GET /payments/{id}`: the customer id is
   * passed into the query, which resolves a payment belonging to someone else to the same
   * `NOT_FOUND` as one that does not exist. Ownership is enforced inside the query rather than
   * here, so every future caller inherits it and the two cannot drift apart.
   */
  @Get(':id/refunds')
  @RequirePermissions('payment:read:own')
  list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') paymentId: string,
  ): Promise<PaymentRefundsResponse> {
    return this.listRefunds.execute({ paymentId, customerUserId: user.userId });
  }
}
