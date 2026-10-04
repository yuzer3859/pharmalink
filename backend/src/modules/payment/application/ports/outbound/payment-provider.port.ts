import { PaymentMethod } from '../../../domain/enums';

export const PAYMENT_PROVIDER_PORT = Symbol('PAYMENT_PROVIDER_PORT');

/**
 * What the application hands a gateway to authorize one payment attempt (§9.1, §11.1).
 *
 * **PCI (BRULE-26, NFR-SEC-04): there is no card field here and there never may be.**
 * `providerToken` is an opaque token a PCI-DSS-compliant gateway already issued in exchange for
 * the card (hosted fields / tokenization, §1's PCI boundary). Raw PAN/CVV/expiry never enters
 * this process, so it cannot enter this type.
 */
export interface ProviderAuthorizationRequest {
  /**
   * Our `Payment.id`, committed to the database **before** this call is made. It is passed to the
   * gateway as the provider-side idempotency/reference key, which is what makes retrying an
   * authorization safe: a gateway that already authorized this `paymentId` returns the original
   * authorization rather than creating a second one. See `AuthorizePaymentCommand`'s doc comment
   * for why this ordering, not the database constraint alone, is what makes the *external* side
   * effect idempotent.
   */
  paymentId: string;
  /** The caller's own replay key (BRULE-25), forwarded for gateways that key on their own. */
  idempotencyKey: string;
  orderId: string;
  customerUserId: string;
  method: PaymentMethod;
  /** Authoritative amount in minor units, taken from the order — never from the caller. */
  amount: number;
  currency: string;
  /** Opaque gateway token, when the method needs one. Never card data. */
  providerToken?: string | null;
  /** Where the gateway should send the customer back after a hosted/redirect flow (§9.1). */
  returnUrl?: string | null;
}

/**
 * The normalized outcome of an authorization attempt (§6, §11.1). Deliberately three-valued: the
 * design's §6 branches on exactly these — funds held now, customer action still required, or
 * declined.
 *
 * `PENDING` is the async/redirect case. It is **not** an authorization: the payment stays
 * `INITIATED` until the provider confirms (§11.2's webhook, a later task). Collapsing `PENDING`
 * into `AUTHORIZED` would let Orders confirm an order against money nobody is holding.
 */
export type ProviderAuthorizationOutcome = 'AUTHORIZED' | 'PENDING' | 'FAILED';

export interface ProviderAuthorizationResult {
  outcome: ProviderAuthorizationOutcome;
  /**
   * The gateway's own transaction reference. Required for `AUTHORIZED`; strongly preferred for
   * `PENDING` and `FAILED` too, because it is the handle every later reconciliation, webhook
   * match, capture and refund is keyed on. `null` is accepted (some gateways only issue a
   * reference once the customer completes a redirect) — the committed `Payment.id` remains the
   * reconciliation key of last resort in that case.
   */
  providerRef: string | null;
  /** Where to send the customer, for a `PENDING` hosted/redirect flow (§9.1 `providerRedirect`). */
  redirectUrl?: string | null;
  /**
   * Why the authorization was declined, **already sanitized by the adapter**: a short,
   * human-readable, customer-safe sentence. Never a raw gateway payload, never a secret, never
   * anything that could carry card data. The application sanitizes this again defensively
   * (`sanitizeProviderFailureReason`) before it is persisted, audited or returned — an adapter
   * bug must not become a data leak.
   */
  failureReason?: string | null;
  /** The gateway's own decline code, when it publishes a stable one (e.g. `insufficient_funds`). */
  failureCode?: string | null;
}

/**
 * A capture or void request. Both are keyed on `paymentId` — the id committed before the
 * authorization was ever attempted — which is what makes retrying them safe: a gateway that has
 * already captured (or voided) this payment must return that same result rather than performing
 * the operation a second time. `providerRef` is passed alongside it because most gateways
 * address the operation by their own reference.
 */
export interface ProviderPaymentOperationRequest {
  paymentId: string;
  /** The gateway's own reference from the authorization, when it issued one. */
  providerRef: string | null;
  orderId: string;
  method: PaymentMethod;
  /** The full authorized amount, in minor units. Partial capture is not part of this design. */
  amount: number;
  currency: string;
}

/**
 * Capture outcome (§11.3). Four-valued, and the fourth value is the important one:
 *
 *  - `CAPTURED` — money collected.
 *  - `FAILED`   — the gateway positively declined. The authorization is still live (§6 has no
 *                 `AUTHORIZED -> FAILED` transition), so the payment stays `AUTHORIZED`.
 *  - `UNKNOWN`  — the gateway could not tell us whether the capture happened. This must never be
 *                 collapsed into `FAILED`: money may well have moved, and recording it as failed
 *                 would leave the platform's books contradicting the gateway's. The payment is
 *                 left untouched for reconciliation to resolve.
 *  - `ALREADY_CAPTURED` — the gateway reports this payment was already captured (the normal
 *                 answer to an idempotent retry). Treated as success, not as an error.
 */
export type ProviderCaptureOutcome = 'CAPTURED' | 'ALREADY_CAPTURED' | 'FAILED' | 'UNKNOWN';

