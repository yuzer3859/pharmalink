export const PERM_VERSION_STORE = Symbol('PERM_VERSION_STORE');

/**
 * Supplies the *current* `permVersion` for a user so the auth guard can reject access tokens
 * minted before an authorization change (module-01 §8 "Permission versioning"). Reads must be
 * cheap enough to run on every authenticated request — implementations cache aggressively and
 * rely on explicit invalidation when a role/permission changes.
 */
export interface IPermVersionStore {
  /** Current version, or null when the user no longer exists. */
  getCurrent(userId: string): Promise<number | null>;
  invalidate(userIds: string[]): void;
}
