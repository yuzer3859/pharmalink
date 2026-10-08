import { DeliveryJobStatus, NotificationChannel } from '../enums';

export const DELIVERY_CHANNEL_HEALTH_REPOSITORY = Symbol('DELIVERY_CHANNEL_HEALTH_REPOSITORY');

/**
 * The queue's per-channel aggregates at one instant (module-16 Work 24) — the Work 22 figures, grouped
 * by channel. A channel with no jobs simply has no entry.
 */
export interface DeliveryChannelAggregates {
  byChannelAndStatus: Array<{ channel: NotificationChannel; status: DeliveryJobStatus; count: number }>;
  /** `MIN(createdAt)` over `PENDING` jobs, per channel. */
  oldestPendingCreatedAt: Array<{ channel: NotificationChannel; at: Date | null }>;
  /** `PROCESSING` jobs whose lease had lapsed at `now` (the shared lapsed-lease rule), per channel. */
  staleProcessing: Array<{ channel: NotificationChannel; count: number }>;
  /** `MIN(leaseExpiresAt)` over `PROCESSING` jobs, per channel. */
  oldestProcessingLeaseExpiresAt: Array<{ channel: NotificationChannel; at: Date | null }>;
}

/**
 * Read-only per-channel aggregate port over `notification_delivery_jobs` (module-16 Work 24) —
 * separate from the Work 20 list/detail repository, the Work 22 whole-queue aggregates and every
 * mutation. Grouped by the database, read in one snapshot.
 */
export interface IDeliveryChannelHealthRepository {
  channelAggregatesAt(now: Date): Promise<DeliveryChannelAggregates>;
}
