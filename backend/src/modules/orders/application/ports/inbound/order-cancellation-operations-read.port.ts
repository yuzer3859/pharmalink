export const ORDER_CANCELLATION_OPERATIONS_READ_PORT = Symbol('ORDER_CANCELLATION_OPERATIONS_READ_PORT');

/**
 * Module 06's read-only view of unfinished customer cancellations (Work 55), for Module 16's
 * operations surface. Open requests only: `PENDING` = still being retried automatically;
 * `ATTENTION` = stopped on a permanent failure (or exhausted retries) and waiting for an operator.
 * No customer id, no free-text reason, no lease internals — the order id, where the saga stopped,
 * and why (a structured error code).
 */
export type CancellationOperationsState = 'PENDING' | 'ATTENTION';

export interface CancellationOperationsView {
  requestId: string;
  orderId: string;
  state: CancellationOperationsState;
  /** `REQUESTED` (stock not yet released) | `STOCK_RELEASED` (order not yet cancelled) | `ORDER_CANCELLED` (coupon not yet reversed). */
  phase: string;
  attempts: number;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  nextAttemptAt: Date;
  attentionRequiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CancellationOperationsPage {
  generatedAt: Date;
  /** Counts over all open requests (not just this page), from the same snapshot. */
  counts: { pending: number; attention: number };
  items: CancellationOperationsView[];
  total: number;
  page: number;
  size: number;
}

export interface IOrderCancellationOperationsReadPort {
  /** Oldest first; `state` narrows to one class, omitted = both. */
  list(filter: { state?: CancellationOperationsState }, page: number, size: number): Promise<CancellationOperationsPage>;
}
