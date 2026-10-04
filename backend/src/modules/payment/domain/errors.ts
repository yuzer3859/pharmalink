import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Payment, Wallet & Settlement domain errors (`architecture/module-07-payment-wallet.md` §9,
 * §12). Thrown from the domain and application layers and translated to the standard error
 * envelope by the global `AllExceptionsFilter`, mirroring `modules/orders/domain/errors.ts` and
 * `modules/pharmacy-inventory/domain/errors.ts` (own copy per ADR-002).
 *
 * A code appears here when its thrower does — the same discipline Module 06 applied to
 * `PRICE_CHANGED`. The ledger/payment-foundation task defined the validation/transition/ledger
 * guards; the payment-authorization task adds the authorization-flow errors below. §9's
 * remaining representative codes (`INSUFFICIENT_WALLET_BALANCE`, `COUPON_*`) still belong to the
 * wallet/coupon tasks. The capture/void, webhook and refund tasks have since added their own —
 * `PAYMENT_ALREADY_CAPTURED`, `WEBHOOK_SIGNATURE_INVALID`, `REFUND_EXCEEDS_CAPTURED` and
 * `REFUND_NOT_ELIGIBLE` are all below.
 *
 * `IDEMPOTENT_REPLAY` (§9) is deliberately **not** an error in this codebase: a replay is a
 * successful outcome, not a failure. `AuthorizePaymentCommand` returns the already-committed
 * payment with `replay: true`, exactly as `CheckoutCommand` returns the already-committed order —
 * throwing there would break the retry-safety BRULE-25 exists to provide. Reuse of one key for a
 * *different* logical request is the real error, and that is `IDEMPOTENCY_CONFLICT` below.
 */
