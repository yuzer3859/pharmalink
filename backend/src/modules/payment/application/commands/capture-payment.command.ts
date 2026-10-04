import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { Payment, PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { paymentCapturedEvent } from '../../domain/events';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import { CaptureSplit } from '../../domain/services/fee-calculator';
import { PaymentStatusPolicy } from '../../domain/services/payment-status-policy';
import {
  CaptureAccountingService,
  captureLedgerReference,
} from '../services/capture-accounting.service';
import {
  IPaymentProviderRegistry,
  PAYMENT_PROVIDER_REGISTRY,
  ProviderCaptureResult,
} from '../ports/outbound/payment-provider.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';
import { sanitizeProviderFailureReason } from '../support/sanitize-provider-failure';

export interface CapturePaymentInput {
  paymentId: string;
  /**
   * Who/what triggered the capture, for the audit trail (§13). Capture is driven by fulfillment
   * ("order ready"), not by the customer, so this is typically the acting pharmacy user or
   * `null` for a system-driven capture — never used for authorization decisions here.
   */
  actorUserId?: string | null;
}

export interface CapturePaymentResult {
  paymentId: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  /** Platform commission credited to `PLATFORM_REVENUE` (BRULE-23). */
  fee: number;
  /**
   * Credited to the provider's `PROVIDER_PAYABLE`. Under ADR-019's platform-funded coupons this is
   * `amount - fee + promotionExpense` — the pharmacy is paid as if no coupon had been used, so it
   * can legitimately exceed `amount - fee`.
   */
  providerNet: number;
  /** Debited to `PROMOTION_EXPENSE` — the platform-funded coupon discount (ADR-019). */
  promotionExpense: number;
  providerRef: string | null;
  /** The `ledger_transactions.reference` of the capture posting. */
  ledgerReference: string | null;
  /** `true` when an already-captured payment was returned rather than a new capture performed. */
  replay: boolean;
}

/**
 * Re-exported for callers that already import it from here. The reference, and §11.3's posting
 * itself, now live in `CaptureAccountingService` because a capture webhook finalizes the same
 * money through the same accounting (see that service's doc comment).
 */
export { captureLedgerReference };

/**
 * `POST /payments/{id}/capture` (§3.1 F-PAY-02, §6, §11.3, BRULE-23).
 *
 * ## Order of operations
 *
 *  1. Load the payment. An already-`CAPTURED` payment returns its existing capture as a replay —
 *     capture is driven by fulfillment signals that can legitimately arrive twice, so a repeat is
 *     a retry, not an error.
 *  2. `PaymentStatusPolicy.assertValidTransition(status, CAPTURED)` — the single authority on
 *     which states may capture. Only `AUTHORIZED` may; every other state is rejected by the
 *     existing policy, so this command adds no state rules of its own.
 *  3. Resolve the order, its provider, and the fee split — **before** the gateway is called, so a
 *     resolution failure cannot strand money that has already moved.
 *  4. Resolve the three ledger accounts through `LedgerService` (`AccountRef`, never hard-coded
 *     ids).
 *  5. **Provider capture — outside every database transaction** (see below).
 *  6. One `Serializable` transaction: the `AUTHORIZED -> CAPTURED` transition, the balanced
 *     three-leg ledger posting, the audit entry and the `payment.captured` event, together
 *     (ADR-010/ADR-013). Either all of it commits or none of it does.
 *
 * ## The ambiguous-outcome rule
 *
 * Capture is the step that actually moves the customer's money, so the three provider outcomes
 * are handled very differently:
 *
 *  - `FAILED` — a positive decline. The payment **stays `AUTHORIZED`**: §6 defines no
 *    `AUTHORIZED -> FAILED` transition, and that is not an oversight — a declined capture leaves
 *    the authorization live, so it can be retried or voided. No ledger posting is made.
 *  - `UNKNOWN`, or a thrown provider error — the outcome cannot be determined. Nothing is
 *    transitioned and nothing is posted; the payment stays `AUTHORIZED` and
 *    `DEPENDENCY_UNAVAILABLE` is raised. Recording a capture we are not sure happened would put
 *    money in the ledger that may not exist; recording a failure would hide money that may. Any
 *    `providerRef` the gateway did return is persisted, because it is what reconciliation will
 *    match on.
 *  - `ALREADY_CAPTURED` — the gateway's normal answer to an idempotent retry. Treated as success.
 *
 * Retrying after `UNKNOWN` is safe because `IPaymentProviderPort.capture` is contractually
 * idempotent on `paymentId` — the guarantee has to live at the gateway, since no application-side
 * lock can prevent a double charge once the request has left the process.
 *
 * ## Provider capture succeeded, local commit failed
 *
 * The payment stays `AUTHORIZED` with its authorization `providerRef` persisted, and the gateway
 * holds a capture keyed by this `paymentId`. Nothing is marked failed and nothing re-captures on
 * its own. A retry re-enters at step 1, and the provider returns `ALREADY_CAPTURED`, so the local
 * state catches up without moving money again. Closing this window automatically belongs to the
 * webhook/reconciliation task (§11.2, §3.6 F-REC-01), which is out of scope here — the state is
 * recoverable by construction, not yet automatically recovered.
 */
@Injectable()
export class CapturePaymentCommand {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly providers: IPaymentProviderRegistry,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly captureAccounting: CaptureAccountingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: CapturePaymentInput): Promise<CapturePaymentResult> {
    const payment = await this.loadPayment(input.paymentId);

    // Step 1 — an already-captured payment is a retry, not an error (§7's idempotency contract).
    if (payment.status === PaymentStatus.CAPTURED) {
      return this.replayResult(payment);
    }

    // Step 2 — the existing policy is the only authority on which states may capture.
    PaymentStatusPolicy.assertValidTransition(payment.status, PaymentStatus.CAPTURED);

    // Step 3 — fee split and provider account owner, both resolved before money moves, so a
    // resolution failure cannot strand a capture that already happened at the gateway.
    const split = await this.captureAccounting.resolveSplit(payment);
    const pharmacyId = await this.captureAccounting.resolveProviderPharmacyId(payment.orderId);

    // Step 4 — the gateway call, outside every transaction.
    const outcome = await this.captureWithProvider(payment);

    // Step 5 — transition + ledger + audit + event, atomically.
    return this.persistCapture(payment, outcome, split, pharmacyId, input.actorUserId ?? null);
  }

  private async loadPayment(paymentId: string): Promise<PaymentProps> {
    if (!paymentId || paymentId.trim().length === 0) {
      throw PaymentErrors.validation('paymentId is required.', { field: 'paymentId' });
    }
    const payment = await this.payments.findById(paymentId);
    if (!payment) {
      throw PaymentErrors.notFound('Payment not found.', { paymentId });
    }
    return payment;
  }

  private async captureWithProvider(payment: PaymentProps): Promise<ProviderCaptureResult> {
    const request = {
      paymentId: payment.id,
      providerRef: payment.providerRef,
      orderId: payment.orderId,
      method: payment.method,
      // The full authorized amount. Partial capture is not defined anywhere in this design, so
      // no caller-supplied amount is accepted and none is derived.
      amount: payment.amount,
      currency: payment.currency,
    };

    // The gateway that authorized this payment is the only one that can capture it — resolved by
    // the key recorded on the payment, never re-resolved from the method.
    const provider = this.providers.forKey(payment.provider);

    let result: ProviderCaptureResult;
    try {
      result = await provider.capture(request);
    } catch (err) {
      // A thrown error is an UNKNOWN outcome, never a failure — see the class doc.
      throw PaymentErrors.providerUnavailable({
        paymentId: payment.id,
        operation: 'capture',
        provider: payment.provider,
        cause: sanitizeProviderFailureReason(
          err instanceof Error ? err.message : String(err ?? ''),
        ),
      });
    }

    if (result.outcome === 'UNKNOWN') {
      // Persist any reference the gateway did give us — it is reconciliation's match key — but
      // change no state: `updateState` is called with the payment's current status, so this is a
      // field write, not a transition.
      if (result.providerRef && result.providerRef !== payment.providerRef) {
        await this.payments.updateState(payment.id, {
          status: payment.status,
          providerRef: result.providerRef,
        });
      }
      throw PaymentErrors.providerUnavailable({
        paymentId: payment.id,
        operation: 'capture',
        provider: payment.provider,
        cause: 'The provider could not confirm whether the capture completed.',
      });
    }

    if (result.outcome === 'FAILED') {
      const reason = sanitizeProviderFailureReason(result.failureReason);
      // No transition: §6 has no AUTHORIZED -> FAILED edge, so the authorization stays live and
      // no ledger posting is made. Recorded in the audit trail only — the design catalogues no
      // capture-failure event, and inventing one is out of the question.
      await this.audit.record({
        actorUserId: null,
        action: 'PAYMENT_CAPTURE_FAILED',
        resourceType: 'Payment',
        resourceId: payment.id,
        context: {
          ...this.auditContext(payment),
          outcome: 'FAILED',
          failureReason: reason,
          failureCode: result.failureCode ?? null,
        },
      });
      throw PaymentErrors.paymentCaptureFailed(reason, {
        paymentId: payment.id,
        orderId: payment.orderId,
        failureCode: result.failureCode ?? null,
      });
    }

    return result;
  }

  private async persistCapture(
    payment: PaymentProps,
    outcome: ProviderCaptureResult,
    split: CaptureSplit,
    pharmacyId: string,
    actorUserId: string | null,
  ): Promise<CapturePaymentResult> {
    const aggregate = Payment.rehydrate(payment);
    const now = new Date();
    const providerRef = outcome.providerRef ?? payment.providerRef;
    aggregate.capture(now, providerRef);
    const props = aggregate.toProps();
    const reference = captureLedgerReference(payment.id);

    try {
      const captured = await runWithPaymentRetry(this.uow, async (tx) => {
        const row = await this.payments.updateState(
          payment.id,
          { status: props.status, capturedAt: props.capturedAt, providerRef },
          tx,
        );

        // §11.3's balanced three-leg posting, through the shared accounting service so this
        // command and the capture webhook can never post it differently.
        await this.captureAccounting.post(payment, split, pharmacyId, tx);

        await this.audit.record(
          {
            actorUserId,
            action: 'PAYMENT_CAPTURED',
            resourceType: 'Payment',
            resourceId: payment.id,
            context: {
              ...this.auditContext(row),
              outcome: outcome.outcome,
              providerRef,
              fee: split.fee.amountMinor,
              providerNet: split.providerNet.amountMinor,
              promotionExpense: split.promotionExpense.amountMinor,
              ledgerReference: reference,
            },
          },
          tx,
        );

        await this.outbox.write(
          paymentCapturedEvent({
            paymentId: payment.id,
            orderId: payment.orderId,
            fee: split.fee.amountMinor,
          }),
          tx as OutboxCapableClient,
        );

        return row;
      });

      return {
        paymentId: captured.id,
        status: captured.status,
        amount: captured.amount,
        currency: captured.currency,
        fee: split.fee.amountMinor,
        providerNet: split.providerNet.amountMinor,
        promotionExpense: split.promotionExpense.amountMinor,
        providerRef: captured.providerRef,
        ledgerReference: reference,
        replay: false,
      };
    } catch (err) {
      // A duplicate capture reference means a concurrent capture already committed for this
      // payment. The unique index on `ledger_transactions.reference` is the backstop that makes
      // concurrent captures produce exactly one posting; the loser returns the winner's result.
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.payments.findById(payment.id);
        if (winner && winner.status === PaymentStatus.CAPTURED) {
          return this.replayResult(winner);
        }
      }
      throw err;
    }
  }

  private replayResult(payment: PaymentProps): CapturePaymentResult {
    return {
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      // Not re-derived on a replay: the authoritative record of how this capture was split is the
      // committed ledger posting, not a recomputation that could disagree with it.
      fee: 0,
      providerNet: 0,
      promotionExpense: 0,
      providerRef: payment.providerRef,
      ledgerReference: captureLedgerReference(payment.id),
      replay: true,
    };
  }

  /** §13's required capture audit fields. Never a token, secret or raw provider payload. */
  private auditContext(payment: PaymentProps): Record<string, unknown> {
    return {
      orderId: payment.orderId,
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      provider: payment.provider,
    };
  }
}
