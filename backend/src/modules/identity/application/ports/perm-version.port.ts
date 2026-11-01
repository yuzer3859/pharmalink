export const PERM_VERSION_STORE = Symbol('PERM_VERSION_STORE');

/**
 * Supplies the *current* `permVersion` for a user so the auth guard can reject access tokens
 * minted before an authorization change (module-01 §8 "Permission versioning"). Reads must be
 * cheap enough to run on every authenticated request — implementations cache aggressively and
 * rely on explicit invalidation when a role/permission changes.
 */
export interface AuthState {
  permVersion: number;
  /**
   * The account is a platform administrator (Work 66), so only an access token carrying MFA
   * assurance (`mfa: true`) may authenticate it.
   */
  mfaRequired: boolean;
}

export interface IPermVersionStore {
  /** Current version, or null when the user no longer exists. */
  getCurrent(userId: string): Promise<number | null>;
  /** Current version and whether MFA is mandatory, or null when the user no longer exists. */
  getAuthState(userId: string): Promise<AuthState | null>;
  invalidate(userIds: string[]): void;
}
