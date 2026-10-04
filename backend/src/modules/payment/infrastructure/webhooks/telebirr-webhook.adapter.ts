import { Injectable } from '@nestjs/common';
import { IPaymentWebhookPort } from '../../application/ports/outbound/payment-webhook.port';
import { NormalizedWebhookEvent } from '../../application/webhooks/normalized-webhook-event';
import { PaymentErrors } from '../../domain/errors';
import { TelebirrConfig } from '../providers/telebirr/telebirr.config';
import { TELEBIRR_PROVIDER_KEY } from '../providers/telebirr/telebirr.adapter';

/**
 * `TelebirrWebhookAdapter` — the inbound half of the Telebirr integration, unimplemented for the
 * same reason as `TelebirrAdapter`: this repository contains no Telebirr callback contract.
 *
 * Verification and normalization are precisely the two things that cannot be guessed:
 *
 *  - **Signature verification** needs the algorithm, the exact bytes that are signed (raw body?
 *    a canonical subset? with a timestamp?), and the header carrying the signature. Implementing
 *    a plausible HMAC here would produce a verifier that rejects every genuine Telebirr callback
 *    — or, if the scheme is weaker than assumed, accepts forged ones.
 *  - **Normalization** needs the event vocabulary and the event-identifier field, and that
 *    identifier is what `provider_webhooks (provider, eventId)` deduplicates on. Getting it wrong
 *    means either replaying money-moving events or dropping real ones.
 *
 * So both refuse. The class exists because the *seam* is real and the shape is settled: whoever
 * implements it changes only this file plus the registry entry, and `ProcessWebhookCommand` — the
 * whole normalized-event → state/ledger/audit/outbox pipeline — needs no change at all. That
 * separation is the point of §7, and it is already proven by `MockWebhookAdapter` running through
 * the same command.
 *
 * **Not registered in `WebhookAdapterRegistry` while unimplemented.** A Telebirr callback is
 * therefore refused as an unintegrated provider, which is the truthful answer — rather than being
 * accepted and then failing signature verification, which would misreport an integration gap as
 * a security event and pollute the security audit trail.
 */
@Injectable()
export class TelebirrWebhookAdapter implements IPaymentWebhookPort {
  readonly provider = TELEBIRR_PROVIDER_KEY;

  constructor(private readonly config: TelebirrConfig) {}

  /** False while the callback contract is missing; see `TelebirrAdapter.isAvailable()`. */
  isAvailable(): boolean {
    return false;
  }

  /** Parameters omitted deliberately — see `TelebirrAdapter.authorize`. */
  async verify(): Promise<void> {
    throw this.unavailable('verify');
  }

  async normalize(): Promise<NormalizedWebhookEvent> {
    throw this.unavailable('normalize');
  }

  /** Key names and operation only — never the webhook secret, a signature or a raw body. */
  private unavailable(operation: string): Error {
    const state = this.config.describe();
    const error = PaymentErrors.providerContractUnavailable(this.provider, operation);
    (error as { details?: unknown }).details = {
      provider: this.provider,
      operation,
      reason: 'provider_contract_unavailable',
      enabled: state.enabled,
      missingConfigKeys: state.missing,
    };
    return error;
  }
}
