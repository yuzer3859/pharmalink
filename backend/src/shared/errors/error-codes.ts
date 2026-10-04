/**
 * Canonical, stable error codes returned in the error envelope (see
 * architecture/00-shared-conventions.md §1 & §14). Clients switch on these codes, not on
 * HTTP status or message text. Keep codes append-only; never repurpose an existing code.
 */
export enum ErrorCode {
  // Generic
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',

  // AuthN / AuthZ
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',

  // Domain / business rule
  BUSINESS_RULE_VIOLATION = 'BUSINESS_RULE_VIOLATION',
  RESOURCE_LOCKED = 'RESOURCE_LOCKED',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',

  // Dependencies
  DEPENDENCY_UNAVAILABLE = 'DEPENDENCY_UNAVAILABLE',

  // Module 01 — Identity & Authentication (see module-01 §14). Appended per the Phase-0
  // freeze exception: the shared error catalog had no way to express these mandated,
  // client-localized auth codes. Append-only; never repurpose.
  AUTH_DUPLICATE_IDENTIFIER = 'AUTH_DUPLICATE_IDENTIFIER',
  AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS',
  AUTH_ACCOUNT_SUSPENDED = 'AUTH_ACCOUNT_SUSPENDED',
  AUTH_ACCOUNT_LOCKED = 'AUTH_ACCOUNT_LOCKED',
  AUTH_OTP_INVALID = 'AUTH_OTP_INVALID',
  AUTH_OTP_EXPIRED = 'AUTH_OTP_EXPIRED',
  AUTH_OTP_ATTEMPTS_EXCEEDED = 'AUTH_OTP_ATTEMPTS_EXCEEDED',
  AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID',
  AUTH_REFRESH_INVALID = 'AUTH_REFRESH_INVALID',
  AUTH_REFRESH_REUSE_DETECTED = 'AUTH_REFRESH_REUSE_DETECTED',
  AUTH_MFA_REQUIRED = 'AUTH_MFA_REQUIRED',
  AUTH_WEAK_PASSWORD = 'AUTH_WEAK_PASSWORD',
  AUTH_OAUTH_INVALID = 'AUTH_OAUTH_INVALID',
  RBAC_FORBIDDEN = 'RBAC_FORBIDDEN',
  VERIFICATION_PENDING = 'VERIFICATION_PENDING',
  VERIFICATION_REJECTED = 'VERIFICATION_REJECTED',

  // Module 02 — Profiles (see backend/docs/02-profiles-spec.md §13). Appended per the
  // Phase-0 freeze exception, same rationale as the Module 01 auth codes above.
  ADDRESS_OUTSIDE_ETHIOPIA = 'ADDRESS_OUTSIDE_ETHIOPIA',
  ADDRESS_LIMIT_REACHED = 'ADDRESS_LIMIT_REACHED',
  DEFAULT_ADDRESS_REQUIRED = 'DEFAULT_ADDRESS_REQUIRED',

  // Module 03 — Catalog (see backend/docs/03-catalog-spec.md §13). Appended per the
  // Phase-0 freeze exception, same rationale as the Module 01/02 codes above.
  CATALOG_DUPLICATE_PRODUCT = 'CATALOG_DUPLICATE_PRODUCT',
  INVALID_PRODUCT_STATUS_TRANSITION = 'INVALID_PRODUCT_STATUS_TRANSITION',
  MANUFACTURER_NOT_FOUND = 'MANUFACTURER_NOT_FOUND',
  CATEGORY_NOT_FOUND = 'CATEGORY_NOT_FOUND',
  CATEGORY_CYCLE_DETECTED = 'CATEGORY_CYCLE_DETECTED',
  CATEGORY_HAS_PRODUCTS = 'CATEGORY_HAS_PRODUCTS',
  INVALID_CLASSIFICATION = 'INVALID_CLASSIFICATION',

