import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  RoleChangeResult,
} from '../../../identity/application/ports/inbound/identity-admin.port';

export const ADMIN_ROLE_ASSIGNED = 'ADMIN_ROLE_ASSIGNED';

export interface AssignRoleInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  targetUserId: string;
  roleKey: string;
  /** Required by Module 01 for an ORG-scoped role, refused by it for any other. */
  organizationId: string | null;
  ip: string | null;
}

/**
 * `POST /admin/accounts/:id/roles` (module-16 §9.2, F-AD-07).
 *
 *     admin HTTP → PermissionsGuard(rbac:manage) → this command
 *       → IIdentityAdminPort.assignRole → Module 01 AssignUserRoleCommand
 *           (user and role exist, role-scope contract, duplicate refusal, permVersion bump,
 *            rbac.user_role.assigned audit)
 *       → this module's audit entry, with the role set before and after
 *
 * No rule about which role may go to whom lives here, because none lives in Module 01 either —
 * the only gate on granting a role, any role, is holding `rbac:manage`, and that is `SUPER_ADMIN`
 * alone. Adding a narrower policy in this module would be a second RBAC rule set that Module
 * 01's own route does not apply; the limitation is documented on the controller and reported,
 * not papered over.
 */
@Injectable()
export class AssignRoleCommand {
  constructor(
    @Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: AssignRoleInput): Promise<RoleChangeResult> {
    const change = await this.identity.assignRole({
      targetUserId: input.targetUserId,
      roleKey: input.roleKey,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      ip: input.ip,
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_ROLE_ASSIGNED,
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