export const PaymentErrors = {
  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),

  /** Generic not-found for `Payment`/`LedgerAccount`/`LedgerTransaction` lookups — reuses the
   * shared `NOT_FOUND` code exactly as `CatalogErrors.notFound()` does. A dedicated
   * `PAYMENT_NOT_FOUND` code is deliberately not invented here: no customer-facing read path
   * exists yet (§9.1's `GET /payments/{id}` belongs to the payment-command task), and the
   * catalog is append-only. */
  notFound: (message = 'Resource not found.', details?: unknown) =>
    new ApiException(ErrorCode.NOT_FOUND, message, details),

  /**
   * Illegal `Payment.status` transition (§6). One code for the whole `Payment` aggregate, per
   * the established one-transition-code-per-aggregate convention
   * (`INVALID_ORDER_STATE_TRANSITION`, `INVALID_PRESCRIPTION_STATE_TRANSITION`).
   */
  invalidPaymentStateTransition: (from: string, to: string) =>
    new ApiException(
      ErrorCode.INVALID_PAYMENT_STATE_TRANSITION,
      `Cannot transition payment status from ${from} to ${to}.`,
      { from, to },
    ),

  /**
   * The design's own internal guard / bug tripwire (§9, §12): a ledger posting whose debits do
   * not equal its credits is rejected **before** it can be committed. No API client can submit a
   * ledger posting, so this is never a caller's input error — it maps to 500 on purpose (see
   * `ERROR_HTTP_STATUS`) because reaching it means a money command has a defect.
   */
  ledgerUnbalanced: (details: { debit: number; credit: number; currency: string }) =>
    new ApiException(
      ErrorCode.LEDGER_UNBALANCED,
      `Ledger transaction does not balance: debits ${details.debit} != credits ${details.credit} (${details.currency}).`,
      details,
    ),

  /**
   * `POST /payments/authorize`'s `idempotencyKey` (BRULE-25, §5.3) was already used for a
   * materially different request — a different order, customer, method or amount. Reuses the
   * existing shared `IDEMPOTENCY_CONFLICT` code exactly as `OrdersErrors.idempotencyConflict()`
   * and `PharmacyInventoryErrors.idempotencyKeyConflict()` do, never silently returning the
   * mismatched payment.
   */
  idempotencyConflict: (details?: unknown) =>
    new ApiException(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      'This idempotency key was already used for a different payment.',
      details,
    ),

  /** Order-scoped lookups (§9.1). Reuses Module 06's already-shared `ORDER_NOT_FOUND` code — an
   * order belonging to a different customer resolves to this same error, never a distinguishable
   * "forbidden", so payment cannot be used to probe for the existence of other customers' orders
   * (the identical no-existence-leakage discipline `GetOrderQuery` already applies). */
  orderNotFound: (details?: unknown) =>
    new ApiException(ErrorCode.ORDER_NOT_FOUND, 'Order not found.', details),

  /** The order exists and is the caller's, but its status is not one from which a payment may be
   * authorized (BRULE-17 — authorization happens before order confirmation, i.e. while the order
   * is still awaiting payment). Reuses the shared `BUSINESS_RULE_VIOLATION` code; no new code is
   * introduced for it. */
  orderNotPayable: (status: string) =>
    new ApiException(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      `An order in status ${status} cannot have a payment authorized.`,
      { status },
    ),

  /** A non-terminal payment (INITIATED/AUTHORIZED/CAPTURED/SETTLED) already exists for this
   * order. Authorizing a second one would risk charging the customer twice for one order, so it
   * is refused as a conflict rather than treated as a replay — the caller's idempotency key
   * differs, so this is a genuinely different request, not a retry. */
  orderAlreadyHasActivePayment: (paymentId: string, status: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This order already has an active payment.',
      { paymentId, status },
    ),

  /** The selected `PaymentMethod` is not one the bound provider can authorize (§3.1 F-PAY-01,
   * §14's `IPaymentProviderPort` strategy selection). */
  unsupportedPaymentMethod: (method: string, provider: string) =>
    new ApiException(
      ErrorCode.VALIDATION_ERROR,
      `Payment method ${method} is not supported by provider ${provider}.`,
      { field: 'method', method, provider },
    ),

  /**
   * The provider declined the authorization (§9, §11.1). `reason` is always the **sanitized**
   * provider reason (`sanitizeProviderFailureReason`) — never a raw provider payload, and never
   * anything that could carry card data.
   */
  paymentAuthFailed: (reason: string, details?: Record<string, unknown>) =>
    new ApiException(ErrorCode.PAYMENT_AUTH_FAILED, reason, details),

  /**
   * The provider call itself failed (network error, timeout, malformed response) — the outcome
   * of the authorization is **unknown**, not known-failed. The payment is deliberately left
   * `INITIATED` so the later webhook/reconciliation task can resolve it against the provider
   * reference; marking it `FAILED` here could permanently hide a real authorization. Reuses the
   * shared `DEPENDENCY_UNAVAILABLE` code.
   */
  providerUnavailable: (details?: unknown) =>
    new ApiException(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      'The payment provider could not be reached. The payment is still pending confirmation.',
      details,
    ),

  /**
   * A void was attempted on a payment whose money has already been collected (§9's own listed
   * code). Voiding releases a *hold*; once captured, the correct instrument is a refund
   * (BRULE-24), which is a different operation with its own eligibility rules — so this is
   * refused rather than silently redirected.
   */
  paymentAlreadyCaptured: (paymentId: string, status: string) =>
    new ApiException(
      ErrorCode.PAYMENT_ALREADY_CAPTURED,
      'This payment has already been captured and can no longer be voided.',
      { paymentId, status },
    ),

  /**
   * The provider positively declined the capture (§11.3). The payment stays `AUTHORIZED`: §6
   * defines no `AUTHORIZED -> FAILED` transition, so a failed capture is not a failed payment —
   * the authorization is still live and may be captured again or voided. `reason` is always the
   * **sanitized** provider reason.
   */
  paymentCaptureFailed: (reason: string, details?: Record<string, unknown>) =>
    new ApiException(ErrorCode.PAYMENT_CAPTURE_FAILED, reason, details),

  /**
   * The provider refused to void the authorization. The payment stays `AUTHORIZED` — the hold is
   * still live at the gateway, so reporting it as voided would be a lie. Reuses the shared
   * `BUSINESS_RULE_VIOLATION` code; no new code is introduced for it.
   */
  paymentVoidFailed: (reason: string, details?: Record<string, unknown>) =>
    new ApiException(ErrorCode.BUSINESS_RULE_VIOLATION, reason, details),

  /**
   * The capture could not determine which provider account the payable belongs to. Raised when
   * an order has no fulfillment (nothing identifies the pharmacy) or more than one (the design's
   * §11.3 capture posting credits a single `PROVIDER_PAYABLE`, and how a split-fulfillment order
   * divides one payment across several pharmacies is not defined anywhere in the design). Failing
   * loudly is deliberate: guessing a split would silently mis-pay providers.
   */
  providerPayableUnresolved: (orderId: string, fulfillmentCount: number) =>
    new ApiException(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      fulfillmentCount === 0
        ? 'This order has no fulfillment, so the provider to be credited cannot be determined.'
        : 'This order is fulfilled by more than one pharmacy; splitting a capture across providers is not supported.',
      { orderId, fulfillmentCount },
    ),

  /**
   * A provider callback whose signature did not verify (§9.2, §12). The message is deliberately
   * uninformative and the details carry only the provider name and, when known, the gateway's
   * event id — never the signature, the secret, the raw body or which check failed. An attacker
   * probing signatures must learn nothing from the response, and §13 forbids logging any of it.
   */
  webhookSignatureInvalid: (provider: string, details?: Record<string, unknown>) =>
    new ApiException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Webhook signature verification failed.', {
      provider,
      ...details,
    }),

  /** A callback addressed to a `{provider}` no integrated gateway answers to (§9.2). Refused
   * rather than defaulted: accepting a callback from an unrecognised sender is exactly the hole
   * signature verification exists to close. */
  webhookProviderUnsupported: (provider: string) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, 'Unknown payment webhook provider.', {
      field: 'provider',
      provider,
    }),

  /**
   * The callback is structurally unusable — unparseable, or missing the event id deduplication
   * depends on. Distinct from an *unrecognised* event, which is normalized to `UNKNOWN` and
   * deferred to reconciliation rather than rejected.
   */
  webhookMalformed: (provider: string, reason: string) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, `Malformed webhook payload: ${reason}`, {
      field: 'payload',
      provider,
    }),

  /** A callback that identifies no payment we hold — neither by our `paymentId` nor by the
   * gateway's `providerRef`. */
  webhookPaymentUnresolved: (provider: string, eventId: string) =>
    new ApiException(ErrorCode.NOT_FOUND, 'No payment matches this webhook.', {
      provider,
      eventId,
    }),

  /**
   * A payment must be continued through the gateway that authorized it, and that gateway is not
   * usable — never integrated, or currently unconfigured. Reuses `DEPENDENCY_UNAVAILABLE`: this
   * is an availability problem, not a caller error, and the payment stays exactly as it was so
   * reconciliation can pick it up.
   */
  paymentProviderUnavailable: (providerKey: string | null, details?: Record<string, unknown>) =>
    new ApiException(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      'The payment provider for this payment is not available.',
      { provider: providerKey, ...details },
    ),

  /**
   * An adapter exists for this gateway but its integration is not implemented, because the
   * authoritative provider contract (endpoints, authentication, signing, request/response
   * shapes) is not available in this repository.
   *
   * This is deliberately a hard, loud failure rather than a fallback to another gateway or to a
   * stub: a payment module that quietly substitutes a mock for a production gateway would move
   * real money through a fiction. The adapter refuses, and `isAvailable()` keeps it out of
   * routing so this is only ever reachable by explicitly addressing it.
   */
  providerContractUnavailable: (providerKey: string, operation: string) =>
    new ApiException(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      `The ${providerKey} integration is not available.`,
      { provider: providerKey, operation, reason: 'provider_contract_unavailable' },
    ),

  // -----------------------------------------------------------------------------------------
  // Refunds (§3.2, §5.3, §9.3, §11.4, BRULE-24) — added by the refund task.
  // -----------------------------------------------------------------------------------------

  /**
   * Illegal `Refund.status` transition (§7's `refunds.status`). One code for the whole `Refund`
   * entity, following the same one-transition-code-per-aggregate convention `Payment` uses.
   * Reuses the existing `INVALID_PAYMENT_STATE_TRANSITION` code rather than adding a second
   * transition code: a refund is part of the payment aggregate's money lifecycle, no client
   * branches on the difference, and the catalog is append-only.
   */
  invalidRefundStateTransition: (from: string, to: string) =>
    new ApiException(
      ErrorCode.INVALID_PAYMENT_STATE_TRANSITION,
      `Cannot transition refund status from ${from} to ${to}.`,
      { from, to, aggregate: 'Refund' },
    ),

  /**
   * BRULE-24's over-refund invariant (§5.3 — "refund amount <= captured amount - already-refunded")
   * and §9's own listed `REFUND_EXCEEDS_CAPTURED`. The details carry the remaining refundable
   * amount, because a client that asked for too much needs to know what it may ask for instead.
   */
  refundExceedsCaptured: (details: {
    paymentId: string;
    requested: number;
    captured: number;
    alreadyRefunded: number;
    remaining: number;
    currency: string;
  }) =>
    new ApiException(
      ErrorCode.REFUND_EXCEEDS_CAPTURED,
      'This refund would exceed the amount still refundable on this payment.',
      details,
    ),

  /**
   * The payment is not in a state money can be returned from (§9's `REFUND_NOT_ELIGIBLE`,
   * BRULE-24). Raised for a payment whose funds were never captured — an authorization is a hold,
   * and the instrument for releasing a hold is `void`, not `refund` — and for one already fully
   * refunded or settled. See `RefundPolicy` for why each state is in or out.
   */
  refundNotEligible: (paymentId: string, status: string) =>
    new ApiException(
      ErrorCode.REFUND_NOT_ELIGIBLE,
      `A payment in status ${status} cannot be refunded.`,
      { paymentId, status },
    ),

  /**
   * A manual/admin refund was requested by an actor that does not hold `finance:refund:any`
   * (§3.2 F-RFD-03, §9.3 — "Manual/admin refunds require `finance:refund:any` + audit"). Enforced
   * in the application layer, not only at the HTTP boundary, so an in-process caller (the Orders
   * saga, a future admin tool) cannot reach the manual path without the same permission. Reuses
   * the shared `RBAC_FORBIDDEN` code the `PermissionsGuard` itself raises.
   */
  refundApprovalForbidden: (actorUserId: string | null) =>
    new ApiException(
      ErrorCode.RBAC_FORBIDDEN,
      'A manual refund requires the finance:refund:any permission.',
      { actorUserId, requiredPermission: 'finance:refund:any' },
    ),

  /**
   * The provider positively declined the refund (§11.4). The refund row is marked `FAILED` and its
   * amount becomes refundable again; the payment's status is unchanged, because no money moved.
   * `reason` is always the **sanitized** provider reason, never a raw payload.
   */
  refundFailed: (reason: string, details?: Record<string, unknown>) =>
    new ApiException(ErrorCode.BUSINESS_RULE_VIOLATION, reason, details),

  /**
   * A refund needs the capture posting it is reversing, and there isn't one. Reaching this means
   * a payment is recorded as `CAPTURED` with no `CAPTURE-<paymentId>` ledger transaction behind
   * it, which is a defect rather than a caller error — refusing is the only safe response, since
   * the alternative is inventing which accounts the money came from.
   */
  capturePostingMissing: (paymentId: string, reference: string) =>
    new ApiException(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      'This payment has no capture posting to reverse.',
      { paymentId, reference },
    ),

  /**
   * §11.6's named outcome: the wallet does not hold enough to fund this spend.
   *
   * `available` is always the **derived** balance (Σ credits − Σ debits over the wallet account's
   * entries), read inside the same `Serializable` transaction that would write the debit — never
   * the `account_balances` cache, and never a figure read in an earlier transaction. Reporting it
   * is safe: it is the caller's own wallet.
   */
  insufficientWalletBalance: (details: {
    customerUserId: string;
    requested: number;
    available: number;
    currency: string;
  }) =>
    new ApiException(
      ErrorCode.INSUFFICIENT_WALLET_BALANCE,
      'This wallet does not hold enough to cover the requested amount.',
      details,
    ),

  /**
   * A wallet top-up was asked to credit money that the funding payment does not evidence.
   *
   * Raised when the payment is not `CAPTURED` (no money has actually arrived), when it belongs to
   * a different customer, or when its funds were already allocated elsewhere by a
   * `CAPTURE-<paymentId>` posting — which would make the wallet credit unbacked money. Refusing is
   * the only safe answer: the alternative is inventing a source for a credit.
   */
  walletTopUpSourceInvalid: (reason: string, details?: Record<string, unknown>) =>
    new ApiException(ErrorCode.BUSINESS_RULE_VIOLATION, reason, details),

  /**
   * §12's `COUPON_INVALID` — the coupon cannot apply to *this* request: the code is unknown, the
   * coupon is deactivated, it has not started yet, the minimum spend is unmet, or nothing in the
   * cart falls within its scope.
   *
   * An unknown code and a deactivated coupon deliberately share this code and a generic message.
   * Distinguishing them would turn the endpoint into an oracle for which codes exist, which is how
   * unpublished promotional codes get harvested.
   */
  couponInvalid: (reason: string, details?: Record<string, unknown>) =>
    new ApiException(ErrorCode.COUPON_INVALID, reason, details),

  /** §12's `COUPON_EXPIRED` — `expiresAt` has passed. Split out because §12 names it separately. */
  couponExpired: (details: { code: string; expiresAt: Date }) =>
    new ApiException(ErrorCode.COUPON_EXPIRED, 'This coupon has expired.', details),

  /**
   * §12's `COUPON_USAGE_EXCEEDED` (F-CPN-02) — a global or per-user limit is already met.
   *
   * `scope` says which limit, because the two mean different things to a customer: a global limit
   * means the promotion is exhausted for everyone, a per-user limit means they have already used
   * theirs. Neither reveals another customer's activity — the per-user count is the caller's own,
   * and the global count is a property of the promotion.
   */
  couponUsageExceeded: (details: {
    code: string;
    scope: 'GLOBAL' | 'PER_USER';
    limit: number;
    used: number;
  }) =>
    new ApiException(
      ErrorCode.COUPON_USAGE_EXCEEDED,
      details.scope === 'GLOBAL'
        ? 'This coupon has reached its usage limit.'
        : 'You have already used this coupon the maximum number of times.',
      details,
    ),

  /**
   * An admin tried to create a coupon whose canonical code is already taken. Reported as a
   * conflict rather than a validation error because the request is well-formed — the code simply
   * exists. Note `save10` and `SAVE10` collide here, which is the point of canonical codes.
   */
  couponCodeTaken: (code: string) =>
    new ApiException(ErrorCode.CONFLICT, 'A coupon with this code already exists.', { code }),

  /**
   * A coupon redemption was asked to make a transition its lifecycle does not allow — reversing a
   * redemption that is already `REVERSED`, or applying one twice. §7 defines exactly two states
   * and no path back from `REVERSED`.
   */
  invalidRedemptionStateTransition: (details: {
    redemptionId: string;
    from: string;
    to: string;
  }) =>
    new ApiException(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      `A coupon redemption cannot move from ${details.from} to ${details.to}.`,
      details,
    ),
};