  // Module 04 — Pharmacy & Inventory (see backend/docs/04-pharmacy-inventory-spec.md §10.3).
  // Appended per the Phase-0 freeze exception, same rationale as the Module 01/02/03 codes above.
  PHARMACY_NOT_ELIGIBLE = 'PHARMACY_NOT_ELIGIBLE',
  LICENSE_EXPIRED = 'LICENSE_EXPIRED',
  PHARMACY_SUSPENDED = 'PHARMACY_SUSPENDED',
  PHARMACY_ALREADY_REGISTERED = 'PHARMACY_ALREADY_REGISTERED',
  BRANCH_NOT_FOUND = 'BRANCH_NOT_FOUND',
  LISTING_NOT_FOUND = 'LISTING_NOT_FOUND',
  DUPLICATE_LISTING = 'DUPLICATE_LISTING',
  INSUFFICIENT_STOCK = 'INSUFFICIENT_STOCK',
  BATCH_EXPIRED = 'BATCH_EXPIRED',
  RESERVATION_NOT_FOUND = 'RESERVATION_NOT_FOUND',
  INVALID_RESERVATION_STATE = 'INVALID_RESERVATION_STATE',
  RESERVATION_EXPIRED = 'RESERVATION_EXPIRED',
  CATALOG_PRODUCT_NOT_FOUND = 'CATALOG_PRODUCT_NOT_FOUND',
  CONTROLLED_PROHIBITED = 'CONTROLLED_PROHIBITED',

  // Module 05 — Prescription & Matching (see backend/docs/05-prescription-matching-spec.md
  // §15.2). Appended per the Phase-0 freeze exception, same rationale as the Module 01/02/03/04
  // codes above.
  PRESCRIPTION_NOT_FOUND = 'PRESCRIPTION_NOT_FOUND',
  PRESCRIPTION_EXPIRED = 'PRESCRIPTION_EXPIRED',
  PRESCRIPTION_NOT_APPROVED = 'PRESCRIPTION_NOT_APPROVED',
  PRESCRIPTION_EXHAUSTED = 'PRESCRIPTION_EXHAUSTED',
  RX_REQUIRED = 'RX_REQUIRED',
  REJECTION_REASON_REQUIRED = 'REJECTION_REASON_REQUIRED',
  VERIFICATION_FORBIDDEN = 'VERIFICATION_FORBIDDEN',
  INVALID_PRESCRIPTION_STATE_TRANSITION = 'INVALID_PRESCRIPTION_STATE_TRANSITION',
  INVALID_MATCH_STATE_TRANSITION = 'INVALID_MATCH_STATE_TRANSITION',
  NO_PHARMACY_MATCH = 'NO_PHARMACY_MATCH',
  MATCH_CANDIDATE_UNAVAILABLE = 'MATCH_CANDIDATE_UNAVAILABLE',
  MATCH_FAILED = 'MATCH_FAILED',

  // Module 06 — Cart, Checkout & Orders (see backend/docs/06-orders-spec.md §10). Appended per
  // the Phase-0 freeze exception, same rationale as the Module 01/02/03/04/05 codes above.
  // `ORDER_NOT_FOUND` is added by the Order/Fulfillment application-layer task (§10's
  // "order-scoped reads/mutations" row). `PRICE_CHANGED` completes §10's four-code set: it is
  // raised by `CheckoutCommand`'s step 1 when the fresh Module 03 read diverges from the price
  // the customer last confirmed (`CartItem.indicativePrice`, refreshed by `/cart/validate` and
  // `/checkout/quote`) — the client must re-quote before checking out.
  INVALID_ORDER_STATE_TRANSITION = 'INVALID_ORDER_STATE_TRANSITION',
  CANCELLATION_NOT_ALLOWED = 'CANCELLATION_NOT_ALLOWED',
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  PRICE_CHANGED = 'PRICE_CHANGED',

