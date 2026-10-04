import { OrdersErrors } from '../errors';
import { OrderStatus } from '../enums';

/** Cancellable while pre-`READY` (module-06 `06-orders-spec.md` §3.5) — BRULE-20's "before
 * dispatch" collapses to "before `READY`" given Slice 1's reachable-state ceiling (§3.4). No
 * time-window is enforced here beyond the status check — `orders.cancellationWindowMinutes` is
 * reserved for a Slice-2 time-boxed policy (§5), not built in this task. */
const CANCELLABLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.DRAFT,
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.ACCEPTED,
]);

/**
 * Cancellation eligibility (module-06 `06-orders-spec.md` §3.5, §6). This policy only decides
 * *whether* a cancellation is valid for the order's current status — it never releases the
 * Module 04 reservation, refunds anything, or touches `Fulfillment`/`OrderLine` rows; those
 * compensating actions belong to the application/saga layer (§6's own explicit boundary), not
 * this domain policy. No distinct customer-vs-pharmacy rule and no mandatory-reason requirement
 * are defined by §3.5/§6 for Slice 1 — not inferred here.
 */
export const CancellationPolicy = {
  canCancel(status: OrderStatus): boolean {
    return CANCELLABLE_STATUSES.has(status);
  },

  assertCanCancel(status: OrderStatus): void {
    if (!CancellationPolicy.canCancel(status)) {
      throw OrdersErrors.cancellationNotAllowed(status);
    }
  },
};