export interface ProviderCaptureResult {
  outcome: ProviderCaptureOutcome;
  /** The capture's own gateway reference, when distinct from the authorization's. */
  providerRef: string | null;
  /** Sanitized, customer-safe decline reason. Never a raw payload (see `failureReason` above). */
  failureReason?: string | null;
  failureCode?: string | null;
}

/**
 * Void outcome. `ALREADY_VOIDED` is normalized as success rather than an error — it is exactly
 * what a gateway returns for an idempotent retry, and treating it as a failure would make a
 * retry-safe operation fail on its second call.
 */
export type ProviderVoidOutcome = 'VOIDED' | 'ALREADY_VOIDED' | 'FAILED' | 'UNKNOWN';

export interface ProviderVoidResult {
  outcome: ProviderVoidOutcome;
  providerRef: string | null;
  failureReason?: string | null;
  failureCode?: string | null;
}

/**
 * A refund request (§11.4). Keyed on **`refundId`**, not `paymentId`: one payment can legitimately
 * have several partial refunds, so the payment is not a unique idempotency identity for this
 * operation the way it is for capture and void. `refundId` is our own `refunds.id`, committed to
 * the database *before* this call is made, which is what makes retrying a refund safe — a gateway
 * that has already processed this `refundId` must return that same refund rather than issuing a
 * second one.
 */
export interface ProviderRefundRequest {
  /** Our `refunds.id`, committed before the call. The provider-side idempotency key. */
  refundId: string;
  paymentId: string;
  /** The gateway's own reference for the *capture* being refunded, when it issued one. */
  providerRef: string | null;
  orderId: string;
  method: PaymentMethod;
  /** The amount to refund, in minor units. May be less than the captured amount (partial). */
  amount: number;
  currency: string;
  /** The full amount originally captured, for gateways that require it alongside a partial. */
  capturedAmount: number;
  /** Short, human-readable reason. Never a raw payload, never customer data beyond the reason. */
  reason?: string | null;
}

/**
 * Refund outcome (§11.4). Four-valued for the same reason capture is, and the fourth value is
 * again the important one:
 *
 *  - `REFUNDED` — the gateway confirmed the money is on its way back.
 *  - `FAILED`   — the gateway positively declined. No money moved, so the refund row is marked
 *                 `FAILED`, the amount becomes refundable again, and the payment is untouched.
 *  - `UNKNOWN`  — the gateway could not tell us whether the refund happened. This must never be
 *                 collapsed into `FAILED`: money may well have moved, and recording a failure
 *                 would free the amount to be refunded a *second* time — the one outcome a refund
 *                 flow must never produce. The refund is left `PENDING` for reconciliation.
 *  - `ALREADY_REFUNDED` — the gateway reports this `refundId` was already processed (the normal
 *                 answer to an idempotent retry). Treated as success, not as an error.
 */
export type ProviderRefundOutcome = 'REFUNDED' | 'ALREADY_REFUNDED' | 'FAILED' | 'UNKNOWN';

export interface ProviderRefundResult {
  outcome: ProviderRefundOutcome;
  /** The refund's own gateway reference, distinct from the capture's. */
  providerRef: string | null;
  /** Sanitized, customer-safe decline reason. Never a raw payload (see `failureReason` above). */
  failureReason?: string | null;
  failureCode?: string | null;
}

/**
 * Outbound port for a payment gateway (§5.2, §10 `application/ports/IPaymentProviderPort`, §14
 * "New gateways/methods — add adapters behind `IPaymentProviderPort` with zero domain change").
 *
 * Every gateway — Telebirr, a bank, a card processor, a diaspora/cross-border provider — is an
 * adapter behind this one interface (Strategy), so the domain and the application command know
 * nothing about any specific gateway. No provider SDK type, HTTP client, credential or raw
 * payload crosses this boundary: the request and result types above are the whole contract.
 *
 * This task defines the port and binds the design's own `MockPaymentProvider`
 * (§10 `infrastructure/providers/`). The real adapters, and the strategy selection that picks
 * between several bound providers by method, are the provider-adapter task — until then exactly
 * one provider is bound, and `supports()` is what decides whether it can serve a request.
 */
export interface IPaymentProviderPort {
  /** Stable gateway key persisted on `Payment.provider` (`telebirr`, `cbe`, …). */
  readonly key: string;

  /** Whether this gateway can authorize the given method (§3.1 F-PAY-01). */
  supports(method: PaymentMethod): boolean;

  /**
   * Whether this gateway can actually be used right now — credentials present, integration
   * implemented. Optional: an adapter that omits it is treated as available, which keeps every
   * existing in-process and test adapter working unchanged.
   *
   * Distinct from `supports()` on purpose. `supports()` answers "is this method mine?";
   * `isAvailable()` answers "am I usable at all?". Collapsing them would make a gateway that is
   * merely unconfigured look like one that does not handle the method, and the registry would
   * silently route the payment to a different gateway instead of failing.
   */
  isAvailable?(): boolean;