  // Module 07 — Payment, Wallet & Settlement (see architecture/module-07-payment-wallet.md §9,
  // §12). Appended per the Phase-0 freeze exception, same rationale as the Module 01..06 codes
  // above. Only the two codes the ledger/payment *foundation* can actually raise are added here;
  // §9's remaining representative codes (`PAYMENT_AUTH_FAILED`, `REFUND_EXCEEDS_CAPTURED`,
  // `INSUFFICIENT_WALLET_BALANCE`, `COUPON_*`, `WEBHOOK_SIGNATURE_INVALID`, …) belong to the
  // provider/refund/wallet/coupon/webhook tasks that raise them — the catalog is append-only, so
  // a code is added when its thrower exists, never speculatively.
  //
  // `INVALID_PAYMENT_STATE_TRANSITION` follows the established one-transition-code-per-aggregate
  // convention (`INVALID_ORDER_STATE_TRANSITION`, `INVALID_PRESCRIPTION_STATE_TRANSITION`,
  // `INVALID_PRODUCT_STATUS_TRANSITION`): the §6 `Payment` state machine needs its own.
  INVALID_PAYMENT_STATE_TRANSITION = 'INVALID_PAYMENT_STATE_TRANSITION',
  LEDGER_UNBALANCED = 'LEDGER_UNBALANCED',
  // Added by the payment-authorization task: the provider declined (or could not complete) the
  // authorization (§9's representative error list, §11.1). The remaining §9 codes still belong to
  // the capture/refund/wallet/coupon/webhook tasks that raise them.
  PAYMENT_AUTH_FAILED = 'PAYMENT_AUTH_FAILED',
  // Added by the capture/void task. `PAYMENT_ALREADY_CAPTURED` is §9's own listed code and is
  // raised when a void is attempted on money that has already moved. `PAYMENT_CAPTURE_FAILED` is
  // added deliberately: §6 defines no `AUTHORIZED -> FAILED` transition, so a declined *capture*
  // is a distinct outcome from a declined *authorization* and cannot reuse `PAYMENT_AUTH_FAILED`
  // without misreporting which step failed and what state the payment is now in.
  PAYMENT_ALREADY_CAPTURED = 'PAYMENT_ALREADY_CAPTURED',
  PAYMENT_CAPTURE_FAILED = 'PAYMENT_CAPTURE_FAILED',
  // Added by the webhook task — §9's own listed code. A provider callback whose signature does
  // not verify is not a client error to be explained; it is an unauthenticated caller claiming to
  // be a payment gateway, and §13 requires it be logged as a security event.
  WEBHOOK_SIGNATURE_INVALID = 'WEBHOOK_SIGNATURE_INVALID',
  // Added by the refund task — both are §9's own listed representative codes.
  // `REFUND_EXCEEDS_CAPTURED` is BRULE-24's over-refund invariant ("refund amount <= captured
  // amount - already-refunded"), and it is deliberately its own code rather than a generic
  // `BUSINESS_RULE_VIOLATION`: a caller that asked for too much needs to know the remaining
  // refundable amount, and a client retrying a partial refund must be able to distinguish it
  // from an ineligible payment. `REFUND_NOT_ELIGIBLE` covers the eligibility half of BRULE-24 —
  // a payment whose money was never captured cannot be refunded at all.
  REFUND_EXCEEDS_CAPTURED = 'REFUND_EXCEEDS_CAPTURED',
  REFUND_NOT_ELIGIBLE = 'REFUND_NOT_ELIGIBLE',
  // Added by the wallet task — §9/§12's own listed code, and §11.6's named outcome for a spend
  // the wallet cannot fund. Its own code rather than a generic `BUSINESS_RULE_VIOLATION` because
  // a checkout saga must be able to tell "this customer cannot pay from the wallet" (offer
  // another method) apart from every other reason a spend could be refused.
  INSUFFICIENT_WALLET_BALANCE = 'INSUFFICIENT_WALLET_BALANCE',
  // Added by the coupon task — all three are §12's own listed representative codes.
  // `COUPON_INVALID` covers every way a coupon cannot apply to *this* request (unknown code,
  // deactivated, not yet started, min-spend unmet, nothing in scope). `COUPON_EXPIRED` is split
  // out because §12 names it separately and a client should be able to say "this one has run
  // out of time" rather than "invalid". `COUPON_USAGE_EXCEEDED` is the limit outcome.
  COUPON_INVALID = 'COUPON_INVALID',
  COUPON_EXPIRED = 'COUPON_EXPIRED',
  COUPON_USAGE_EXCEEDED = 'COUPON_USAGE_EXCEEDED',

