import { DeliveryJobStatus } from '../enums';

export const DELIVERY_HEALTH_REPOSITORY = Symbol('DELIVERY_HEALTH_REPOSITORY');

/** The queue's aggregates at one instant — counts and two timestamps, nothing per job. */
export interface DeliveryHealthAggregates {
  byStatus: Array<{ status: DeliveryJobStatus; count: number }>;
  /** `MIN(createdAt)` over `PENDING` jobs. */
  oldestPendingCreatedAt: Date | null;
  /** `PROCESSING` jobs whose lease had lapsed at `now` — the dispatcher's own reclaim rule. */
  staleProcessingCount: number;
  /** `MIN(leaseExpiresAt)` over `PROCESSING` jobs (the oldest claim's lease). */
  oldestProcessingLeaseExpiresAt: Date | null;
}

/**
 * Read-only aggregate port over `notification_delivery_jobs` for the queue health snapshot
 * (module-16 Work 22) — separate from the Work 20 list/detail repository and the Work 21 requeue.
 * Aggregated by the database, read in one snapshot.
 */
export interface IDeliveryHealthRepository {
  aggregatesAt(now: Date): Promise<DeliveryHealthAggregates>;
}
