export const ADMIN_MFA_REPOSITORY = Symbol('ADMIN_MFA_REPOSITORY');

export type AdminMfaChallengePurpose = 'ENROLL' | 'VERIFY';

export interface AdminMfaCredentialRecord {
  userId: string;
  encryptedSecret: string;
  /** Highest accepted TOTP time step, or null before the first use. */
  lastUsedStep: number | null;
  enabledAt: Date;
}

export interface AdminMfaChallengeRecord {
  id: string;
  userId: string;
  purpose: AdminMfaChallengePurpose;
  replacesCredential: boolean;
  encryptedPendingSecret: string | null;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface NewAdminMfaChallenge {
  userId: string;
  tokenHash: string;
  purpose: AdminMfaChallengePurpose;
  replacesCredential: boolean;
  expiresAt: Date;
}

/**
 * Persistence for administrator MFA (Work 66). Every state change that guards against replay or
 * concurrent reuse is a single conditional update that reports whether it applied, so two racing
 * requests can never both succeed.
 */
export interface IAdminMfaRepository {
  /**
   * Whether the user is a platform administrator: primaryRole ADMIN/SUPER_ADMIN, or a global
   * assignment of the PLATFORM-scoped ADMIN/SUPER_ADMIN role. Throws if it can't be determined.
   */
  isPlatformAdministrator(userId: string, tx?: unknown): Promise<boolean>;

  findCredential(userId: string, tx?: unknown): Promise<AdminMfaCredentialRecord | null>;

  createChallenge(data: NewAdminMfaChallenge, tx?: unknown): Promise<AdminMfaChallengeRecord>;
  findChallengeByTokenHash(tokenHash: string): Promise<AdminMfaChallengeRecord | null>;
  /** Stores the pending secret on a still-usable ENROLL challenge. False if it is no longer usable. */
  setPendingSecret(challengeId: string, encryptedSecret: string, now: Date, maxAttempts: number): Promise<boolean>;
  /** Counts one failed attempt on a still-usable challenge. */
  registerFailedAttempt(challengeId: string, now: Date, maxAttempts: number): Promise<void>;
  /** Consumes a still-usable challenge (unconsumed, unexpired, under the attempt limit). */
  consumeChallenge(challengeId: string, now: Date, maxAttempts: number, tx?: unknown): Promise<boolean>;

  /** Records `step` as used if it is newer than every step accepted before. */
  advanceTimeStep(userId: string, step: number, tx?: unknown): Promise<boolean>;
  /** Creates the user's first credential. Fails (unique violation) if one already exists. */
  createCredential(userId: string, encryptedSecret: string, step: number, tx?: unknown): Promise<void>;
  /** Replaces an existing credential (authenticator replacement after a recovery code). */
  replaceCredential(userId: string, encryptedSecret: string, step: number, tx?: unknown): Promise<void>;

  /** Deletes the user's recovery codes and stores the new hashes. */
  replaceRecoveryCodes(userId: string, codeHashes: string[], tx?: unknown): Promise<void>;
  /** Marks one unused code used. False if it doesn't exist or was already used. */
  consumeRecoveryCode(userId: string, codeHash: string, now: Date, tx?: unknown): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;

  /** Whether the Work 66 migration has been applied to this database. */
  isSchemaReady(): Promise<boolean>;
}