  // Module 08 — Delivery Management & Tracking (see architecture/module-08-delivery-tracking.md
  // §12). Appended per the Phase-0 freeze exception, same rationale as the Module 01..07 codes
  // above, and on the same append-only terms: a code is added when its thrower exists, never
  // speculatively. The delivery-domain-foundation work raises exactly one of §12's codes — the
  // state-machine guard — so exactly one was added there. `POD_REQUIRED` arrives with the
  // proof-of-delivery work; `DRIVER_NOT_VERIFIED` arrived with the driver operational profile and
  // `OFFER_EXPIRED`/`CONCURRENT_LIMIT_REACHED`/`JOB_ALREADY_ASSIGNED` with dispatch — all below.
  //
  // Named for the aggregate per the established one-transition-code-per-aggregate convention
  // (`INVALID_ORDER_STATE_TRANSITION`, `INVALID_PAYMENT_STATE_TRANSITION`): §12 calls it
  // `INVALID_STATE_TRANSITION`, but an unqualified name could not tell a client which of the
  // platform's state machines refused.
  INVALID_DELIVERY_STATE_TRANSITION = 'INVALID_DELIVERY_STATE_TRANSITION',
  // BRULE-27's precondition, added by the job-creation work: a delivery job may be cut only from
  // a fulfillment that is ready for delivery. Not one of §12's names — §12 lists the driver-facing
  // failures — but the refusal needs to be distinguishable from a validation slip or a missing
  // row, because the caller is an event handler that must decide whether to retry.
  FULFILLMENT_NOT_DELIVERABLE = 'FULFILLMENT_NOT_DELIVERABLE',
  // BRULE-09, added by the driver-operational-profile work, which is the first code that can
  // raise it: a driver may not go online — and so may not become dispatchable — unless Module 01
  // says they are a verified, active driver. One of §12's own listed codes.
  //
  // Deliberately *not* added by the two earlier Module 08 works, which had no verification check
  // to fail; the catalogue stays append-only on the terms stated above.
  DRIVER_NOT_VERIFIED = 'DRIVER_NOT_VERIFIED',
  // §12's three dispatch codes, added by the dispatch work, which is the first that can raise any
  // of them. Each names a distinct reason an accept was refused, and the distinction is the point:
  // a driver's app has to tell "somebody else took it" (move on) from "you are already carrying
  // your limit" (finish one first) from "you answered too late" (be quicker), and a single
  // `CONFLICT` would collapse three different instructions into one shrug.
  OFFER_EXPIRED = 'OFFER_EXPIRED',
  CONCURRENT_LIMIT_REACHED = 'CONCURRENT_LIMIT_REACHED',
  JOB_ALREADY_ASSIGNED = 'JOB_ALREADY_ASSIGNED',
  // BRULE-29, added by the proof-of-delivery work — the code this catalogue has been reserving
  // since the domain-foundation work named it. A delivery whose policy demands evidence cannot be
  // marked delivered without it, and the driver's app needs to tell that refusal apart from an
  // illegal transition: the job *is* in a state that may become `DELIVERED`, and what is missing
  // is a photograph or a signature the driver can still go and capture. One of §12's own codes.
  POD_REQUIRED = 'POD_REQUIRED',
  // `NO_DRIVER_AVAILABLE` is §12's fourth dispatch code and is deliberately **still absent**.
  // Dispatch exhaustion is not an error in this implementation: it is a returned outcome
  // (`DispatchOutcome.NoCandidate`) that leaves the job dispatchable, because the only caller is
  // an event handler with nobody to report an exception to, and a job that threw would be a job
  // nobody was looking for. The code is added by the first work that gives exhaustion a caller who
  // can act on it — the admin dispatch route, or the escalation sweeper of §6.5.

