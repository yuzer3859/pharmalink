/**
 * The authenticated principal attached to the request by the auth layer (Module 01, built in
 * Phase 0). Phase-0 shared code only depends on this shape, not on Identity internals.
 */
export interface AuthenticatedPrincipal {
  userId: string;
  roles?: string[];
  permissions?: string[];
}

export const PERMISSION_RESOLVER = Symbol('PERMISSION_RESOLVER');

/**
 * Resolves the effective permission set for a user. Module 01 provides the real implementation
 * (roles → permissions), backed by the permission cache. If the request already carries a
 * permissions array (e.g. embedded in the access token), the guard can use it directly.
 */
export interface IPermissionResolver {
  resolvePermissions(userId: string): Promise<string[]>;
}
