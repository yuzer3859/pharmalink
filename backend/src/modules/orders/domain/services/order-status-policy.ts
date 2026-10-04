import { OrdersErrors } from '../errors';
import { OrderStatus } from '../enums';

/**
 * Pure state machine for `Order.status` (module-06 `06-orders-spec.md` §3.4, §3.12 invariant 3).
 * Slice 1's write-time transition graph is a strict subset of the parent design's 11-state
 * narrative — reconciled against the actual 10-value Prisma `OrderStatus` enum, not the parent
 * doc's prose, exactly as §3.4 documents:
 *  - `DRAFT -> PENDING_PAYMENT`: checkout submitted (Rx gate passed, matching succeeded, address
 *    resolved) — §4 step 6.
 *  - `PENDING_PAYMENT -> PAID`: COD confirmed, immediate, no gateway round-trip (§4 step 8) —
 *    every Slice-1 order is COD, so this is the *only* way `PENDING_PAYMENT` resolves to success.
 *  - `PENDING_PAYMENT -> CANCELLED`: reservation/order-creation failure, saga compensation (§4).
 *  - `PAID -> ACCEPTED`: pharmacy accepts (org-scoped reviewer check lives in the application
 *    layer, not here — this policy only knows the status shape, never who is allowed to act).
 *  - `PAID -> CANCELLED` / `ACCEPTED -> CANCELLED`: pharmacy declines/timeout and re-match
 *    exhausts all candidates (BRULE-19), or customer cancellation (§3.5/§6 `CancellationPolicy`
 *    decides *whether* a cancel is allowed; this policy only enforces that the resulting
 *    transition itself is legal once permitted).
 *  - `ACCEPTED -> READY`: every fulfillment reaches `READY` (§3.4's `PREPARING` intermediate step
 *    lives on `Fulfillment.status`, not `Order.status` — see `FulfillmentStatusPolicy`, never
 *    collapsed into this state machine).
 * `READY` is Slice 1's reachable ceiling (§3.4) — no outgoing transition exists from it here,
 * even though `DISPATCHED`/`DELIVERED`/`COMPLETED` exist in the schema (deferred to Module 08,
 * §0.2). `CANCELLED`/`REFUNDED` are terminal — `REFUNDED` has no *incoming* Slice-1 transition
 * either (no Module 07 to ever produce a refund), included in the schema only, never reachable.
 */
const LEGAL_TRANSITIONS: Record<OrderStatus, ReadonlySet<OrderStatus>> = {
  [OrderStatus.DRAFT]: new Set([OrderStatus.PENDING_PAYMENT]),
  [OrderStatus.PENDING_PAYMENT]: new Set([OrderStatus.PAID, OrderStatus.CANCELLED]),
  [OrderStatus.PAID]: new Set([OrderStatus.ACCEPTED, OrderStatus.CANCELLED]),
  [OrderStatus.ACCEPTED]: new Set([OrderStatus.READY, OrderStatus.CANCELLED]),
  [OrderStatus.READY]: new Set(),
  [OrderStatus.DISPATCHED]: new Set(),
  [OrderStatus.DELIVERED]: new Set(),
  [OrderStatus.COMPLETED]: new Set(),
  [OrderStatus.CANCELLED]: new Set(),
  [OrderStatus.REFUNDED]: new Set(),
};

export const OrderStatusPolicy = {
  isLegalTransition(from: OrderStatus, to: OrderStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: OrderStatus, to: OrderStatus): void {
    if (!OrderStatusPolicy.isLegalTransition(from, to)) {
      throw OrdersErrors.invalidOrderStateTransition(from, to, 'order');
    }
  },

  /** Terminal in Slice 1's reachable graph — no legal outgoing transition exists. */
  isTerminal(status: OrderStatus): boolean {
    return LEGAL_TRANSITIONS[status]?.size === 0;
  },
};
