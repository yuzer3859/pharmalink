import {
  RoleCatalogueView,
  RoleChangeResult,
  UserRoleAssignmentView,
} from '../../../identity/application/ports/inbound/identity-admin.port';
import { UserRoleAssignmentResponse } from './user.response';

/** One catalogue role. `permissions` are the keys Module 01 already exposes to `rbac:read`. */
export interface RoleCatalogueResponse {
  id: string;
  key: string;
  name: string;
  scope: string;
  isSystem: boolean;
  description: string | null;
  permissions: string[];
}

export interface RoleChangeResponse {
  assignmentId: string;
  userId: string;
  roleKey: string;
  organizationId: string | null;
  roles: Array<{ roleKey: string; organizationId: string | null }>;
}

export function toRoleCatalogueResponse(role: RoleCatalogueView): RoleCatalogueResponse {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    scope: role.scope,
    isSystem: role.isSystem,
    description: role.description,
    permissions: [...role.permissions],
  };
}

export function toUserRoleAssignmentResponse(r: UserRoleAssignmentView): UserRoleAssignmentResponse {
  return {
    assignmentId: r.assignmentId,
    roleKey: r.roleKey,
    roleName: r.roleName,
    organizationId: r.organizationId,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The change plus the role set the account now holds, so the caller needs no second read. */
export function toRoleChangeResponse(change: RoleChangeResult): RoleChangeResponse {
  return {
    assignmentId: change.assignmentId,
    userId: change.userId,
    roleKey: change.roleKey,
    organizationId: change.organizationId,
    roles: change.rolesAfter.map((r) => ({ roleKey: r.roleKey, organizationId: r.organizationId })),
  };
}
