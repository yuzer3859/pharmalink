import {
  NormalizedWebhookEvent,
  RawWebhookDelivery,
} from '../../webhooks/normalized-webhook-event';

export const PAYMENT_WEBHOOK_REGISTRY = Symbol('PAYMENT_WEBHOOK_REGISTRY');

/**
 * The webhook-side sibling of `IPaymentProviderPort`: one adapter per gateway, owning the two
 * things that are irreducibly provider-specific about a callback — proving it is authentic, and
 * translating its vocabulary into ours (§9.2, §10 `infrastructure/webhooks/`).
 *
 * Both responsibilities live on one port because they are two halves of one job and share one
 * input (the raw bytes) and one piece of configuration (the provider's secret). Splitting them
 * would mean two registries selecting two adapters by the same key for the same request.
 *
 * No provider SDK type, HTTP client, credential or raw payload crosses this boundary in the
 * outbound direction: `verify` returns nothing and `normalize` returns a
 * {@link NormalizedWebhookEvent}, which carries no gateway-shaped data at all.
 */
export interface IPaymentWebhookPort {
  /** Gateway key, matching `IPaymentProviderPort.key` and the `{provider}` route segment. */
  readonly provider: string;

  /**
   * Proves the delivery came from the gateway. Throws `WEBHOOK_SIGNATURE_INVALID` when it did
   * not; returns silently when it did.
   *
   * Implementations must compare signatures in constant time and must never include the
   * signature, the secret, or the raw body in the thrown error, in a log line, or in any audit
   * context (§12) — an attacker probing signatures must learn nothing from the response.
   */
  verify(delivery: RawWebhookDelivery): Promise<void>;

  /**
   * Translates a verified delivery into the normalized event. Called only after `verify`.
   *
   * An adapter that cannot confidently classify a callback must return
   * `type: WebhookEventType.Unknown` rather than guessing: an incorrect `AUTHORIZATION_FAILED`
   * would mark a live payment dead, and an incorrect `CAPTURE_SUCCEEDED` would post money that
   * was never collected. Returning `Unknown` routes it to reconciliation instead.
   *
   * Throws a validation error only when the payload is structurally unusable (unparseable, or
   * missing the event id that deduplication depends on).
   */
  normalize(delivery: RawWebhookDelivery): Promise<NormalizedWebhookEvent>;
}

/**
 * Selects the adapter for a `{provider}` route segment (§9.2). A registry rather than a single
 * bound adapter, because unlike outbound payments — where one gateway serves a request — inbound
 * callbacks arrive from every gateway the platform has ever integrated, addressed by name.
 *
 * An unknown provider is refused rather than defaulted: accepting a callback we cannot
 * authenticate, from a gateway we do not recognise, is exactly the hole signature verification
 * exists to close.
 */
export interface IPaymentWebhookRegistry {
  /** The adapter for `provider`, or `null` when no gateway by that name is integrated. */
  forProvider(provider: string): IPaymentWebhookPort | null;
  /** Every integrated gateway key, for diagnostics. */
  providers(): string[];
}
