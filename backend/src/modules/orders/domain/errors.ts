import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Cart, Checkout & Orders domain/application errors (module-06 `06-orders-spec.md` §10). Thrown
 * from the domain and application layers and translated to the standard error envelope by the
 * global `AllExceptionsFilter`, mirroring `modules/prescription-matching/domain/errors.ts` and
 * `modules/pharmacy-inventory/domain/errors.ts`.
 *
 * The domain-foundation task defined only the errors its pure domain layer threw directly
 * (`INVALID_ORDER_STATE_TRANSITION`/`CANCELLATION_NOT_ALLOWED`/`VALIDATION_ERROR`). The Cart
 * application-layer task added the two generic, already-existing shared codes Cart's
 * commands/queries needed — `notFound`/`catalogProductUnavailable` below reuse
 * `ErrorCode.NOT_FOUND`/`ErrorCode.CATALOG_PRODUCT_NOT_FOUND` exactly as `CatalogErrors`/
 * `PharmacyInventoryErrors`/`ProfilesErrors` already do for their own repository-miss cases — no
 * new shared error code was introduced there. This, the Order/Fulfillment application-layer
 * task, adds `orderNotFound` (new `ORDER_NOT_FOUND` code, §10) and `concurrentModification`
 * (reused generic `CONFLICT`, §11's bounded-retry exhaustion contract). `PRICE_CHANGED` (§10)
 * remains deferred to the Checkout saga task, the only Slice-1 command that can raise it.
 */
export const OrdersErrors = {
  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),

  /** Generic not-found for Cart/CartItem lookups (§9.1) — mirrors `CatalogErrors.notFound()`'s
   * reuse of the shared `NOT_FOUND` code. Ownership mismatches are reported identically to a
   * genuine miss (no existence leakage across customers, `00-shared-conventions.md` §1, the same
   * discipline module-05's `GetPrescriptionQuery`/`ReuploadPrescriptionCommand` already apply). */
  notFound: (message = 'Cart item not found.', details?: unknown) =>
    new ApiException(ErrorCode.NOT_FOUND, message, details),

  /** Reuses the existing, already-shared `CATALOG_PRODUCT_NOT_FOUND` code (defined ahead of
   * Module 05, already reused by it for the identical "referenced Catalog product doesn't exist
   * or isn't sellable" case, `PrescriptionMatchingErrors.catalogProductNotFound()`) — not a new
   * Module 06 error code. Thrown when `AddCartItemCommand` resolves a `catalogProductId` via
   * `ICatalogPort.getProduct()` that is missing or not `ACTIVE` (§3.2). */
  catalogProductUnavailable: () =>
    new ApiException(ErrorCode.CATALOG_PRODUCT_NOT_FOUND, 'Catalog product not found or inactive.'),

  /**
   * A single, shared code for both `Order.status` and `Fulfillment.status` illegal transitions
   * (module-06 spec §3.4/§3.6) — `Fulfillment` is a child entity of the `Order` aggregate, not a
   * separate aggregate root (unlike module-05's `Prescription`/`MatchRequest`, which are two
   * distinct aggregate roots and therefore earned two distinct codes) — one code per *aggregate*
   * remains the rule; `aggregate` in `details` disambiguates which state machine rejected the
   * transition.
   */
  invalidOrderStateTransition: (
    from: string,
    to: string,
    aggregate: 'order' | 'fulfillment' = 'order',
  ) =>
    new ApiException(
      ErrorCode.INVALID_ORDER_STATE_TRANSITION,
      `Cannot transition ${aggregate} status from ${from} to ${to}.`,
      { from, to, aggregate },
    ),

  cancellationNotAllowed: (status: string) =>
    new ApiException(
      ErrorCode.CANCELLATION_NOT_ALLOWED,
      `An order in status ${status} can no longer be cancelled.`,
      { status },
    ),

  /** Order-scoped reads/mutations (§10, §9.3/§9.4) — a dedicated code, not a reuse of the
   * generic `NOT_FOUND`, mirroring `PRESCRIPTION_NOT_FOUND`'s per-aggregate convention (§10's own
   * stated rationale). Ownership mismatches resolve to this same error (no existence leakage
   * across customers, §7/§9.3, identical discipline to module-05's `GetPrescriptionQuery`). */
  orderNotFound: (message = 'Order not found.', details?: unknown) =>
    new ApiException(ErrorCode.ORDER_NOT_FOUND, message, details),

  /**
   * `409 PRICE_CHANGED` (§10) — "`/checkout` — cart price diverged from the fresh Module 03 read
   * at step 1; client must re-quote". The confirmation baseline is `CartItem.indicativePrice`,
   * which is exactly what §10 means by "cart price": the price last shown to and confirmed by the
   * customer, written at add-to-cart time and refreshed by `/cart/validate` / `/checkout/quote`
   * ("stale prices reconciled", parent doc F-CRT-06). Neither spec defines a quote token, id or
   * version to pass back into `/checkout` — §9.2's request body has no such field — so the cart's
   * own cached price is the contract's baseline, not an invented second mechanism.
   *
   * This never makes the stale cache authoritative for *what the customer pays*: the charged
   * price is still the fresh catalog read (§3.12 invariant 2). The cache only decides whether
   * checkout may proceed at all.
   */
  priceChanged: (
    details: Array<{ catalogProductId: string; confirmedPrice: number | null; currentPrice: number }>,
  ) =>
    new ApiException(
      ErrorCode.PRICE_CHANGED,
      'Prices changed since your last quote. Please re-quote before checking out.',
      { items: details },
    ),

  /**
   * A mutation's `Serializable` transaction (state change + audit + outbox, ADR-013/§11)
   * contended for longer than the bounded retry budget — mirrors
   * `PrescriptionMatchingErrors.concurrentModification()` exactly (own copy per ADR-002).
   */
  concurrentModification: (details?: unknown) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This record was changed concurrently by another request. Please retry.',
      details,
    ),

  /** `POST /checkout`'s `idempotencyKey` (§4, §13.5) was already used for a different customer
   * (or, in the vanishingly rare concurrent-race case, a different logical checkout for the same
   * customer) — reuses the existing, already-shared `IDEMPOTENCY_CONFLICT` code exactly as
   * `PharmacyInventoryErrors.idempotencyKeyConflict()` does for `ReserveStockCommand`, never
   * silently returning the mismatched order. */
  idempotencyConflict: (details?: unknown) =>
    new ApiException(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      'This idempotency key was already used for a different checkout.',
      details,
    ),

  /** `CheckoutCommand`'s Rx gate step (§4 step 2, §9.2) blocks on one or more requested lines.
   * `blocked[0].reason` is already one of `RX_REQUIRED`/`PRESCRIPTION_EXPIRED`/
   * `PRESCRIPTION_EXHAUSTED` — module-05's own `ICheckRxGatePort.check()` result already encodes
   * the precise reason per line (`BlockedItem.reason`), so this reuses that code verbatim rather
   * than collapsing every case to a generic `RX_REQUIRED` (§10's "reused, not redefined"
   * discipline — no new Module 06 error code for this). */
  rxGateBlocked: (blocked: Array<{ catalogProductId: string; reason: ErrorCode }>) =>
    new ApiException(
      blocked[0]?.reason ?? ErrorCode.RX_REQUIRED,
      'One or more items require a valid, unexpired, non-exhausted prescription.',
      { blocked },
    ),

  /**
   * The customer supplied a `couponCode` that does not apply to this checkout (ADR-019/020/021).
   *
   * Maps Module 07's own rejection reason onto §12's three **existing, shared** coupon codes
   * rather than defining a Module 06 code — the same "reused, not redefined" discipline
   * {@link OrdersErrors.rxGateBlocked} follows for the Rx gate, so a client sees one coupon error
   * vocabulary whether it validated the code up front through `POST /coupons/validate` or found
   * out at checkout.
   *
   * `PHARMACY_SCOPE_UNRESOLVABLE` is deliberately **not** in the mapping's special cases and falls
   * through to `COUPON_INVALID`: at checkout the pharmacy is already matched (ADR-020), so that
   * reason is unreachable here — it belongs to the pre-checkout preview, which has no pharmacy.
   * Reaching it would mean the saga quoted without a matched pharmacy, which is a defect.
   */
  couponNotApplicable: (code: string, reason: string) =>
    new ApiException(
      reason === 'EXPIRED'
        ? ErrorCode.COUPON_EXPIRED
        : reason === 'GLOBAL_LIMIT_REACHED' || reason === 'PER_USER_LIMIT_REACHED'
          ? ErrorCode.COUPON_USAGE_EXCEEDED
          : ErrorCode.COUPON_INVALID,
      'This coupon cannot be applied to your order.',
      // The code is echoed because the customer typed it; the reason is the machine-readable
      // one Module 07 produced. Neither exposes anything about how the discount is funded.
      { couponCode: code, reason },
    ),
};
