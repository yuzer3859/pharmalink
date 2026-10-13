import { OrderBacklogSummary } from '../../../orders/application/ports/inbound/order-backlog-summary-read.port';

/** Aggregate counts and timestamps only — no order id, number, customer or amount. */
export interface OrderBacklogSummaryResponse {
  generatedAt: string;
  orders: {
    total: number;
    byStatus: Record<string, number>;
    nonTerminalCount: number;
    oldestNonTerminalPlacedAt: string | null;
    oldestNonTerminalAgeSeconds: number | null;
  };
  /** Work 42: READY orders split by whether a delivery-job reference is recorded — not a delivery status. */
  readyHandoff: {
    readyOrderCount: number;
    readyOrdersWithDeliveryJob: number;
    readyOrdersWithoutDeliveryJob: number;
  };
}

// Explicit allow-list, never a spread of the port object.
export function toOrderBacklogSummaryResponse(s: OrderBacklogSummary): OrderBacklogSummaryResponse {
  const o = s.orders;
  return {
    generatedAt: s.generatedAt.toISOString(),
    orders: {
      total: o.total,
      byStatus: Object.fromEntries(Object.entries(o.byStatus).map(([status, n]) => [status, n])),
      nonTerminalCount: o.nonTerminalCount,
      oldestNonTerminalPlacedAt: o.oldestNonTerminalPlacedAt ? o.oldestNonTerminalPlacedAt.toISOString() : null,
      oldestNonTerminalAgeSeconds: o.oldestNonTerminalAgeSeconds,
    },
    readyHandoff: {
      readyOrderCount: s.readyHandoff.readyOrderCount,
      readyOrdersWithDeliveryJob: s.readyHandoff.readyOrdersWithDeliveryJob,
      readyOrdersWithoutDeliveryJob: s.readyHandoff.readyOrdersWithoutDeliveryJob,
    },
  };
}
