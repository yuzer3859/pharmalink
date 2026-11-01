export const PLATFORM_BOOTSTRAP_REPOSITORY = Symbol('PLATFORM_BOOTSTRAP_REPOSITORY');

/** The fixed key of the single `platform_bootstrap` row (a CHECK constraint allows no other). */
export const FIRST_SUPER_ADMIN_BOOTSTRAP_KEY = 'FIRST_SUPER_ADMIN';

export interface BootstrapInspection {
  /** The one-time marker already exists: the bootstrap was consumed. */
  completed: boolean;
  /** Any user has primaryRole SUPER_ADMIN, or any SUPER_ADMIN role assignment exists. */
  superAdminExists: boolean;
  /** The seeded SUPER_ADMIN role, or null when the RBAC seed has not been applied. */
  superAdminRole: { id: string; scope: string; hasWildcard: boolean } | null;
}

/**
 * Persistence for the one-time first-Super-Admin bootstrap (Work 65). Identity-owned: it reads and
 * writes `platform_bootstrap`, `roles`/`role_permissions` and `user_roles` only. The user itself is
 * created through `IUserRepository`.
 */
export interface IPlatformBootstrapRepository {
  inspect(tx?: unknown): Promise<BootstrapInspection>;
  /** Global (organizationId = null) SUPER_ADMIN assignment; `assignedBy` is null (operator CLI). */
  assignSuperAdminRole(userId: string, roleId: string, tx: unknown): Promise<{ assignmentId: string }>;
  /** Inserts the marker. Fails (unique/PK violation) if it already exists. */
  markCompleted(superAdminUserId: string, tx: unknown): Promise<void>;
}
