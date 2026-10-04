import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  RoleChangeResult,
} from '../../../identity/application/ports/inbound/identity-admin.port';

export const ADMIN_ROLE_REVOKED = 'ADMIN_ROLE_REVOKED';

export interface RevokeRoleInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  targetUserId: string;
  /** The assignment, not the role: one role can be held under several organizations. */
  assignmentId: string;
  ip: string | null;
}

/**
 * `DELETE /admin/accounts/:id/roles/:assignmentId` (module-16 §9.2, F-AD-07). The mirror of
 * `AssignRoleCommand`: permission → port → Module 01's `RevokeUserRoleCommand` → this module's
 * audit entry. Module 01 checks that the assignment belongs to the named user; an id that does
 * not is `NOT_FOUND`, never somebody else's revocation.
 */
@Injectable()
export class RevokeRoleCommand {
  constructor(
    @Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RevokeRoleInput): Promise<RoleChangeResult> {
    const change = await this.identity.revokeRole({
      targetUserId: input.targetUserId,
      assignmentId: input.assignmentId,
      actorUserId: input.actorUserId,
      ip: input.ip,
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_ROLE_REVOKED,
      resourceType: 'user',
      resourceId: change.userId,
      context: {
        targetUserId: change.userId,
        roleKey: change.roleKey,
        organizationId: change.organizationId,
        assignmentId: change.assignmentId,
        rolesBefore: change.rolesBefore,
        rolesAfter: change.rolesAfter,
      },
      ip: input.ip,
    });

    return change;
  }
}