  // ---------------------------------------------------------------------------------------------
  // Module 16 — Admin & Platform Management
  // ---------------------------------------------------------------------------------------------
  // §9's `CONFIG_VALIDATION_FAILED`: an authorized administrator supplied a well-formed request
  // whose *value* the owning module's own contract refuses — a delivery offer TTL of 2 seconds, a
  // platform fee of 1.5, a proof requirement that is not one of the three the module defines.
  //
  // Distinct from `VALIDATION_ERROR`, which says the request was malformed, and from `CONFLICT`,
  // which says the platform's current state refuses. Here the request is well-formed and the state
  // is irrelevant: the number itself is outside what the module will accept, and the operator needs
  // to be told which bound they crossed rather than being told their JSON was wrong.
  //
  // `ADMIN_PERMISSION_DENIED` and `ELEVATED_ROLE_REQUIRED` from §9 are deliberately **not** added.
  // `PermissionsGuard` already refuses an unentitled caller with `RBAC_FORBIDDEN`, and a second
  // code for the same refusal would give one rejection two names for no gain.
  CONFIG_VALIDATION_FAILED = 'CONFIG_VALIDATION_FAILED',
}

/** Default HTTP status mapping for each error code. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.BUSINESS_RULE_VIOLATION]: 422,
  [ErrorCode.RESOURCE_LOCKED]: 423,
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 409,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: 503,

  // Module 01 — Identity (HTTP mapping per module-01 §14).
  [ErrorCode.AUTH_DUPLICATE_IDENTIFIER]: 409,
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 401,
  [ErrorCode.AUTH_ACCOUNT_SUSPENDED]: 403,
  [ErrorCode.AUTH_ACCOUNT_LOCKED]: 423,
  [ErrorCode.AUTH_OTP_INVALID]: 400,
  [ErrorCode.AUTH_OTP_EXPIRED]: 410,
  [ErrorCode.AUTH_OTP_ATTEMPTS_EXCEEDED]: 429,
  [ErrorCode.AUTH_TOKEN_INVALID]: 401,
  [ErrorCode.AUTH_REFRESH_INVALID]: 401,
  [ErrorCode.AUTH_REFRESH_REUSE_DETECTED]: 401,
  [ErrorCode.AUTH_MFA_REQUIRED]: 401,
  [ErrorCode.AUTH_WEAK_PASSWORD]: 422,
  [ErrorCode.AUTH_OAUTH_INVALID]: 401,
  [ErrorCode.RBAC_FORBIDDEN]: 403,
  [ErrorCode.VERIFICATION_PENDING]: 403,
  [ErrorCode.VERIFICATION_REJECTED]: 403,

  // Module 02 — Profiles (HTTP mapping per module-02 §13).
  [ErrorCode.ADDRESS_OUTSIDE_ETHIOPIA]: 422,
  [ErrorCode.ADDRESS_LIMIT_REACHED]: 422,
  [ErrorCode.DEFAULT_ADDRESS_REQUIRED]: 422,

  // Module 03 — Catalog (HTTP mapping per module-03 §13).
  [ErrorCode.CATALOG_DUPLICATE_PRODUCT]: 409,
  [ErrorCode.INVALID_PRODUCT_STATUS_TRANSITION]: 422,
  [ErrorCode.MANUFACTURER_NOT_FOUND]: 404,
  [ErrorCode.CATEGORY_NOT_FOUND]: 404,
  [ErrorCode.CATEGORY_CYCLE_DETECTED]: 422,
  [ErrorCode.CATEGORY_HAS_PRODUCTS]: 409,
  [ErrorCode.INVALID_CLASSIFICATION]: 422,

  // Module 04 — Pharmacy & Inventory (HTTP mapping per module-04 §10.3).
  [ErrorCode.PHARMACY_NOT_ELIGIBLE]: 403,
  [ErrorCode.LICENSE_EXPIRED]: 403,
  [ErrorCode.PHARMACY_SUSPENDED]: 403,
  [ErrorCode.PHARMACY_ALREADY_REGISTERED]: 409,
  [ErrorCode.BRANCH_NOT_FOUND]: 404,
  [ErrorCode.LISTING_NOT_FOUND]: 404,
  [ErrorCode.DUPLICATE_LISTING]: 409,
  [ErrorCode.INSUFFICIENT_STOCK]: 409,
  [ErrorCode.BATCH_EXPIRED]: 422,
  [ErrorCode.RESERVATION_NOT_FOUND]: 404,
  [ErrorCode.INVALID_RESERVATION_STATE]: 422,
  [ErrorCode.RESERVATION_EXPIRED]: 410,
  [ErrorCode.CATALOG_PRODUCT_NOT_FOUND]: 404,
  [ErrorCode.CONTROLLED_PROHIBITED]: 422,

  // Module 05 — Prescription & Matching (HTTP mapping per module-05 §15.2).
  [ErrorCode.PRESCRIPTION_NOT_FOUND]: 404,
  [ErrorCode.PRESCRIPTION_EXPIRED]: 422,
  [ErrorCode.PRESCRIPTION_NOT_APPROVED]: 422,
  [ErrorCode.PRESCRIPTION_EXHAUSTED]: 409,
  [ErrorCode.RX_REQUIRED]: 422,
  [ErrorCode.REJECTION_REASON_REQUIRED]: 422,
  [ErrorCode.VERIFICATION_FORBIDDEN]: 403,
  [ErrorCode.INVALID_PRESCRIPTION_STATE_TRANSITION]: 409,
  [ErrorCode.INVALID_MATCH_STATE_TRANSITION]: 409,
  [ErrorCode.NO_PHARMACY_MATCH]: 409,
  [ErrorCode.MATCH_CANDIDATE_UNAVAILABLE]: 409,
  [ErrorCode.MATCH_FAILED]: 409,

  // Module 06 — Cart, Checkout & Orders (HTTP mapping per 06-orders-spec.md §10).
  [ErrorCode.INVALID_ORDER_STATE_TRANSITION]: 409,
  [ErrorCode.CANCELLATION_NOT_ALLOWED]: 422,
  [ErrorCode.ORDER_NOT_FOUND]: 404,
  [ErrorCode.PRICE_CHANGED]: 409,

  // Module 07 — Payment (HTTP mapping per module-07 design §9/§12).
  [ErrorCode.INVALID_PAYMENT_STATE_TRANSITION]: 409,
  // 500, deliberately: `LEDGER_UNBALANCED` is the design's own "internal guard / bug tripwire"
  // (§9, §12). No API client can submit a ledger posting, so a posting that fails to balance is
  // never a caller's input error — it is a defect in a money command, and must surface as one.
  [ErrorCode.LEDGER_UNBALANCED]: 500,
  // 402 Payment Required — the request was well-formed and authorized, and the platform did its
  // part; the *payment* was declined. This is the status payment APIs conventionally use for a
  // decline, and it is distinguishable by clients from a 422 business-rule rejection (e.g. an
  // order that is not in a payable state) and from a 503 provider outage.
  [ErrorCode.PAYMENT_AUTH_FAILED]: 402,
  // 409: the payment is in a state the requested operation cannot apply to, and no retry will
  // change that — money has already been captured.
  [ErrorCode.PAYMENT_ALREADY_CAPTURED]: 409,
  // 402, the same family as PAYMENT_AUTH_FAILED: the platform did its part and the *payment*
  // step was declined by the provider.
  [ErrorCode.PAYMENT_CAPTURE_FAILED]: 402,
  // 401: the *sender* failed to authenticate itself. Deliberately not 400 — the payload may be
  // perfectly well-formed; what failed is proof that the gateway sent it.
  [ErrorCode.WEBHOOK_SIGNATURE_INVALID]: 401,
  // 422: the request is well-formed and the caller is authorized — the *amount* breaks BRULE-24's
  // invariant. Not 409: no retry of the same request can ever succeed, because the remaining
  // refundable amount only ever decreases.
  [ErrorCode.REFUND_EXCEEDS_CAPTURED]: 422,
  // 422, the same family: the payment is not in a state from which money can be returned.
  [ErrorCode.REFUND_NOT_ELIGIBLE]: 422,
  // 422, the same family again: the request is well-formed and the caller is authorized — the
  // wallet simply does not hold the money. Not 409, because retrying the identical request
  // cannot succeed until an unrelated credit arrives.
  [ErrorCode.INSUFFICIENT_WALLET_BALANCE]: 422,
  // 422: well-formed, authorized, and the coupon simply does not apply to this request. Retrying
  // the identical request cannot change that.
  [ErrorCode.COUPON_INVALID]: 422,
  [ErrorCode.COUPON_EXPIRED]: 422,
  // 409, deliberately unlike its two neighbours: a usage limit is contention, not a permanent
  // property of the request. A reversal (F-CPN-03) frees capacity, so the identical request can
  // legitimately succeed later — which is exactly what distinguishes 409 from 422 here.
  [ErrorCode.COUPON_USAGE_EXCEEDED]: 409,

  // Module 08 — Delivery (HTTP mapping per module-08 design §12). 409, matching every other
  // aggregate's illegal-transition code: the request is well-formed, the aggregate's current
  // state is what refuses it.
  [ErrorCode.INVALID_DELIVERY_STATE_TRANSITION]: 409,
  // 422: the request is well-formed and the fulfillment exists, but a business rule (BRULE-27)
  // refuses it — the same mapping `CANCELLATION_NOT_ALLOWED` carries for the same shape of rule.
  [ErrorCode.FULFILLMENT_NOT_DELIVERABLE]: 422,
  // 403, following `PHARMACY_NOT_ELIGIBLE` and `LICENSE_EXPIRED` rather than the 422 above. The
  // shape is identical to theirs: a provider whose credentials are not in order being refused a
  // privileged action. The caller authenticated successfully and is asking a legitimate question;
  // the answer is that this account may not do this yet, which is what 403 means.
  [ErrorCode.DRIVER_NOT_VERIFIED]: 403,
  // 409 for all three: the request is well-formed and the caller is authorized, and in each case
  // the platform's *current state* is what refuses. None is permanent the way a 422 implies — the
  // driver's next offer, their next free slot, or the next job all make the identical request
  // succeed. This is the same reasoning that put `COUPON_USAGE_EXCEEDED` at 409 while its two
  // neighbours stayed at 422.
  [ErrorCode.OFFER_EXPIRED]: 409,
  [ErrorCode.CONCURRENT_LIMIT_REACHED]: 409,
  [ErrorCode.JOB_ALREADY_ASSIGNED]: 409,
  // 409, not 422: the request is well-formed and the caller is entitled to make it — the job's
  // current evidence is what refuses, and capturing proof makes the identical request succeed.
  [ErrorCode.POD_REQUIRED]: 409,
  // 422, not 400: the request parsed and its shape is right — a JSON body with the declared type
  // and a value of the correct primitive kind. What failed is a *semantic* rule the owning module
  // declares about that value's range or permitted set, which is exactly the distinction 422 draws
  // and the same reasoning that placed the coupon amount codes there.
  [ErrorCode.CONFIG_VALIDATION_FAILED]: 422,
};
