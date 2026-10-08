import { Inject, Injectable } from '@nestjs/common';
import { DELIVERY_QUEUE_POLICY } from '../../../domain/delivery-retry-policy';
import { DeliveryJobStatus } from '../../../domain/enums';
import { DELIVERY_HEALTH_REPOSITORY, IDeliveryHealthRepository } from '../../../domain/repositories/delivery-health.repository';

export const NOTIFICATION_DELIVERY_HEALTH_PORT = Symbol('NOTIFICATION_DELIVERY_HEALTH_PORT');

/**
 * The delivery queue's health at `generatedAt` (module-16 Work 22) — aggregates only: no job,
 * notification, recipient, provider or error detail. Every figure comes from one database snapshot.
 *
 *  - `queue`        jobs per Work 13 status; `total` is their sum
 *  - `backlog`      `PENDING` jobs — waiting for their first try, a retry, or a provider to be
 *                   configured (an unconfigured channel's jobs stay `PENDING`) — and the oldest's
 *                   `createdAt` and age
 *  - `processing`   `PROCESSING` jobs; `staleProcessingCount` those whose lease has lapsed
 *                   (`leaseExpiresAt <= generatedAt`, the dispatcher's own reclaim rule — such a job
 *                   is reclaimed on the next tick); the oldest claim's start, which is its
 *                   `leaseExpiresAt − leaseMs` (a claim sets `leaseExpiresAt = now + leaseMs`, and no
 *                   other column records it), and that claim's age
 *
 * Ages are whole seconds to `generatedAt`, never negative; `null` with no such job.
 */
export interface DeliveryQueueHealth {
  generatedAt: Date;
  queue: { total: number; pending: number; processing: number; completed: number; suppressed: number; exhausted: number };
  backlog: { pendingCount: number; oldestPendingCreatedAt: Date | null; oldestPendingAgeSeconds: number | null };
  processing: {
    processingCount: number;
    staleProcessingCount: number;
    oldestProcessingStartedAt: Date | null;
    oldestProcessingAgeSeconds: number | null;
  };
}

/**
 * Module 13's exported, read-only contract for the delivery queue's health (module-16 Work 22),
 * consumed in-process by Module 16. Separate from the Work 20 list/detail port and the Work 21
 * retry port. Observation only: nothing is claimed, released, requeued or sent.
 */
export interface INotificationDeliveryHealthPort {
  health(): Promise<DeliveryQueueHealth>;
}

const ageSeconds = (from: Date | null, to: Date) => (from ? Math.max(0, Math.floor((+to - +from) / 1000)) : null);

/** `INotificationDeliveryHealthPort` over Module 13's own aggregate repository. */
@Injectable()
export class NotificationDeliveryHealthPortAdapter implements INotificationDeliveryHealthPort {
  constructor(@Inject(DELIVERY_HEALTH_REPOSITORY) private readonly jobs: IDeliveryHealthRepository) {}

  async health(): Promise<DeliveryQueueHealth> {
    const generatedAt = new Date();
    const a = await this.jobs.aggregatesAt(generatedAt);
    const count = (s: DeliveryJobStatus) => a.byStatus.find((g) => g.status === s)?.count ?? 0;
    const queue = {
      total: a.byStatus.reduce((n, g) => n + g.count, 0),
      pending: count(DeliveryJobStatus.PENDING),
      processing: count(DeliveryJobStatus.PROCESSING),
      completed: count(DeliveryJobStatus.COMPLETED),
      suppressed: count(DeliveryJobStatus.SUPPRESSED),
      exhausted: count(DeliveryJobStatus.EXHAUSTED),
    };
    const oldestProcessingStartedAt = a.oldestProcessingLeaseExpiresAt
      ? new Date(+a.oldestProcessingLeaseExpiresAt - DELIVERY_QUEUE_POLICY.leaseMs)
      : null;
    return {
      generatedAt,
      queue,
      backlog: {
        pendingCount: queue.pending,
        oldestPendingCreatedAt: a.oldestPendingCreatedAt,
        oldestPendingAgeSeconds: ageSeconds(a.oldestPendingCreatedAt, generatedAt),
      },
      processing: {
        processingCount: queue.processing,
        staleProcessingCount: a.staleProcessingCount,
        oldestProcessingStartedAt,
        oldestProcessingAgeSeconds: ageSeconds(oldestProcessingStartedAt, generatedAt),
      },
    };
  }
}
