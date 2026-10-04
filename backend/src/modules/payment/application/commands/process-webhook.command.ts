import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { Payment, PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { paymentAuthorizedEvent, paymentCapturedEvent, paymentFailedEvent } from '../../domain/events';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import {
  IWebhookRepository,
  WEBHOOK_REPOSITORY,
} from '../../domain/repositories/webhook.repository';
import { CaptureSplit } from '../../domain/services/fee-calculator';
import { PaymentStatusPolicy } from '../../domain/services/payment-status-policy';
import {
  IPaymentWebhookRegistry,
  PAYMENT_WEBHOOK_REGISTRY,
} from '../ports/outbound/payment-webhook.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { CaptureAccountingService } from '../services/capture-accounting.service';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';
import { sanitizeProviderFailureReason } from '../support/sanitize-provider-failure';
import {
  NormalizedWebhookEvent,
  RawWebhookDelivery,
  WEBHOOK_ALREADY_SATISFIED_BY,
  WEBHOOK_TARGET_STATUS,
  WebhookEventType,
} from '../webhooks/normalized-webhook-event';

/** What actually happened, for the caller and for the audit trail. */
export const WebhookOutcome = {
  /** The payment advanced to a new state. */
  Advanced: 'ADVANCED',
  /** This exact `(provider, eventId)` had already been processed. */
  Duplicate: 'DUPLICATE',
  /** The event's effect was already true — a late or out-of-order delivery. */
  AlreadyApplied: 'ALREADY_APPLIED',
  /** The event could not be classified; deferred to reconciliation (§8). */
  Deferred: 'DEFERRED',
} as const;

export type WebhookOutcome = (typeof WebhookOutcome)[keyof typeof WebhookOutcome];

export interface ProcessWebhookResult {
  webhookId: string | null;
  provider: string;
  eventId: string;
  outcome: WebhookOutcome;
  paymentId: string | null;
  status: PaymentStatus | null;
  /** Every value of this result is safe to answer `200` to (§9.2 "always 200 on accepted"). */
  accepted: true;
}

/**
 * `POST /webhooks/payments/{provider}` (§9.2, §11.2) — the recovery path for every payment the
 * intent-first flow deliberately leaves recoverable: an async authorization awaiting the
 * customer, a provider timeout, an unknown outcome, or a crash between the gateway call and the
 * local commit.
 *
 * ## Order of operations
 *
 *  1. **Select the provider adapter** by route segment. An unknown provider is refused.
 *  2. **Verify the signature** — before the payload is parsed, let alone trusted. A failure is
 *     audited as a security event and raises `WEBHOOK_SIGNATURE_INVALID`.
 *  3. **Normalize** the raw delivery into a {@link NormalizedWebhookEvent}. Past this line no raw
 *     provider payload travels anywhere except `provider_webhooks.payload` (§12).
 *  4. **Deduplicate and apply, in one transaction** (see below).
 *
 * ## Deduplication, and why the insert is the claim
 *
 * The `provider_webhooks` unique index on `(provider, eventId)` is the deduplication mechanism —
 * not a preceding "have I seen this?" read, which two concurrent deliveries would both pass. The
 * insert *is* the claim: whichever delivery inserts first owns the event, and the loser's
 * `P2002` is the signal that its copy is a replay.
 *
 * The insert and the business effects commit **together**, in one `Serializable` transaction:
 * the payment transition, the ledger posting where one applies, the audit entry, the outbox event
 * and `processedAt` all land atomically or not at all. That is what §9 requires — a webhook is
 * never marked processed before its effects are safe — and it means a failure leaves no
 * half-processed row: the provider retries and the whole thing runs cleanly.
 *
 * When processing fails, the delivery is still recorded afterwards in its own transaction with
 * `processedAt` left `null`, purely so a failed callback is visible to reconciliation and
 * forensics. A later retry of that same event finds the unprocessed row and re-drives it.
 *
 * ## Replays and races (§11)
 *
 * Three distinct situations, all answered with `200`:
 *
 *  - *Same event delivered twice* — `DUPLICATE`. One business effect, one event, one audit.
 *  - *Event whose effect is already true* — `ALREADY_APPLIED`. This is the webhook-versus-command
 *    race: the local `CapturePaymentCommand` committed while the capture callback was in flight,
 *    or `AuthorizePaymentCommand` recorded a synchronous authorization before the authorization
 *    callback arrived. §6's progression is linear, so a payment at or beyond an event's target
 *    has already had that event's effect — it is late news, not a contradiction. No second event
 *    is emitted and no second posting is made.
 *  - *Event we cannot classify* — `DEFERRED`. Recorded, audited, and left to reconciliation.
 *
 * A genuinely contradictory event (an authorization-failure callback for money already captured)
 * is neither of those: it is rejected through the existing `PaymentStatusPolicy`, and the
 * delivery is preserved unprocessed for investigation.
 *
 * ## What this command does not do
 *
 * It updates Module 07 payment state and emits the catalogued payment events. It does not touch
 * an order, release a reservation, or capture anything automatically — that orchestration is the
 * Orders-integration task's, driven by the events written here.
 */
@Injectable()
export class ProcessWebhookCommand {
  constructor(
    @Inject(PAYMENT_WEBHOOK_REGISTRY) private readonly registry: IPaymentWebhookRegistry,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(WEBHOOK_REPOSITORY) private readonly webhooks: IWebhookRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly captureAccounting: CaptureAccountingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(delivery: RawWebhookDelivery): Promise<ProcessWebhookResult> {
    // Step 1 — provider selection.
    const adapter = this.registry.forProvider(delivery.provider);
    if (!adapter) {
      throw PaymentErrors.webhookProviderUnsupported(delivery.provider);
    }

    // Step 2 — authenticity, before the payload is parsed or trusted.
    try {
      await adapter.verify(delivery);
    } catch (err) {
      // Audited as a security event (§13) with no signature, secret or body in the context.
      await this.audit.record({
        actorUserId: null,
        action: 'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
        resourceType: 'ProviderWebhook',
        resourceId: null,
        context: { provider: delivery.provider },
      });
      throw err;
    }

    // Step 3 — normalization. Raw payload goes no further than here and the webhook table.
    const event = await adapter.normalize(delivery);
    this.assertUsable(event, delivery.provider);

    // Step 4 — dedupe + apply, atomically.
    return this.claimAndApply(event, delivery);
  }

  /**
   * Structural validation of the normalized event. An event id is mandatory because it *is* the
   * deduplication key; without one the callback cannot be made idempotent at all, so it is
   * rejected rather than processed unsafely.
   */
  private assertUsable(event: NormalizedWebhookEvent, provider: string): void {
    if (typeof event.eventId !== 'string' || event.eventId.trim().length === 0) {
      throw PaymentErrors.webhookMalformed(provider, 'missing event id');
    }
    if (event.provider !== provider) {
      throw PaymentErrors.webhookMalformed(provider, 'provider mismatch');
    }
    if (!event.paymentId && !event.providerRef) {
      throw PaymentErrors.webhookMalformed(
        provider,
        'neither a payment id nor a provider reference',
      );
    }
    if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
      throw PaymentErrors.webhookMalformed(provider, 'invalid occurredAt');
    }
  }

  private async claimAndApply(
    event: NormalizedWebhookEvent,
    delivery: RawWebhookDelivery,
  ): Promise<ProcessWebhookResult> {
    const payment = await this.resolvePayment(event);
    const payload = this.parsePayload(delivery);

    try {
      return await runWithPaymentRetry(this.uow, async (tx) => {
        // The insert is the claim. A concurrent delivery of the same event loses here.
        const webhook = await this.webhooks.record(
          {
            provider: event.provider,
            eventId: event.eventId,
            payload,
            processedAt: new Date(),
          },
          tx,
        );
        return this.applyEffects(event, payment, webhook.id, tx);
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        return this.replayResult(event, payment);
      }
      // Business processing failed. Record the delivery unprocessed, best effort, so the failed
      // callback is visible to reconciliation — then surface the original failure.
      await this.recordUnprocessed(event, payload);
      throw err;
    }
  }

  /**
   * Applies the event's effect. Runs inside the caller's transaction, alongside the webhook row.
   */
  private async applyEffects(
    event: NormalizedWebhookEvent,
    payment: PaymentProps | null,
    webhookId: string,
    tx: unknown,
  ): Promise<ProcessWebhookResult> {
    // §8 — an event we cannot classify is recorded and deferred, never guessed at. No transition,
    // no ledger entry, no event: the payment stays exactly as recoverable as it was.
    if (event.type === WebhookEventType.Unknown || !payment) {
      await this.audit.record(
        {
          actorUserId: null,
          action: 'PAYMENT_WEBHOOK_DEFERRED',
          resourceType: payment ? 'Payment' : 'ProviderWebhook',
          resourceId: payment?.id ?? webhookId,
          context: {
            provider: event.provider,
            eventId: event.eventId,
            reason: payment ? 'unclassified event' : 'no matching payment',
            paymentId: payment?.id ?? null,
            providerRef: event.providerRef,
          },
        },
        tx,
      );
      return {
        webhookId,
        provider: event.provider,
        eventId: event.eventId,
        outcome: WebhookOutcome.Deferred,
        paymentId: payment?.id ?? null,
        status: payment?.status ?? null,
        accepted: true,
      };
    }

    const target = WEBHOOK_TARGET_STATUS[event.type];

    // The event's effect is already true — a late or out-of-order delivery, or the local command
    // won the race. Record it, audit it, change nothing, emit nothing.
    if (WEBHOOK_ALREADY_SATISFIED_BY[event.type].has(payment.status)) {
      await this.audit.record(
        {
          actorUserId: null,
          action: 'PAYMENT_WEBHOOK_ALREADY_APPLIED',
          resourceType: 'Payment',
          resourceId: payment.id,
          context: {
            provider: event.provider,
            eventId: event.eventId,
            paymentId: payment.id,
            orderId: payment.orderId,
            eventType: event.type,
            status: payment.status,
          },
        },
        tx,
      );
      return {
        webhookId,
        provider: event.provider,
        eventId: event.eventId,
        outcome: WebhookOutcome.AlreadyApplied,
        paymentId: payment.id,
        status: payment.status,
        accepted: true,
      };
    }

    // Anything else must be a legal §6 transition. A contradictory event (authorization failed,
    // for money already captured) lands here and is rejected — the delivery is preserved
    // unprocessed by the caller's catch, for investigation.
    PaymentStatusPolicy.assertValidTransition(payment.status, target);

    const status =
      target === PaymentStatus.CAPTURED
        ? await this.applyCapture(event, payment, tx)
        : await this.applyAuthorizationOutcome(event, payment, target, tx);

    return {
      webhookId,
      provider: event.provider,
      eventId: event.eventId,
      outcome: WebhookOutcome.Advanced,
      paymentId: payment.id,
      status,
      accepted: true,
    };
  }

  /**
   * `INITIATED -> AUTHORIZED` or `INITIATED -> FAILED` (§7). Persists the provider reference,
   * emits the catalogued event, audits — and creates **no ledger entry of any kind**: an
   * authorization is a hold at the gateway, and a failed one moved nothing either.
   */
  private async applyAuthorizationOutcome(
    event: NormalizedWebhookEvent,
    payment: PaymentProps,
    target: PaymentStatus,
    tx: unknown,
  ): Promise<PaymentStatus> {
    const aggregate = Payment.rehydrate(payment);
    const now = new Date();
    const providerRef = event.providerRef ?? payment.providerRef;

    if (target === PaymentStatus.FAILED) {
      const reason = sanitizeProviderFailureReason(event.failureReason);
      aggregate.fail(reason, now);
      const row = await this.payments.updateState(
        payment.id,
        { status: aggregate.status, failureReason: reason, providerRef },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: null,
          action: 'PAYMENT_AUTH_FAILED',
          resourceType: 'Payment',
          resourceId: payment.id,
          context: {
            ...this.auditContext(row),
            source: 'webhook',
            provider: event.provider,
            eventId: event.eventId,
            outcome: 'FAILED',
            failureReason: reason,
            failureCode: event.failureCode ?? null,
          },
        },
        tx,
      );
      await this.outbox.write(
        paymentFailedEvent({ paymentId: payment.id, orderId: payment.orderId, reason }),
        tx as OutboxCapableClient,
      );
      return row.status;
    }

    aggregate.authorize(now, providerRef);
    const row = await this.payments.updateState(
      payment.id,
      { status: aggregate.status, authorizedAt: aggregate.authorizedAt, providerRef },
      tx,
    );
    await this.audit.record(
      {
        actorUserId: null,
        action: 'PAYMENT_AUTHORIZED',
        resourceType: 'Payment',
        resourceId: payment.id,
        context: {
          ...this.auditContext(row),
          source: 'webhook',
          provider: event.provider,
          eventId: event.eventId,
          outcome: 'AUTHORIZED',
          providerRef,
        },
      },
      tx,
    );
    await this.outbox.write(
      paymentAuthorizedEvent({ paymentId: payment.id, orderId: payment.orderId }),
      tx as OutboxCapableClient,
    );
    return row.status;
  }

  /**
   * `AUTHORIZED -> CAPTURED` (§6, §11.3). Money moved at the gateway, so this posts §11.3's
   * balanced three-leg transaction — through the same `CaptureAccountingService` the local
   * capture command uses, so the two paths cannot post differently.
   *
   * The posting's reference is `CAPTURE-<paymentId>`, which is `@unique`: if the local capture
   * already committed one, this insert raises `P2002` and the delivery is resolved as a replay
   * rather than producing a second posting. The database, not a check, is the final guard.
   */
  private async applyCapture(
    event: NormalizedWebhookEvent,
    payment: PaymentProps,
    tx: unknown,
  ): Promise<PaymentStatus> {
    const split: CaptureSplit = await this.captureAccounting.resolveSplit(payment);
    const pharmacyId = await this.captureAccounting.resolveProviderPharmacyId(payment.orderId);

    const aggregate = Payment.rehydrate(payment);
    const now = new Date();
    const providerRef = event.providerRef ?? payment.providerRef;
    aggregate.capture(now, providerRef);

    const row = await this.payments.updateState(
      payment.id,
      { status: aggregate.status, capturedAt: aggregate.capturedAt, providerRef },
      tx,
    );
    const posting = await this.captureAccounting.post(payment, split, pharmacyId, tx);

    await this.audit.record(
      {
        actorUserId: null,
        action: 'PAYMENT_CAPTURED',
        resourceType: 'Payment',
        resourceId: payment.id,
        context: {
          ...this.auditContext(row),
          source: 'webhook',
          provider: event.provider,
          eventId: event.eventId,
          outcome: 'CAPTURED',
          providerRef,
          fee: split.fee.amountMinor,
          providerNet: split.providerNet.amountMinor,
          promotionExpense: split.promotionExpense.amountMinor,
          ledgerReference: posting.reference,
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
    return row.status;
  }

  /**
   * Locates the payment the callback refers to — by our own id when the gateway echoes it back
   * (Task 2 passes it as the provider-side idempotency key, so it should), otherwise by the
   * gateway's reference.
   *
   * A callback matching nothing is not an error here: it is recorded and deferred, because a
   * gateway retrying an event for a payment we rolled back is a real, benign occurrence, and
   * answering it with a failure would make it retry forever.
   */
  private async resolvePayment(event: NormalizedWebhookEvent): Promise<PaymentProps | null> {
    if (event.paymentId) {
      const byId = await this.payments.findById(event.paymentId);
      if (byId) {
        return byId;
      }
    }
    if (event.providerRef) {
      return this.payments.findByProviderRef(event.provider, event.providerRef);
    }
    return null;
  }

  /** A replay of an already-claimed event: no effect, no event, `200`. */
  private replayResult(
    event: NormalizedWebhookEvent,
    payment: PaymentProps | null,
  ): ProcessWebhookResult {
    return {
      webhookId: null,
      provider: event.provider,
      eventId: event.eventId,
      outcome: WebhookOutcome.Duplicate,
      paymentId: payment?.id ?? null,
      status: payment?.status ?? null,
      accepted: true,
    };
  }

  /**
   * Records a delivery whose business processing failed, so it is visible to reconciliation.
   * Best effort by design: this runs after the real transaction rolled back, and a failure to
   * write a forensic row must not mask the failure that caused it.
   */
  private async recordUnprocessed(
    event: NormalizedWebhookEvent,
    payload: unknown,
  ): Promise<void> {
    try {
      await this.webhooks.record({
        provider: event.provider,
        eventId: event.eventId,
        payload,
        processedAt: null,
      });
    } catch {
      // Already recorded by a concurrent delivery, or the database is unavailable. Either way
      // the caller's original error is the one that matters.
    }
  }

  /**
   * The raw body, parsed for storage in `provider_webhooks.payload` (§7) — the one place the
   * design sanctions keeping it. An unparseable body is stored as a wrapped string rather than
   * dropped: it is evidence, and by this point the signature has already proved it came from the
   * gateway.
   */
  private parsePayload(delivery: RawWebhookDelivery): unknown {
    try {
      return JSON.parse(delivery.rawBody);
    } catch {
      return { raw: delivery.rawBody };
    }
  }

  /** Never a token, a secret, a signature or a raw provider payload (§12). */
  private auditContext(payment: PaymentProps): Record<string, unknown> {
    return {
      orderId: payment.orderId,
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
    };
  }
}
