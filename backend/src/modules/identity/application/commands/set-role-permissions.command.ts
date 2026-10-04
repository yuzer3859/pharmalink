import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';
import { PermissionChangeService } from '../services/permission-change.service';

export interface SetRolePermissionsInput {
  roleId: string;
  /** The complete desired permission set for the role — replaces whatever is stored today. */
  permissionKeys: string[];
  actorUserId: string;
  ip?: string | null;
}

export interface SetRolePermissionsResult {
  roleId: string;
  roleKey: string;
  permissions: string[];
  affectedUsers: number;
}

/** Role whose grants may never be edited — removing them would lock the platform out of RBAC. */
const PROTECTED_ROLE_KEY = 'SUPER_ADMIN';

/**
 * POST /admin/rbac/roles/{id}/permissions (module-01 §11.7). Replace semantics: the request
 * carries the full desired set, which keeps the operation idempotent and avoids ambiguous
 * add/remove diffs. Audited, and bumps `permVersion` for every holder of the role.
 */
@Injectable()
export class SetRolePermissionsCommand {
  constructor(
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
    private readonly permissionChange: PermissionChangeService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: SetRolePermissionsInput): Promise<SetRolePermissionsResult> {
    const role = await this.rbac.findRoleById(input.roleId);
    if (!role) {
      throw ApiException.notFound('Role not found');
    }
    if (role.key === PROTECTED_ROLE_KEY) {
      throw ApiException.businessRule('The SUPER_ADMIN role grants cannot be modified.');
    }

    const requested = [...new Set(input.permissionKeys)];
    const permissions = await this.rbac.findPermissionsByKeys(requested);
    const found = new Set(permissions.map((p) => p.key));
    const unknown = requested.filter((key) => !found.has(key));
    if (unknown.length > 0) {
      throw ApiException.validation('Unknown permission keys', { unknown });
    }

    await this.rbac.replaceRolePermissions(
      role.id,
      permissions.map((p) => p.id),
    );

    const affected = await this.rbac.listUserIdsWithRole(role.id);
    await this.permissionChange.propagate(affected);

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'rbac.role_permissions.replaced',
      resourceType: 'role',
      resourceId: role.id,
      context: { roleKey: role.key, permissions: requested, affectedUsers: affected.length },
      ip: input.ip ?? null,
    });

    return {
      roleId: role.id,
      roleKey: role.key,
      permissions: requested.sort(),
      affectedUsers: affected.length,
    };
  }
}
