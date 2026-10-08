import { DeliveryJobStatus } from '../enums';
import { DeliveryJobRecord } from './delivery-admin.repository';

export const DELIVERY_REQUEUE_REPOSITORY = Symbol('DELIVERY_REQUEUE_REPOSITORY');

/**
 * The one status an operator may send back to the queue (module-16 Work 21). `COMPLETED` and
 * `SUPPRESSED` are decisions, not failures; `PENDING` and `PROCESSING` are already in the queue.
 */
export const MANUALLY_REQUEUEABLE_STATUS = DeliveryJobStatus.EXHAUSTED;

/**
 * What a manual requeue writes: `PENDING`, due at `now`, no lease, no completion. `attemptCount`
 * and `lastErrorCode` are kept — the job stays the authority for attempt numbers, so the next
 * attempt is `attemptCount + 1` (never a repeated number) and, `retryDelayAfter` being `null` past
 * the fifth failure, a requeued job gets exactly one more provider attempt before it is
 * `EXHAUSTED` again. Requeueing is not a fresh retry budget.
 */
export function requeuedJobState(now: Date) {
  return { status: DeliveryJobStatus.PENDING, nextAttemptAt: now, leaseExpiresAt: null, completedAt: null } as const;
}

export type RequeueOutcome =
  | { kind: 'REQUEUED'; job: DeliveryJobRecord }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_REQUEUEABLE'; status: DeliveryJobStatus };

/**
 * Write port for the operator's manual requeue (module-16 Work 21) — separate from the read-only
 * `IDeliveryAdminRepository`. One method, one conditional transition.
 */
export interface IDeliveryRequeueRepository {
  /**
   * `EXHAUSTED → requeuedJobState(now)` as a single conditional update on the job's current status,
   * so of two concurrent callers exactly one gets `REQUEUED`; the other sees the job no longer
   * `EXHAUSTED` and changes nothing.
   */
  requeueExhausted(jobId: string, now: Date): Promise<RequeueOutcome>;
}
