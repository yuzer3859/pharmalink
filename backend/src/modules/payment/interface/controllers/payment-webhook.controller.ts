import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../../identity/interface/decorators/public.decorator';
import {
  ProcessWebhookCommand,
  ProcessWebhookResult,
} from '../../application/commands/process-webhook.command';
import { RawWebhookDelivery } from '../../application/webhooks/normalized-webhook-event';

/** §9.2's response: enough for a gateway to see the callback landed, and nothing more. */
export interface WebhookAcceptedResponse {
  received: true;
  /** What the command did: `ADVANCED` | `DUPLICATE` | `ALREADY_APPLIED` | `DEFERRED`. */
  outcome: ProcessWebhookResult['outcome'];
}

/**
 * `POST /api/v1/webhooks/payments/{provider}` (§9.2).
 *
 * ## Authentication is the signature, not a bearer token
 *
 * `@Public()` exempts this route from the global `JwtAuthGuard` — a payment gateway has no user
 * account and presents no access token. Authentication happens instead inside
 * `ProcessWebhookCommand`, which resolves the provider's adapter and verifies the signature
 * before the payload is parsed or trusted. That is not a weaker check: an unsigned or
 * wrongly-signed callback is rejected with `WEBHOOK_SIGNATURE_INVALID` (401) and audited as a
 * security event, and nothing is written.
 *
 * ## Why the raw body
 *
 * Signatures are computed over the exact bytes a gateway sent. `rawBody: true` (set in `main.ts`
 * and mirrored in the test harness) preserves them on `req.rawBody`, and this controller forwards
 * that buffer untouched. Re-serializing the parsed JSON instead would change whitespace and key
 * order and invalidate every genuine signature — §6's explicit warning.
 *
 * ## Status codes
 *
 * `200` for every outcome the command treats as handled — processed, duplicate, already applied,
 * or safely deferred (§9.2's "always 200 on accepted (retry-safe)"). Returning an error for a
 * duplicate would make a gateway retry an event that has already moved money, forever.
 *
 * Non-2xx is reserved for callbacks that genuinely were not handled, and each already carries its
 * own code from the application layer: `WEBHOOK_SIGNATURE_INVALID` (401), `VALIDATION_ERROR` (400)
 * for an unintegrated provider or a malformed event, `INVALID_PAYMENT_STATE_TRANSITION` (409) for
 * a contradictory event, `DEPENDENCY_UNAVAILABLE` (503). The global `AllExceptionsFilter` maps
 * them; this controller catches nothing, so it cannot accidentally swallow a failure into a 200.
 *
 * ## What never leaves this method
 *
 * The response carries no signature, no secret, no provider payload and no payment detail — only
 * that the callback was received and how it was classified. The raw body is passed to the command
 * and stored in `provider_webhooks.payload`; it is never logged here and never echoed back.
 */
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly processWebhook: ProcessWebhookCommand) {}

  @Post(':provider')
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<WebhookAcceptedResponse> {
    const delivery: RawWebhookDelivery = {
      provider,
      // The exact received bytes. Falls back to an empty string rather than to a re-serialized
      // parse: an empty body fails signature verification, which is the correct outcome, whereas
      // a re-serialized one could accidentally verify against a lenient scheme.
      rawBody: request.rawBody ? request.rawBody.toString('utf8') : '',
      headers: normalizeHeaders(request.headers),
    };

    // Provider resolution, signature verification, normalization, deduplication, the state
    // transition, the ledger posting, audit and outbox all belong to the command. Duplicating any
    // of it here would give the HTTP layer a second opinion about money.
    const result = await this.processWebhook.execute(delivery);

    return { received: true, outcome: result.outcome };
  }
}

/**
 * Flattens Node's header bag to `Record<string, string>` with lower-cased names, the shape
 * `IPaymentWebhookPort.verify` expects. A repeated header is joined with `, ` per RFC 9110 rather
 * than silently dropped, so an adapter sees what actually arrived.
 */
function normalizeHeaders(headers: Request['headers']): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return normalized;
}
