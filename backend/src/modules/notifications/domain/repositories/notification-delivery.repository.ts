import { DeliveryJobStatus, NotificationCategory, NotificationChannel, NotificationStatus } from '../enums';

export const NOTIFICATION_DELIVERY_REPOSITORY = Symbol('NOTIFICATION_DELIVERY_REPOSITORY');

/**
 * What the delivery pipeline reads of a stored notification: who it is for, what it says and its
 * category. Not the event payload, dedupe key or source event type.
 */
export interface DeliverableNotification {
  id: string;
  recipientUserId: string;
  category: NotificationCategory;
  /** The row's own channel — `IN_APP` for every notification Works 01–10 write. */
  channel: NotificationChannel;
  title: string;
  body: string;
}

/**
 * A delivery job this worker holds (Work 13). `leaseExpiresAt` is the fencing token: a completion
 * write only lands while the row still carries exactly this lease.
 */
export interface ClaimedDeliveryJob {
  id: string;
  notificationId: string;
  channel: NotificationChannel;
  attemptCount: number;
  leaseExpiresAt: Date;
}

/** One `delivery_attempts` row to append. */
export interface NewDeliveryAttempt {
  attemptNumber: number;
  status: NotificationStatus;
  provider: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
}

/** How a claimed job is left: its next state, and the attempt to record with it, if any. */
export interface DeliveryJobSettlement {
  status: DeliveryJobStatus.PENDING | DeliveryJobStatus.COMPLETED | DeliveryJobStatus.SUPPRESSED | DeliveryJobStatus.EXHAUSTED;
  attemptCount: number;
  /** For `PENDING`: when it becomes due again. */
  nextAttemptAt?: Date;
  lastErrorCode: string | null;
  completedAt: Date | null;
  attempt: NewDeliveryAttempt | null;
}

/**
 * Persistence port for external delivery (module-13 Works 12–13), over `notifications` (read
 * only), `notification_delivery_jobs` (claim / settle) and `delivery_attempts` (append only).
 * Internal: used by the dispatcher, never by a controller — which is why, unlike the inbox
 * repository, it may read a notification by id.
 */
export interface INotificationDeliveryRepository {
  findDeliverable(notificationId: string): Promise<DeliverableNotification | null>;
  /**
   * Ids of up to `limit` jobs on `channels` that are due at `now`: `PENDING` with
   * `nextAttemptAt <= now`, or `PROCESSING` whose lease has expired. Oldest due first.
   */
  findDueJobIds(now: Date, channels: readonly NotificationChannel[], limit: number): Promise<string[]>;
  /**
   * Atomically takes one job if it is still due — a single conditional UPDATE, so of two workers
   * racing for it exactly one gets it. `null` when another worker won or it is no longer due.
   */
  claim(jobId: string, now: Date, leaseExpiresAt: Date): Promise<ClaimedDeliveryJob | null>;
  /**
   * Applies `settlement` and appends its attempt in one transaction, only while the job still
   * holds `job.leaseExpiresAt`. `false` (and nothing written) when the lease was lost.
   */
  settle(job: ClaimedDeliveryJob, settlement: DeliveryJobSettlement): Promise<boolean>;
}
