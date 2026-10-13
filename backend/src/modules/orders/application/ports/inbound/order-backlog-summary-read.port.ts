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
}

/**
 * Module 06's exported contract for the **read-only order backlog summary**, consumed in-process by
 * Module 16 (module-16 Work 41). One aggregate, nothing per order. It writes nothing.
 */
export interface IOrderBacklogSummaryReadPort {
  summarizeBacklog(): Promise<OrderBacklogSummary>;
}