  /**
   * Attempts to authorize (hold) funds. Called **outside** any database transaction — it is a
   * slow, retryable, failure-prone network call, and holding a `Serializable` transaction open
   * across it would be a correctness and availability defect (ADR-014's cross-boundary
   * discipline, applied here to an external system rather than a sibling module).
   *
   * Implementations must throw only for a genuinely *unknown* outcome (network failure, timeout,
   * unparseable response). A gateway that positively declines must return
   * `{ outcome: 'FAILED' }` — the difference decides whether the payment becomes `FAILED` or
   * stays `INITIATED` awaiting reconciliation, and getting it wrong can hide a real
   * authorization.
   */
  authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult>;

  /**
   * Collects previously authorized funds (§11.3). Called **outside** any database transaction,
   * for the same reasons as `authorize`.
   *
   * **Must be idempotent on `paymentId`.** Capture is the step that actually moves the customer's
   * money, and the application may legitimately retry it (a serialization conflict, a crash
   * between the gateway call and the local commit, two concurrent order-ready signals). An
   * implementation that captures twice for one `paymentId` double-charges the customer, and no
   * amount of application-side locking can fully prevent that — the guarantee has to live here.
   * A gateway that has already captured this payment returns `ALREADY_CAPTURED`.
   *
   * Return `UNKNOWN` — or throw — when the outcome genuinely cannot be determined. Never return
   * `FAILED` for an ambiguous result.
   */
  capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult>;

  /**
   * Releases an authorization hold without charging (§6 `AUTHORIZED -> VOIDED`). Called outside
   * any database transaction. Also idempotent on `paymentId`: a hold that is already released
   * returns `ALREADY_VOIDED`.
   *
   * This is a distinct gateway operation from a refund. An adapter must never implement it by
   * capturing and refunding — that would move the customer's money and move it back, producing a
   * real charge on their statement for an order that was cancelled before fulfillment.
   */
  voidAuthorization(request: ProviderPaymentOperationRequest): Promise<ProviderVoidResult>;

  /**
   * Returns captured funds to the original payment method (§3.2 F-RFD-02, §11.4). Called
   * **outside** any database transaction, for the same reasons as `authorize` and `capture`.
   *
   * **Must be idempotent on `refundId`.** A refund moves the customer's money back, and the
   * application may legitimately retry it (a serialization conflict, a crash between the gateway
   * call and the local commit, a resumed `PENDING` refund). An implementation that refunds twice
   * for one `refundId` pays the customer twice, and — exactly as with capture — no
   * application-side lock can prevent that once the request has left the process, so the guarantee
   * has to live here. A gateway that has already processed this refund returns `ALREADY_REFUNDED`.
   *
   * Note the key is `refundId`, **not** `paymentId`: partial refunds mean one payment may have
   * several distinct, legitimate refunds, so keying on the payment would make the second one
   * indistinguishable from a retry of the first.
   *
   * Return `UNKNOWN` — or throw — when the outcome genuinely cannot be determined. Never return
   * `FAILED` for an ambiguous result: the application frees a `FAILED` refund's amount for
   * re-refunding, so a mislabelled ambiguity becomes a double payout.
   *
   * This is a distinct gateway operation from a void. An adapter must never implement a refund by
   * voiding, or a void by capturing and refunding — the two touch different money at different
   * points in the lifecycle and appear differently on a customer's statement.
   */
  refund(request: ProviderRefundRequest): Promise<ProviderRefundResult>;
}

export const PAYMENT_PROVIDER_REGISTRY = Symbol('PAYMENT_PROVIDER_REGISTRY');

/**
 * Provider selection (§10 "Strategy", §14 "New gateways/methods — add adapters behind
 * `IPaymentProviderPort` with zero domain change").
 *
 * One mechanism, two questions, and the difference between them matters:
 *
 *  - {@link forMethod} — *starting* a payment. "Which gateway handles TELEBIRR?" Resolved from
 *    the method plus configured availability.
 *  - {@link forKey} — *continuing* one. "Which gateway is holding this payment's money?" Resolved
 *    from `Payment.provider`, the key recorded when it was authorized.
 *
 * Capture and void must use `forKey`. Re-resolving by method would work only while exactly one
 * gateway serves a method; the moment a second is added, or the routing preference changes, a
 * capture would be sent to a gateway that never authorized the payment. The key is the binding
 * that survives configuration changes.
 *
 * The application layer sees only this interface and `IPaymentProviderPort`. No command imports a
 * provider class, and no command branches on a provider key.
 */
export interface IPaymentProviderRegistry {
  /**
   * The available gateway that handles `method`. Throws when none does — an unsupported
   * method/provider combination is refused rather than routed to a gateway that would reject it.
   */
  forMethod(method: PaymentMethod): IPaymentProviderPort;

  /**
   * The gateway a payment was authorized through. Throws when that gateway is unknown or is no
   * longer available, rather than substituting another one: only the gateway holding the
   * authorization can capture or void it.
   */
  forKey(providerKey: string | null | undefined): IPaymentProviderPort;

  /** Keys of every gateway currently usable, for diagnostics and error context. */
  availableKeys(): string[];
}
