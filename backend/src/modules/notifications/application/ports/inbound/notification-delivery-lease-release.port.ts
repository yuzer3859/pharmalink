import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../../shared/logging/app-logger.service';
import { DeliveryJobStatus } from '../../../domain/enums';
import {
  DELIVERY_LEASE_RELEASE_REPOSITORY,
  IDeliveryLeaseReleaseRepository,
} from '../../../domain/repositories/delivery-lease-release.repository';
import { DeliveryJobView } from './notification-delivery-admin.port';

export const NOTIFICATION_DELIVERY_LEASE_RELEASE_PORT = Symbol('NOTIFICATION_DELIVERY_LEASE_RELEASE_PORT');

export type DeliveryLeaseReleaseResult =
  /** The job is `PENDING` and due now; the scheduler will deliver it through the normal pipeline. */
  | { outcome: 'RELEASED'; previousStatus: DeliveryJobStatus.PROCESSING; previousLeaseExpiresAt: Date; job: DeliveryJobView }
  | { outcome: 'NOT_FOUND' }
  /** Not `PROCESSING` with a lapsed lease (or someone else changed it first); nothing was changed. */
  | { outcome: 'NOT_RELEASABLE'; status: DeliveryJobStatus };

/**
 * Module 13's exported contract for an operator's **release of a lapsed delivery lease** (module-16
 * Work 23), consumed in-process by Module 16. Mutation only; separate from the Work 20 read port,
 * the Work 21 retry port and the Work 22 health port.
 *
 * Only a `PROCESSING` job whose lease has lapsed — `leaseExpiresAt <= now`, the dispatcher's own
 * reclaim rule — is released: `PROCESSING → PENDING`, due now, lease cleared, same job,
 * `attemptCount` and `lastErrorCode` kept, no attempt recorded. Nothing is sent here: the scheduler
 * claims the job on its next tick as any other. The notification, preferences and history are
 * untouched. No HTTP, caller identity or audit: authorization and the admin audit are the caller's.
 */
export interface INotificationDeliveryLeaseReleasePort {
  releaseLapsedLease(jobId: string): Promise<DeliveryLeaseReleaseResult>;
}

/** `INotificationDeliveryLeaseReleasePort` over Module 13's own delivery adapter. */
@Injectable()
export class NotificationDeliveryLeaseReleasePortAdapter implements INotificationDeliveryLeaseReleasePort {
  constructor(
    @Inject(DELIVERY_LEASE_RELEASE_REPOSITORY) private readonly jobs: IDeliveryLeaseReleaseRepository,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(NotificationDeliveryLeaseReleasePortAdapter.name);
  }

  async releaseLapsedLease(jobId: string): Promise<DeliveryLeaseReleaseResult> {
    const result = await this.jobs.releaseLapsedLease(jobId, new Date());
    switch (result.kind) {
      case 'RELEASED':
        // The job id and channel only.
        this.logger.log(`delivery job ${result.job.id} (${result.job.channel}) released from a lapsed lease`);
        return { outcome: 'RELEASED', previousStatus: DeliveryJobStatus.PROCESSING, previousLeaseExpiresAt: result.previousLeaseExpiresAt, job: result.job };
      case 'NOT_FOUND':
        return { outcome: 'NOT_FOUND' };
      case 'NOT_RELEASABLE':
        return { outcome: 'NOT_RELEASABLE', status: result.status };
    }
  }
}
