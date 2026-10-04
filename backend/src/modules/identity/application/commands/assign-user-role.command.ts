import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { PermissionChangeService } from '../services/permission-change.service';

export interface AssignUserRoleInput {
  targetUserId: string;
  roleKey: string;
  /** Required for ORG-scoped roles, rejected for PLATFORM/INDIVIDUAL ones. */
  organizationId?: string | null;
  actorUserId: string;
  ip?: string | null;
}

export interface AssignUserRoleResult {
  assignmentId: string;
  userId: string;
  roleKey: string;
  organizationId: string | null;
}

/**
 * POST /admin/users/{id}/roles (module-01 §11.7, BRULE-02). Enforces the role-scope contract
 * from §5: ORG roles must name the tenant they apply to, platform/individual roles must not.
 * Audited; bumps the target's `permVersion` so their authorization changes take effect.
 */
@Injectable()
export class AssignUserRoleCommand {
  constructor(
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: AssignUserRoleInput): Promise<AssignUserRoleResult> {
    const user = await this.users.findById(input.targetUserId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }

    const role = await this.rbac.findRoleByKey(input.roleKey);
    if (!role) {
      throw ApiException.notFound('Role not found');
    }

    const organizationId = input.organizationId ?? null;
    if (role.scope === 'ORG') {
      if (!organizationId) {
        throw ApiException.validation('organizationId is required for an ORG-scoped role', {
          roleKey: role.key,
        });
      }
      if (!(await this.rbac.organizationExists(organizationId))) {
        throw ApiException.notFound('Organization not found');
      }
    } else if (organizationId) {
      throw ApiException.validation('organizationId is not allowed for a non-ORG role', {
        roleKey: role.key,
        scope: role.scope,
      });
    }

    const existing = await this.rbac.findAssignment(user.id, role.id, organizationId);
    if (existing) {
      throw ApiException.conflict('This role is already assigned to the user');
    }

    const assignment = await this.rbac.createAssignment({
      userId: user.id,
      roleId: role.id,
      organizationId,
      assignedBy: input.actorUserId,
    });

    await this.permissionChange.propagate([user.id]);

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'rbac.user_role.assigned',
      resourceType: 'user',
      resourceId: user.id,
      context: { roleKey: role.key, organizationId, assignmentId: assignment.id },
      ip: input.ip ?? null,
    });

    return {
      assignmentId: assignment.id,
      userId: user.id,
      roleKey: role.key,
      organizationId,
    };
  }
}
