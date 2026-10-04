import { PaymentStatus } from '../../domain/enums';

/**
 * The normalized payment-lifecycle events Module 07 understands, derived strictly from §6's own
 * state machine. A provider's vocabulary (`charge.succeeded`, `PaymentSuccess`, `TRX_OK`, …) is
 * translated into exactly one of these by that provider's adapter, so nothing downstream ever
 * branches on gateway-specific strings.
 *
 * `UNKNOWN` is a first-class member on purpose: a callback we cannot confidently map is not a
 * failure (Tasks 2 and 3's safety property, preserved here). It is recorded and deferred to
 * reconciliation, never guessed at.
 */
export const WebhookEventType = {
  AuthorizationSucceeded: 'AUTHORIZATION_SUCCEEDED',
  AuthorizationFailed: 'AUTHORIZATION_FAILED',
  CaptureSucceeded: 'CAPTURE_SUCCEEDED',
  Unknown: 'UNKNOWN',
} as const;

export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];

/**
 * The §6 state each event drives a payment to. `UNKNOWN` maps to nothing — that is the point.
 */
export const WEBHOOK_TARGET_STATUS: Readonly<
  Record<Exclude<WebhookEventType, 'UNKNOWN'>, PaymentStatus>
> = {
  [WebhookEventType.AuthorizationSucceeded]: PaymentStatus.AUTHORIZED,
  [WebhookEventType.AuthorizationFailed]: PaymentStatus.FAILED,
  [WebhookEventType.CaptureSucceeded]: PaymentStatus.CAPTURED,
};

/**
 * States in which an event's effect is **already satisfied**, so a delivery is a harmless replay
 * rather than an illegal transition.
 *
 * This is what makes the webhook-versus-command races of §11 safe. §6's progression is linear
 * (`INITIATED → AUTHORIZED → CAPTURED → SETTLED`), so a payment that has moved *past* an event's
 * target has, by definition, already had that event's effect applied — an authorization-success
 * callback arriving after the local capture committed is late news, not a contradiction, and
 * must produce no second event and no second posting.
 *
 * A state that is neither the target nor beyond it *is* a genuine contradiction (an
 * authorization-failure callback for money already captured, say) and is rejected rather than
 * silently absorbed.
 */
export const WEBHOOK_ALREADY_SATISFIED_BY: Readonly<
  Record<Exclude<WebhookEventType, 'UNKNOWN'>, ReadonlySet<PaymentStatus>>
> = {
  [WebhookEventType.AuthorizationSucceeded]: new Set([
    PaymentStatus.AUTHORIZED,
    PaymentStatus.CAPTURED,
    PaymentStatus.SETTLED,
    PaymentStatus.REFUNDED,
    PaymentStatus.PARTIALLY_REFUNDED,
  ]),
  [WebhookEventType.AuthorizationFailed]: new Set([PaymentStatus.FAILED]),
  [WebhookEventType.CaptureSucceeded]: new Set([
    PaymentStatus.CAPTURED,
    PaymentStatus.SETTLED,
    PaymentStatus.REFUNDED,
    PaymentStatus.PARTIALLY_REFUNDED,
  ]),
};

/**
 * A callback exactly as it arrived at the edge: opaque bytes plus headers. This is the **only**
 * shape that carries raw provider data, and it travels no further than the signature verifier,
 * the provider's own normalizer, and `provider_webhooks.payload` (§7, the one place the design
 * sanctions storing it).
 *
 * `rawBody` is kept as the exact received string because a signature is computed over bytes:
 * re-serializing parsed JSON would change whitespace and key order and break verification.
 */
export interface RawWebhookDelivery {
  /** Gateway key, matching `Payment.provider` and the route's `{provider}` segment (§9.2). */
  provider: string;
  /** The exact bytes received, unparsed and unmodified. */
  rawBody: string;
  /**
   * Lower-cased header names to values. Carries the signature header, so it is never logged and
   * never persisted outside the raw payload column.
   */
  headers: Readonly<Record<string, string>>;
}

/**
 * The normalized event — everything Module 07 needs from a callback, and nothing else.
 *
 * There is deliberately no `payload`, no `rawBody`, and no provider-shaped object here. This is
 * the type that crosses into the application command, so keeping it this narrow is what
 * guarantees a raw gateway payload cannot reach a domain entity, a ledger API, an audit entry or
 * an outbox event (§12).
 */
export interface NormalizedWebhookEvent {
  provider: string;
  /**
   * The gateway's own event id. Together with `provider` it is the deduplication key, enforced
   * by the `provider_webhooks` unique index — not by an application pre-check alone (§3).
   */
  eventId: string;
  type: WebhookEventType;
  /**
   * Our `Payment.id`, when the gateway echoes it back (every adapter is asked to, because
   * Task 2 passes it as the provider-side idempotency key). Either this or `providerRef` must be
   * present, or the payment cannot be located.
   */
  paymentId: string | null;
  /** The gateway's own transaction reference — the fallback way to locate the payment. */
  providerRef: string | null;
  /** When the gateway says the event occurred, for ordering and forensics. */
  occurredAt: Date;
  /**
   * Sanitized decline reason, for a failure event. The adapter sanitizes it, and the command
   * sanitizes it again before it is persisted or published (§12).
   */
  failureReason?: string | null;
  failureCode?: string | null;
}
