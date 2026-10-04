import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  AccountStatusChangeResult,
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
} from '../../../identity/application/ports/inbound/identity-admin.port';

export const ADMIN_USER_SUSPENDED = 'ADMIN_USER_SUSPENDED';

export interface SuspendUserInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  targetUserId: string;
  /** Required by Module 01; carried on its `identity.account.suspended` event. */
  reason: string;
  ip: string | null;
}

/**
 * `POST /admin/users/:id/suspend` (module-16 §9.2, F-AD-06, BRULE-49).
 *
 *     admin HTTP → PermissionsGuard(user:suspend:any) → this command
 *       → IIdentityAdminPort.suspendUser → Module 01 SuspendUserCommand
 *           (self-suspension refusal, terminal-state rule, status write, session and refresh-
 *            token revocation, permVersion bump, identity.account.suspended, Module 01 audit)
 *       → this module's audit entry for the admin action
 *
 * Nothing about the account's lifecycle is decided here. Module 01's aggregate defines which
 * statuses may be suspended (`DELETED` and `DEACTIVATED` may not) and that suspending a
 * `SUSPENDED` account is an idempotent no-op; both come back through the port unchanged — a
 * refusal as Module 01's own error, a no-op as a result whose `previousStatus` equals `status`.
 * This module records what happened either way, and records nothing when Module 01 refused.
 *
 * The same pattern as Work 02: Module 01's `identity.account.suspended` is the domain fact, this
 * entry is the admin action.
 */
@Injectable()
export class SuspendUserCommand {
  constructor(
    @Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: SuspendUserInput): Promise<AccountStatusChangeResult> {
    const change = await this.identity.suspendUser({
      targetUserId: input.targetUserId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      ip: input.ip,
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_USER_SUSPENDED,
      resourceType: 'user',
      resourceId: change.userId,
      context: {
        targetUserId: change.userId,
        previousStatus: change.previousStatus,
        status: change.status,
        reason: input.reason,
        changedAt: change.changedAt.toISOString(),
      },
      ip: input.ip,
    });

    return change;
  }
}
