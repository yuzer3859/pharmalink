import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { DeliveryJobView } from '../../../notifications/application/ports/inbound/notification-delivery-admin.port';
import {
  INotificationDeliveryRetryPort,
  NOTIFICATION_DELIVERY_RETRY_PORT,
} from '../../../notifications/application/ports/inbound/notification-delivery-retry.port';
import { AdminErrors } from '../../domain/errors';

export const ADMIN_NOTIFICATION_DELIVERY_RETRIED = 'ADMIN_NOTIFICATION_DELIVERY_RETRIED';

export interface RetryDeliveryJobInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  jobId: string;
  ip: string | null;
}

/**
 * `POST /admin/notifications/delivery/:id/retry` (module-16 Work 21).
 *
 *     admin HTTP → PermissionsGuard(notification:queue:manage) → this command
 *       → INotificationDeliveryRetryPort.retryExhaustedJob → Module 13: EXHAUSTED → PENDING
 *       → this module's audit entry
 *
 * The transition, and the rule that only `EXHAUSTED` may make it, are Module 13's; this command
 * maps the outcome. Unknown id → `404`; any other status → `409` — in both cases nothing changed
 * and nothing is audited. Of two concurrent retries only one gets `REQUEUED`, so only one is
 * audited; the other is a `409`. Nothing is sent from here: the scheduler delivers the job.
 *
 * The audit context is operational only — job id, channel, the transition and the job's attempt
 * count and last error code (a pipeline-controlled code, never provider text). Never the
 * notification, its recipient, a destination, a provider id or `errorDetail`.
 */
@Injectable()
export class RetryDeliveryJobCommand {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_RETRY_PORT) private readonly retries: INotificationDeliveryRetryPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RetryDeliveryJobInput): Promise<DeliveryJobView> {
    const result = await this.retries.retryExhaustedJob(input.jobId);
    if (result.outcome === 'NOT_FOUND') throw AdminErrors.deliveryJobNotFound();
    if (result.outcome === 'NOT_RETRYABLE') throw AdminErrors.deliveryJobNotRetryable(result.status);

    const job = result.job;
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_NOTIFICATION_DELIVERY_RETRIED,
      resourceType: 'NotificationDeliveryJob',
      resourceId: job.id,
      context: {
        deliveryJobId: job.id,
        channel: job.channel,
        previousStatus: result.previousStatus,
        newStatus: job.status,
        attemptCount: job.attemptCount,
        lastErrorCode: job.lastErrorCode,
      },
      ip: input.ip,
    });
    return job;
  }
}
