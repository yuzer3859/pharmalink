import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  INotificationSuppressionAdminPort,
  NOTIFICATION_SUPPRESSION_ADMIN_PORT,
  SuppressionView,
} from '../../../notifications/application/ports/inbound/notification-suppression-admin.port';
import { AdminErrors } from '../../domain/errors';

export const ADMIN_NOTIFICATION_SUPPRESSION_REMOVED = 'ADMIN_NOTIFICATION_SUPPRESSION_REMOVED';

export interface RemoveSuppressionInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  suppressionId: string;
  ip: string | null;
}

/**
 * `DELETE /admin/notifications/suppressions/:id` (module-13 Work 19).
 *
 *     admin HTTP → PermissionsGuard(suppression:manage:any) → this command
 *       → INotificationSuppressionAdminPort.removeSuppression → Module 13 deletes the row
 *       → this module's audit entry
 *
 * After removal a **future** e-mail to that destination is attempted again; nothing already
 * decided changes — jobs closed `SUPPRESSED` stay so, recorded attempts and webhook receipts stay,
 * nothing is resent. An unknown or already-removed id is `404` and audits nothing (as an
 * address delete does). The audit context carries the row id, channel, previous reason and when it
 * was suppressed — never the destination, its hash or any provider detail.
 *
 * A send that had already passed its suppression check when the row was removed is unaffected
 * either way; a send that checks after the removal proceeds. No lock is taken: the check and the
 * removal are each a single statement, and the window is the length of one provider call.
 */
@Injectable()
export class RemoveSuppressionCommand {
  constructor(
    @Inject(NOTIFICATION_SUPPRESSION_ADMIN_PORT) private readonly suppressions: INotificationSuppressionAdminPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RemoveSuppressionInput): Promise<SuppressionView> {
    const removed = await this.suppressions.removeSuppression(input.suppressionId);
    if (!removed) throw AdminErrors.suppressionNotFound();

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_NOTIFICATION_SUPPRESSION_REMOVED,
      resourceType: 'NotificationSuppression',
      resourceId: removed.id,
      context: {
        suppressionId: removed.id,
        channel: removed.channel,
        previousReason: removed.reason,
        suppressedAt: removed.createdAt.toISOString(),
      },
      ip: input.ip,
    });
    return removed;
  }
}
