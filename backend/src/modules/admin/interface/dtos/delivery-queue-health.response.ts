import { DeliveryQueueHealth } from '../../../notifications/application/ports/inbound/notification-delivery-health.port';

/** The queue health snapshot — aggregate counts, two timestamps and their ages; nothing per job. */
export interface DeliveryQueueHealthResponse {
  generatedAt: string;
  queue: { total: number; pending: number; processing: number; completed: number; suppressed: number; exhausted: number };
  backlog: { pendingCount: number; oldestPendingCreatedAt: string | null; oldestPendingAgeSeconds: number | null };
  processing: {
    processingCount: number;
    staleProcessingCount: number;
    oldestProcessingStartedAt: string | null;
    oldestProcessingAgeSeconds: number | null;
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-list, never a spread.
export function toDeliveryQueueHealthResponse(h: DeliveryQueueHealth): DeliveryQueueHealthResponse {
  return {
    generatedAt: h.generatedAt.toISOString(),
    queue: {
      total: h.queue.total,
      pending: h.queue.pending,
      processing: h.queue.processing,
      completed: h.queue.completed,
      suppressed: h.queue.suppressed,
      exhausted: h.queue.exhausted,
    },
    backlog: {
      pendingCount: h.backlog.pendingCount,
      oldestPendingCreatedAt: iso(h.backlog.oldestPendingCreatedAt),
      oldestPendingAgeSeconds: h.backlog.oldestPendingAgeSeconds,
    },
    processing: {
      processingCount: h.processing.processingCount,
      staleProcessingCount: h.processing.staleProcessingCount,
      oldestProcessingStartedAt: iso(h.processing.oldestProcessingStartedAt),
      oldestProcessingAgeSeconds: h.processing.oldestProcessingAgeSeconds,
    },
  };
}
