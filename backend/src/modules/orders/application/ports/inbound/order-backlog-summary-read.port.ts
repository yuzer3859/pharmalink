import { OrderStatus } from '../../../domain/enums';

export const ORDER_BACKLOG_SUMMARY_READ_PORT = Symbol('ORDER_BACKLOG_SUMMARY_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 06's domain layer. */
export { OrderStatus } from '../../../domain/enums';

/**
 * Counts and timestamps over every order (`orders` has no soft delete), from one SQL statement —
 * one snapshot, `generatedAt` from the same clock. No amounts.
 *
 * - `byStatus` — the stored `OrderStatus`, every value in declaration order, zero-filled.
 * - `nonTerminalCount` — orders whose status is not terminal by `OrderStatusPolicy.isTerminal`:
 *   a status with a legal outgoing transition in Module 06's current graph. Today that is DRAFT,
 *   PENDING_PAYMENT, PAID and ACCEPTED. READY is Slice 1's reachable ceiling — nothing in Module 06
 *   moves an order past it yet — so READY, DISPATCHED, DELIVERED and COMPLETED are terminal there,
 *   with CANCELLED and REFUNDED. The set follows the policy if the graph grows.
 * - `oldestNonTerminalPlacedAt` / `oldestNonTerminalAgeSeconds` — the earliest `placedAt` (set when
 *   checkout submits the order) among non-terminal orders that have one, and whole seconds from it
 *   to `generatedAt` (floored, never negative). Both `null` when no non-terminal order has a
 *   `placedAt` — a DRAFT, which checkout never writes, would have none.
 *
 * `readyHandoff` (module-16 Work 42) is separate and changes none of the above: READY stays terminal
 * in `nonTerminalCount` and visible in `byStatus.READY`. Over orders whose stored status is exactly
 * READY, it splits them by whether **any** of their fulfillments records a delivery-job reference
 * (`fulfillments.deliveryJobId`, written from Module 08's `delivery.job.created` by Work 42A):
 *
 * - `readyOrderCount` — READY orders.
 * - `readyOrdersWithDeliveryJob` — READY orders with at least one fulfillment naming a job.
 * - `readyOrdersWithoutDeliveryJob` — READY orders with none (including orders with no fulfillment).
 *
 * Counted per order through `EXISTS`, so several fulfillments never count an order twice, and
 * `with + without = readyOrderCount` by construction. A reference says only that a job was cut — not
 * that it is assigned, picked up, en route or delivered; that is Module 08's to say.
 */
export interface OrderBacklogSummary {
  generatedAt: Date;
  orders: {
    total: number;
    byStatus: Record<OrderStatus, number>;
    nonTerminalCount: number;
    oldestNonTerminalPlacedAt: Date | null;
    oldestNonTerminalAgeSeconds: number | null;
  };
  readyHandoff: {
    readyOrderCount: number;
    readyOrdersWithDeliveryJob: number;
    readyOrdersWithoutDeliveryJob: number;
  };
}

/**
 * Module 06's exported contract for the **read-only order backlog summary**, consumed in-process by
 * Module 16 (module-16 Work 41). One aggregate, nothing per order. It writes nothing.
 */
export interface IOrderBacklogSummaryReadPort {
  summarizeBacklog(): Promise<OrderBacklogSummary>;
}
