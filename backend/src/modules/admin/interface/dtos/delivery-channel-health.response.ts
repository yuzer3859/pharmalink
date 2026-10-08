import { DeliveryChannelHealthSnapshot } from '../../../notifications/application/ports/inbound/notification-delivery-channel-health.port';

/** One channel: readiness as a boolean, aggregate counts, two timestamps and their ages. */
export interface DeliveryChannelHealthResponse {
  channel: string;
  providerConfigured: boolean;
  jobs: { total: number; pending: number; processing: number; completed: number; suppressed: number; exhausted: number };
  backlog: { pendingCount: number; oldestPendingCreatedAt: string | null; oldestPendingAgeSeconds: number | null };
  processing: {
    processingCount: number;
    staleProcessingCount: number;
    oldestProcessingStartedAt: string | null;
    oldestProcessingAgeSeconds: number | null;
  };
}

export interface DeliveryChannelHealthSnapshotResponse {
  generatedAt: string;
  channels: DeliveryChannelHealthResponse[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-list, never a spread.
export function toDeliveryChannelHealthResponse(s: DeliveryChannelHealthSnapshot): DeliveryChannelHealthSnapshotResponse {
  return {
    generatedAt: s.generatedAt.toISOString(),
    channels: s.channels.map((c) => ({
      channel: c.channel,
      providerConfigured: c.providerConfigured,
      jobs: {
        total: c.jobs.total,
        pending: c.jobs.pending,
        processing: c.jobs.processing,
        completed: c.jobs.completed,
        suppressed: c.jobs.suppressed,
        exhausted: c.jobs.exhausted,
      },
      backlog: {
        pendingCount: c.backlog.pendingCount,
        oldestPendingCreatedAt: iso(c.backlog.oldestPendingCreatedAt),
        oldestPendingAgeSeconds: c.backlog.oldestPendingAgeSeconds,
      },
      processing: {
        processingCount: c.processing.processingCount,
        staleProcessingCount: c.processing.staleProcessingCount,
        oldestProcessingStartedAt: iso(c.processing.oldestProcessingStartedAt),
        oldestProcessingAgeSeconds: c.processing.oldestProcessingAgeSeconds,
      },
    })),
  };
}
