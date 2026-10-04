export const ROLE_ASSIGNMENT_REPOSITORY = Symbol('ROLE_ASSIGNMENT_REPOSITORY');

/**
 * Bridges a freshly created User to the RBAC catalog (module-01 §6, §10). Kept separate from
 * IUserRepository because it operates on the Role/UserRole tables, not the User aggregate.
 */
export interface IRoleAssignmentRepository {
  /** Idempotently assigns the platform-scoped role identified by `roleKey` (e.g. "CUSTOMER"). */
  assignByRoleKey(
    userId: string,
    roleKey: string,
    organizationId: string | null,
    tx?: unknown,
  ): Promise<void>;
}
