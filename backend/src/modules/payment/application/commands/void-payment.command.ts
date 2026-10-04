import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { Payment, PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import { PaymentStatusPolicy } from '../../domain/services/payment-status-policy';
import {
  IPaymentProviderRegistry,
  PAYMENT_PROVIDER_REGISTRY,
  ProviderVoidResult,
} from '../ports/outbound/payment-provider.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithPaymentRetry } from '../support/payment-retry';
import { sanitizeProviderFailureReason } from '../support/sanitize-provider-failure';

export interface VoidPaymentInput {
  paymentId: string;
  /** Recorded in the audit trail (§13) — typically the customer or the admin who cancelled. */
  actorUserId?: string | null;
  /** Free-text cancellation reason, recorded in the audit trail. */
  reason?: string | null;
}

export interface VoidPaymentResult {
  paymentId: string;
  status: PaymentStatus;
  providerRef: string | null;
  /** `true` when an already-voided payment was returned rather than a new void performed. */
  replay: boolean;
}

/**
 * `POST /payments/{id}/void` (§3.1 F-PAY-02, §6 `AUTHORIZED -> VOIDED`).
 *
 * Releases an authorization hold before any money is captured — the compensation path when an
 * order is cancelled after authorization but before fulfillment. Nothing was ever collected, so
 * **no ledger posting is made**: the ledger records money that moved, and a released hold moved
 * none. (This is not the same as a refund, which reverses a *capture* and does post — BRULE-24,
 * a later task.)
 *
 * ## Order of operations
 *
 *  1. Load the payment. An already-`VOIDED` payment returns as a replay — cancellation signals
 *     can legitimately arrive twice.
 *  2. A `CAPTURED`/`SETTLED`/refunded payment is refused with `PAYMENT_ALREADY_CAPTURED` (§9):
 *     money has moved, and the correct instrument is a refund, not a void. Every other illegal
 *     state falls to `PaymentStatusPolicy`, which remains the single authority — this command
 *     adds no transitions and extends the policy in no way, because §6 already defines
 *     `AUTHORIZED -> VOIDED` exactly as needed.
 *  3. **Provider void — outside every database transaction**, for the same reasons as capture.
 *  4. One `Serializable` transaction: the `AUTHORIZED -> VOIDED` transition plus its audit entry.
 *
 * ## Outcomes
 *
 *  - `VOIDED` / `ALREADY_VOIDED` — success. `ALREADY_VOIDED` is exactly what a gateway returns
 *    for an idempotent retry, so it is normalized to success rather than surfaced as an error;
 *    the local state simply catches up with the gateway's.
 *  - `FAILED` — the gateway refused. The payment stays `AUTHORIZED`, because the hold is still
 *    live; reporting it as voided would misstate the customer's real position.
 *  - `UNKNOWN`, or a thrown error — the outcome is undetermined. The payment stays `AUTHORIZED`
 *    and `DEPENDENCY_UNAVAILABLE` is raised. Retrying is safe: `voidAuthorization` is
 *    contractually idempotent on `paymentId`.
 *
 * ## Events
 *
 * None. The design's event catalogue (§10, `00-domain-event-catalog.md`) defines
 * `PaymentAuthorized`/`PaymentCaptured`/`PaymentFailed`/`PaymentRefunded` and **no**
 * `PaymentVoided`. The void is therefore recorded in the audit log and the payment's own state,
 * with no outbox write — an uncatalogued event with no consumer is not invented here.
 */
@Injectable()
export class VoidPaymentCommand {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly providers: IPaymentProviderRegistry,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: VoidPaymentInput): Promise<VoidPaymentResult> {
    if (!input.paymentId || input.paymentId.trim().length === 0) {
      throw PaymentErrors.validation('paymentId is required.', { field: 'paymentId' });
    }
    const payment = await this.payments.findById(input.paymentId);
    if (!payment) {
      throw PaymentErrors.notFound('Payment not found.', { paymentId: input.paymentId });
    }

    // Step 1 — a repeated void is a retry, not an error.
    if (payment.status === PaymentStatus.VOIDED) {
      return {
        paymentId: payment.id,
        status: payment.status,
        providerRef: payment.providerRef,
        replay: true,
      };
    }

    // Step 2 — money that has already moved cannot be voided; that is a refund (BRULE-24).
    if (
      payment.status === PaymentStatus.CAPTURED ||
      payment.status === PaymentStatus.SETTLED ||
      payment.status === PaymentStatus.REFUNDED ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw PaymentErrors.paymentAlreadyCaptured(payment.id, payment.status);
    }
    // Everything else (INITIATED, FAILED, EXPIRED) is rejected by the existing §6 policy.
    PaymentStatusPolicy.assertValidTransition(payment.status, PaymentStatus.VOIDED);

    // Step 3 — the gateway call, outside every transaction.
    const outcome = await this.voidWithProvider(payment);

    // Step 4 — transition + audit, atomically. No ledger posting, no outbox event.
    const aggregate = Payment.rehydrate(payment);
    const now = new Date();
    aggregate.voidAuthorization(now);
    const providerRef = outcome.providerRef ?? payment.providerRef;

    const voided = await runWithPaymentRetry(this.uow, async (tx) => {
      const row = await this.payments.updateState(
        payment.id,
        { status: aggregate.status, providerRef },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: input.actorUserId ?? null,
          action: 'PAYMENT_VOIDED',
          resourceType: 'Payment',
          resourceId: payment.id,
          context: {
            orderId: payment.orderId,
            paymentId: payment.id,
            amount: payment.amount,
            currency: payment.currency,
            method: payment.method,
            provider: payment.provider,
            providerRef,
            outcome: outcome.outcome,
            reason: input.reason ?? null,
          },
        },
        tx,
      );
      return row;
    });

    return {
      paymentId: voided.id,
      status: voided.status,
      providerRef: voided.providerRef,
      replay: false,
    };
  }

  private async voidWithProvider(payment: PaymentProps): Promise<ProviderVoidResult> {
    const request = {
      paymentId: payment.id,
      providerRef: payment.providerRef,
      orderId: payment.orderId,
      method: payment.method,
      amount: payment.amount,
      currency: payment.currency,
    };

    // Only the gateway holding the authorization can release it.
    const provider = this.providers.forKey(payment.provider);

    let result: ProviderVoidResult;
    try {
      result = await provider.voidAuthorization(request);
    } catch (err) {
      throw PaymentErrors.providerUnavailable({
        paymentId: payment.id,
        operation: 'void',
        provider: payment.provider,
        cause: sanitizeProviderFailureReason(
          err instanceof Error ? err.message : String(err ?? ''),
        ),
      });
    }

    if (result.outcome === 'UNKNOWN') {
      throw PaymentErrors.providerUnavailable({
        paymentId: payment.id,
        operation: 'void',
        provider: payment.provider,
        cause: 'The provider could not confirm whether the authorization was released.',
      });
    }

    if (result.outcome === 'FAILED') {
      const reason = sanitizeProviderFailureReason(result.failureReason);
      await this.audit.record({
        actorUserId: null,
        action: 'PAYMENT_VOID_FAILED',
        resourceType: 'Payment',
        resourceId: payment.id,
        context: {
          orderId: payment.orderId,
          paymentId: payment.id,
          provider: payment.provider,
          providerRef: payment.providerRef,
          outcome: 'FAILED',
          failureReason: reason,
          failureCode: result.failureCode ?? null,
        },
      });
      throw PaymentErrors.paymentVoidFailed(reason, {
        paymentId: payment.id,
        orderId: payment.orderId,
        failureCode: result.failureCode ?? null,
      });
    }

    // VOIDED and ALREADY_VOIDED both mean the hold is released — one transition either way.
    return result;
  }
}
