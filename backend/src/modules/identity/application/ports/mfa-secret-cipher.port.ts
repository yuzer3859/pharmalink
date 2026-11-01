export const MFA_SECRET_CIPHER = Symbol('MFA_SECRET_CIPHER');

/**
 * Encrypts administrator TOTP secrets at rest (Work 66). Ciphertext is bound to the user id, so a
 * stored secret copied onto another account fails to decrypt.
 */
export interface IMfaSecretCipher {
  /** False when ADMIN_MFA_ENCRYPTION_KEY isn't configured (only possible outside production). */
  isConfigured(): boolean;
  /** Throws `DEPENDENCY_UNAVAILABLE` when not configured. */
  encrypt(secret: Buffer, userId: string): string;
  /** Throws `DEPENDENCY_UNAVAILABLE` when not configured; throws if the ciphertext was tampered with. */
  decrypt(ciphertext: string, userId: string): Buffer;
}
