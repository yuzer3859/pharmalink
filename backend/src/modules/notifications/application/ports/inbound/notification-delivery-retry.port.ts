import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../shared/logging/app-logger.service';
import { DeliveryJobStatus } from '../../../domain/enums';
import { DELIVERY_REQUEUE_REPOSITORY, IDeliveryRequeueRepository } from '../../../domain/repositories/delivery-requeue.repository';
import { DeliveryJobView } from './notification-delivery-admin.port';

export const NOTIFICATION_DELIVERY_RETRY_PORT = Symbol('NOTIFICATION_DELIVERY_RETRY_PORT');

export type DeliveryRetryResult =
  /** The job is `PENDING` and due now; the scheduler will deliver it through the normal pipeline. */
  | { outcome: 'REQUEUED'; previousStatus: DeliveryJobStatus.EXHAUSTED; job: DeliveryJobView }
  | { outcome: 'NOT_FOUND' }
  /** The job is not `EXHAUSTED` (or another operator requeued it first); nothing was changed. */
  | { outcome: 'NOT_RETRYABLE'; status: DeliveryJobStatus };

/**
 * Module 13's exported contract for an operator's **manual retry** of a delivery job (module-16
 * Work 21), consumed in-process by Module 16. Mutation only, kept apart from the read-only
 * `INotificationDeliveryAdminPort`.
 *
 * Only an `EXHAUSTED` job is retried, and retrying means requeueing — `EXHAUSTED → PENDING`, due
 * now, same job (same notification and channel), `attemptCount` kept. Nothing is sent here: the
 * scheduler claims the job on its next tick and the dispatcher runs it exactly as any other — the
 * current preference, the suppression list and the provider all decide again. The notification,
 * its recipient and the attempt history are untouched. No HTTP, caller identity or audit:
 * authorization and the admin audit are the caller's.
 */
export interface INotificationDeliveryRetryPort {
  retryExhaustedJob(jobId: string): Promise<DeliveryRetryResult>;
}

/** `INotificationDeliveryRetryPort` over Module 13's own requeue repository. */
@Injectable()
export class NotificationDeliveryRetryPortAdapter implements INotificationDeliveryRetryPort {
  constructor(
    @Inject(DELIVERY_REQUEUE_REPOSITORY) private readonly jobs: IDeliveryRequeueRepository,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(NotificationDeliveryRetryPortAdapter.name);
  }

  async retryExhaustedJob(jobId: string): Promise<DeliveryRetryResult> {
    const result = await this.jobs.requeueExhausted(jobId, new Date());
    switch (result.kind) {
      case 'REQUEUED':
        // The job id and channel only.
        this.logger.log(`delivery job ${result.job.id} (${result.job.channel}) requeued from EXHAUSTED`);
        return { outcome: 'REQUEUED', previousStatus: DeliveryJobStatus.EXHAUSTED, job: result.job };
      case 'NOT_FOUND':
        return { outcome: 'NOT_FOUND' };
      case 'NOT_REQUEUEABLE':
        return { outcome: 'NOT_RETRYABLE', status: result.status };
    }
  }
}
