import { DeliveryJobStatus } from '../enums';
import { DeliveryJobRecord } from './delivery-admin.repository';
import { requeuedJobState } from './delivery-requeue.repository';

export const DELIVERY_LEASE_RELEASE_REPOSITORY = Symbol('DELIVERY_LEASE_RELEASE_REPOSITORY');

/**
 * What an operator's lease release writes (module-16 Work 23): the same "back in the queue, due now"
 * state as a manual requeue (Work 21) — `PENDING`, `nextAttemptAt = now`, lease and completion
 * cleared — so a released job is exactly a job waiting for its next try. `attemptCount` and
 * `lastErrorCode` are kept; no attempt is recorded (a lapsed claim is not a provider attempt, as the
 * dispatcher's own release leaves none either). No new state.
 */
export const releasedLeaseJobState = (now: Date) => requeuedJobState(now);

export type LeaseReleaseOutcome =
  | { kind: 'RELEASED'; job: DeliveryJobRecord; previousLeaseExpiresAt: Date }
  | { kind: 'NOT_FOUND' }
  /** Not `PROCESSING`, or `PROCESSING` under a lease that has not lapsed; nothing was changed. */
  | { kind: 'NOT_RELEASABLE'; status: DeliveryJobStatus };

/**
 * Write port for the operator's lease release (module-16 Work 23) — separate from the read-only
 * `IDeliveryAdminRepository`, the health aggregates and the Work 21 requeue.
 */
export interface IDeliveryLeaseReleaseRepository {
  /**
   * `PROCESSING` with a lapsed lease → `releasedLeaseJobState(now)`, as one conditional UPDATE whose
   * predicate is the dispatcher's own lapsed-lease rule (`leaseExpiresAt <= now`) fenced on the
   * lease being released. Of a concurrent release, a dispatcher re-claim and a worker's settle,
   * exactly one changes the row; the others match nothing.
   */
  releaseLapsedLease(jobId: string, now: Date): Promise<LeaseReleaseOutcome>;
}
