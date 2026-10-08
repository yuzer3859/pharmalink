import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { DeliveryJobView } from '../../../notifications/application/ports/inbound/notification-delivery-admin.port';
import {
  INotificationDeliveryLeaseReleasePort,
  NOTIFICATION_DELIVERY_LEASE_RELEASE_PORT,
} from '../../../notifications/application/ports/inbound/notification-delivery-lease-release.port';
import { AdminErrors } from '../../domain/errors';

export const ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED = 'ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED';

export interface ReleaseDeliveryLeaseInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  jobId: string;
  ip: string | null;
}

/**
 * `POST /admin/notifications/delivery/:id/release` (module-16 Work 23).
 *
 *     admin HTTP → PermissionsGuard(notification:queue:manage) → this command
 *       → INotificationDeliveryLeaseReleasePort.releaseLapsedLease
 *       → Module 13: PROCESSING (lease lapsed) → PENDING → this module's audit entry
 *
 * The rule (only `PROCESSING` whose lease has lapsed, by the dispatcher's own definition) and the
 * transition are Module 13's; this command maps the outcome. Unknown id → `404`; anything else —
 * `PENDING`, `COMPLETED`, `SUPPRESSED`, `EXHAUSTED` (Work 21's retry), or `PROCESSING` under a live
 * lease — `409`, nothing changed, nothing audited. Of concurrent releases, or a release racing the
 * dispatcher, one changes the row and only a successful release is audited.
 *
 * The audit context is operational only — job id, channel, the transition, the released lease's
 * expiry, attempt count and last error code (a pipeline code). Never the notification, recipient,
 * destination, content, provider id or `errorDetail`.
 */
@Injectable()
export class ReleaseDeliveryLeaseCommand {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_LEASE_RELEASE_PORT) private readonly leases: INotificationDeliveryLeaseReleasePort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ReleaseDeliveryLeaseInput): Promise<DeliveryJobView> {
    const result = await this.leases.releaseLapsedLease(input.jobId);
    if (result.outcome === 'NOT_FOUND') throw AdminErrors.deliveryJobNotFound();
    if (result.outcome === 'NOT_RELEASABLE') throw AdminErrors.deliveryLeaseNotReleasable(result.status);

    const job = result.job;
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED,
      resourceType: 'NotificationDeliveryJob',
      resourceId: job.id,
      context: {
        deliveryJobId: job.id,
        channel: job.channel,
        previousStatus: result.previousStatus,
        newStatus: job.status,
        previousLeaseExpiresAt: result.previousLeaseExpiresAt.toISOString(),
        leaseExpired: true,
        attemptCount: job.attemptCount,
        lastErrorCode: job.lastErrorCode,
      },
      ip: input.ip,
    });
    return job;
  }
}
