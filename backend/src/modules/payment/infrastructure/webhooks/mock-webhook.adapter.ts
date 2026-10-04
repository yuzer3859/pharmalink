import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { PaymentErrors } from '../../domain/errors';
import { IPaymentWebhookPort } from '../../application/ports/outbound/payment-webhook.port';
import {
  NormalizedWebhookEvent,
  RawWebhookDelivery,
  WebhookEventType,
} from '../../application/webhooks/normalized-webhook-event';
import { sanitizeProviderFailureReason } from '../../application/support/sanitize-provider-failure';
import { verifyHmacSignature } from './hmac-signature';

/** Header the gateway is expected to sign with. Lower-cased; callers normalize header names. */
export const MOCK_WEBHOOK_SIGNATURE_HEADER = 'x-payment-signature';

/**
 * Config key holding this gateway's shared webhook secret. Read through `IConfigPort`, which is
 * env-backed today and DB-backed once Module 16 lands — **never** a literal in source (§2).
 */
export const MOCK_WEBHOOK_SECRET_KEY = 'PAYMENT_WEBHOOK_SECRET_MOCK';

/**
 * The webhook counterpart of `MockPaymentProvider` — same `mock` gateway key, so a payment
 * authorized through that provider is called back through this adapter.
 *
 * It performs **no network I/O**, and it is deliberate rather than throwaway: signature
 * verification is real HMAC-SHA256 over the received bytes with a secret from configuration, so
 * the security boundary under test is the one that ships. What it stands in for is only the
 * *vocabulary* of a real gateway — the event names below are this stub's, and each real adapter
 * translates its own into the same normalized set.
 *
 * Expected body shape (JSON):
 * ```
 * { "id": "evt_1", "type": "payment.authorized" | "payment.failed" | "payment.captured",
 *   "paymentId": "…", "providerRef": "…", "occurredAt": "…", "reason": "…", "code": "…" }
 * ```
 * Any other `type` normalizes to `UNKNOWN` — the stub does not guess, exactly as a real adapter
 * must not (§8).
 */
@Injectable()
export class MockWebhookAdapter implements IPaymentWebhookPort {
  readonly provider = 'mock';

  constructor(@Inject(CONFIG_PORT) private readonly config: IConfigPort) {}

  async verify(delivery: RawWebhookDelivery): Promise<void> {
    const secret = this.config.get<string>(MOCK_WEBHOOK_SECRET_KEY);
    if (!secret) {
      // An unconfigured secret must fail closed. Accepting unverified callbacks because nobody
      // set a secret would be the worst possible default for a money endpoint.
      throw PaymentErrors.webhookSignatureInvalid(this.provider, { reason: 'not_configured' });
    }
    const signature = delivery.headers[MOCK_WEBHOOK_SIGNATURE_HEADER];
    if (!verifyHmacSignature(secret, delivery.rawBody, signature)) {
      // No signature, secret or body in the error — see `webhookSignatureInvalid`'s doc comment.
      throw PaymentErrors.webhookSignatureInvalid(this.provider);
    }
  }

  async normalize(delivery: RawWebhookDelivery): Promise<NormalizedWebhookEvent> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(delivery.rawBody) as Record<string, unknown>;
    } catch {
      throw PaymentErrors.webhookMalformed(this.provider, 'body is not valid JSON');
    }
    if (!body || typeof body !== 'object') {
      throw PaymentErrors.webhookMalformed(this.provider, 'body is not an object');
    }

    const eventId = typeof body.id === 'string' ? body.id.trim() : '';
    if (eventId.length === 0) {
      throw PaymentErrors.webhookMalformed(this.provider, 'missing event id');
    }

    const occurredAt =
      typeof body.occurredAt === 'string' ? new Date(body.occurredAt) : new Date();

    return {
      provider: this.provider,
      eventId,
      type: this.mapType(body.type),
      paymentId: typeof body.paymentId === 'string' ? body.paymentId : null,
      providerRef: typeof body.providerRef === 'string' ? body.providerRef : null,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      // Sanitized here as well as in the command: an adapter is the first place a gateway's text
      // enters the process, so it is the first place it must be made safe (§12).
      failureReason:
        body.reason === undefined ? null : sanitizeProviderFailureReason(body.reason),
      failureCode: typeof body.code === 'string' ? body.code : null,
    };
  }

  /** Unrecognised types become `UNKNOWN` rather than a guess — the §8 safety property. */
  private mapType(raw: unknown): WebhookEventType {
    switch (raw) {
      case 'payment.authorized':
        return WebhookEventType.AuthorizationSucceeded;
      case 'payment.failed':
        return WebhookEventType.AuthorizationFailed;
      case 'payment.captured':
        return WebhookEventType.CaptureSucceeded;
      default:
        return WebhookEventType.Unknown;
    }
  }
}
