import { OrdersErrors } from '../errors';
import { FulfillmentStatus } from '../enums';

/**
 * Pure state machine for `Fulfillment.status` (module-06 `06-orders-spec.md` §3.6) — a
 * deliberately **separate** state machine from `OrderStatusPolicy` (§0's "distinguish Order
 * state from Fulfillment state" instruction): `PREPARING` is a `Fulfillment`-level concept only,
 * never a persisted `Order.status` value (§3.4's reconciliation). `Order.status` only advances
 * `ACCEPTED -> READY` once every `Fulfillment` (exactly one, in Slice 1's single-pharmacy world)
 * reaches `READY` — that cascade is an application-layer concern, not this policy's.
 *
 * Slice-1 reachable transitions:
 *  - `PENDING -> ACCEPTED`: pharmacy accepts.
 *  - `PENDING -> CANCELLED` / `ACCEPTED -> CANCELLED`: pharmacy declines/timeout (BRULE-19) —
 *    the "PAID/ACCEPTED | pharmacy declines/timeout" row in the parent `Order` narrative maps
 *    onto this `Fulfillment`-level transition, not a direct `Order.status` change.
 *  - `ACCEPTED -> PREPARING`: pharmacy begins prep.
 *  - `PREPARING -> READY`: stock dispensed (Module 04 `dispatch()` + Module 05 `dispense()`,
 *    application-layer orchestration, not this policy's concern).
 * `DISPATCHED`/`DELIVERED` remain schema-level, unreachable-in-Slice-1 values (deferred to
 * Module 08, §0.2) — explicitly given an empty transition set, never inferred.
 */
const LEGAL_TRANSITIONS: Record<FulfillmentStatus, ReadonlySet<FulfillmentStatus>> = {
  [FulfillmentStatus.PENDING]: new Set([FulfillmentStatus.ACCEPTED, FulfillmentStatus.CANCELLED]),
  [FulfillmentStatus.ACCEPTED]: new Set([
    FulfillmentStatus.PREPARING,
    FulfillmentStatus.CANCELLED,
  ]),
  [FulfillmentStatus.PREPARING]: new Set([FulfillmentStatus.READY]),
  [FulfillmentStatus.READY]: new Set(),
  [FulfillmentStatus.DISPATCHED]: new Set(),
  [FulfillmentStatus.DELIVERED]: new Set(),
  [FulfillmentStatus.CANCELLED]: new Set(),
};

export const FulfillmentStatusPolicy = {
  isLegalTransition(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: FulfillmentStatus, to: FulfillmentStatus): void {
    if (!FulfillmentStatusPolicy.isLegalTransition(from, to)) {
      throw OrdersErrors.invalidOrderStateTransition(from, to, 'fulfillment');
    }
  },

  isTerminal(status: FulfillmentStatus): boolean {
    return LEGAL_TRANSITIONS[status]?.size === 0;
  },
};
