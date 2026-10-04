import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  AccountStatusChangeResult,
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
} from '../../../identity/application/ports/inbound/identity-admin.port';

export const ADMIN_USER_REINSTATED = 'ADMIN_USER_REINSTATED';

export interface ReinstateUserInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  targetUserId: string;
  /** Recorded in this module's audit entry only — Module 01's reactivation takes no reason. */
  reason: string | null;
  ip: string | null;
}

/**
 * `POST /admin/users/:id/reinstate` (module-16 §9.2, F-AD-06). The design's word is
 * "reinstate"; Module 01's is "reactivate", and the target state is Module 01's `ACTIVE` — no
 * "reinstated" status exists or is introduced. The mirror of `SuspendUserCommand`: permission →
 * port → Module 01's `ReactivateUserCommand` → this module's audit entry.
 *
 * Module 01 permits exactly `SUSPENDED → ACTIVE`. A `DEACTIVATED`, `DELETED`, `PENDING_*` or
 * already-`ACTIVE` account is refused by the aggregate with its own `BUSINESS_RULE_VIOLATION`,
 * which propagates unchanged and leaves no admin audit entry.
 */
@Injectable()
export class ReinstateUserCommand {
  constructor(
    @Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ReinstateUserInput): Promise<AccountStatusChangeResult> {
    const change = await this.identity.reactivateUser({
      targetUserId: input.targetUserId,
      actorUserId: input.actorUserId,
      ip: input.ip,
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_USER_REINSTATED,
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
