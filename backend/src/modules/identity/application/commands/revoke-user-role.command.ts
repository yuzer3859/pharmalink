import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';
import { PermissionChangeService } from '../services/permission-change.service';

export interface RevokeUserRoleInput {
  targetUserId: string;
  assignmentId: string;
  actorUserId: string;
  ip?: string | null;
}

/**
 * DELETE /admin/users/{id}/roles/{assignmentId} (module-01 §11.7). The assignment id is checked
 * against the path's user so a mistyped id can never revoke somebody else's role. Audited; bumps
 * the target's `permVersion`.
 */
@Injectable()
export class RevokeUserRoleCommand {
  constructor(
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RevokeUserRoleInput): Promise<void> {
    const assignment = await this.rbac.findAssignmentById(input.assignmentId);
    if (!assignment || assignment.userId !== input.targetUserId) {
      throw ApiException.notFound('Role assignment not found');
    }

    await this.rbac.deleteAssignment(assignment.id);
    await this.permissionChange.propagate([assignment.userId]);

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'rbac.user_role.revoked',
      resourceType: 'user',
      resourceId: assignment.userId,
      context: {
        roleKey: assignment.roleKey,
        organizationId: assignment.organizationId,
        assignmentId: assignment.id,
      },
      ip: input.ip ?? null,
    });
  }
}
