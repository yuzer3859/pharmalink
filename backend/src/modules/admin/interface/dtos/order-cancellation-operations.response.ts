import {
  CancellationOperationsPage,
  CancellationOperationsView,
} from '../../../orders/application/ports/inbound/order-cancellation-operations-read.port';

export interface OrderCancellationOperationsItemResponse {
  requestId: string;
  orderId: string;
  state: string;
  phase: string;
  attempts: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  nextAttemptAt: string;
  attentionRequiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderCancellationOperationsListResponse {
  generatedAt: string;
  counts: { pending: number; attention: number };
  items: OrderCancellationOperationsItemResponse[];
  total: number;
  page: number;
  size: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-lists, never spreads of port objects: no customer id, reason or lease.
export function toOrderCancellationOperationsItemResponse(v: CancellationOperationsView): OrderCancellationOperationsItemResponse {
  return {
    requestId: v.requestId,
    orderId: v.orderId,
    state: v.state,
    phase: v.phase,
    attempts: v.attempts,
    lastErrorCode: v.lastErrorCode,
    lastErrorAt: iso(v.lastErrorAt),
    nextAttemptAt: v.nextAttemptAt.toISOString(),
    attentionRequiredAt: iso(v.attentionRequiredAt),
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export function toOrderCancellationOperationsListResponse(p: CancellationOperationsPage): OrderCancellationOperationsListResponse {
  return {
    generatedAt: p.generatedAt.toISOString(),
    counts: { pending: p.counts.pending, attention: p.counts.attention },
    items: p.items.map(toOrderCancellationOperationsItemResponse),
    total: p.total,
    page: p.page,
    size: p.size,
  };
}
