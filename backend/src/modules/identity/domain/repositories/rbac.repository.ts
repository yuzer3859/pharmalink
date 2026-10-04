export const RBAC_REPOSITORY = Symbol('RBAC_REPOSITORY');

export type RoleScope = 'PLATFORM' | 'ORG' | 'INDIVIDUAL';

export interface RoleRecord {
  id: string;
  key: string;
  name: string;
  scope: RoleScope;
  isSystem: boolean;
  description: string | null;
}

export interface PermissionRecord {
  id: string;
  key: string;
  resource: string;
  action: string;
  scope: string | null;
  description: string | null;
}

export interface RoleWithPermissions extends RoleRecord {
  permissionKeys: string[];
}

export interface UserRoleRecord {
  id: string;
  userId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  organizationId: string | null;
  assignedBy: string | null;
  createdAt: Date;
}

export interface NewUserRoleAssignment {
  userId: string;
  roleId: string;
  organizationId: string | null;
  assignedBy: string | null;
}

/**
 * RBAC administration port (module-01 §6, §11.7). Covers the role/permission catalog and
 * user↔role assignments — deliberately separate from IRoleAssignmentRepository, which only
 * serves the registration path's single idempotent "assign default role" need.
 */
export interface IRbacRepository {
  listRoles(): Promise<RoleWithPermissions[]>;
  findRoleById(roleId: string): Promise<RoleRecord | null>;
  findRoleByKey(roleKey: string): Promise<RoleRecord | null>;

  listPermissions(): Promise<PermissionRecord[]>;
  findPermissionsByKeys(keys: string[]): Promise<PermissionRecord[]>;
  /** Atomically replaces the role's permission set with exactly `permissionIds`. */
  replaceRolePermissions(roleId: string, permissionIds: string[]): Promise<void>;

  /** Everyone currently holding the role — the blast radius of a permission change. */
  listUserIdsWithRole(roleId: string): Promise<string[]>;

  listAssignmentsForUser(userId: string): Promise<UserRoleRecord[]>;
  findAssignmentById(assignmentId: string): Promise<UserRoleRecord | null>;
  findAssignment(
    userId: string,
    roleId: string,
    organizationId: string | null,
  ): Promise<UserRoleRecord | null>;
  createAssignment(data: NewUserRoleAssignment): Promise<UserRoleRecord>;
  deleteAssignment(assignmentId: string): Promise<void>;

  organizationExists(organizationId: string): Promise<boolean>;

  /** Invalidates outstanding access tokens for the given users (module-01 §8 permVersion). */
  bumpPermVersion(userIds: string[]): Promise<void>;
}
