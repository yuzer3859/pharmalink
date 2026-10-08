import { DELIVERY_QUEUE_POLICY } from './delivery-retry-policy';

/**
 * Queue-health arithmetic shared by the whole-queue snapshot (module-16 Work 22) and the
 * per-channel breakdown (Work 24), so the two never disagree.
 */

/** Whole seconds from `from` to `to`, never negative; `null` with no `from`. */
export const ageSeconds = (from: Date | null, to: Date): number | null =>
  from ? Math.max(0, Math.floor((+to - +from) / 1000)) : null;

/**
 * When a `PROCESSING` job was claimed: its `leaseExpiresAt − leaseMs`. A claim writes
 * `leaseExpiresAt = now + leaseMs` and no other column records the claim time.
 */
export const claimStartedAt = (leaseExpiresAt: Date | null): Date | null =>
  leaseExpiresAt ? new Date(+leaseExpiresAt - DELIVERY_QUEUE_POLICY.leaseMs) : null;
