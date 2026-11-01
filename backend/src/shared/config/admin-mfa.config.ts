/**
 * The key that encrypts administrator TOTP secrets at rest (Work 66).
 *
 * The server must read a TOTP secret back to verify later codes, so the secret can't be hashed: it
 * is encrypted with AES-256-GCM under this dedicated key. The key is 32 random bytes, written as
 * standard base64 (44 characters, ending in `=`):
 *
 *     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * - **Production:** required. A missing or malformed key stops the process at boot; there is no
 *   fallback key.
 * - **Elsewhere:** optional. Without it the server still starts, but administrator MFA can't be
 *   enrolled or verified, so administrators can't sign in (fail closed). The test harness generates
 *   a throwaway key per run.
 *
 * Administrator MFA itself has no switch: it is always enforced, in every environment.
 */
export const ADMIN_MFA_ENCRYPTION_KEY_ENV = 'ADMIN_MFA_ENCRYPTION_KEY';
export const ADMIN_MFA_KEY_BYTES = 32;

/** Exactly 32 bytes in standard, padded base64. */
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

export interface AdminMfaKeySettings {
  nodeEnv: string | undefined;
  key: unknown;
  /** Other secrets the MFA key must not reuse (JWT secrets, MASTER_ENCRYPTION_KEY). */
  otherSecrets?: unknown[];
}

function present(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Decodes and checks the key, or throws with an actionable message. The message never contains the
 * value.
 */
export function decodeAdminMfaKey(raw: unknown, otherSecrets: unknown[] = []): Buffer {
  const encoded = present(raw);
  if (encoded === undefined) {
    throw new Error(`${ADMIN_MFA_ENCRYPTION_KEY_ENV} must be set.`);
  }
  if (!BASE64_32_BYTES.test(encoded)) {
    throw new Error(
      `${ADMIN_MFA_ENCRYPTION_KEY_ENV} must be ${ADMIN_MFA_KEY_BYTES} random bytes in base64 (44 characters).`,
    );
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== ADMIN_MFA_KEY_BYTES) {
    throw new Error(`${ADMIN_MFA_ENCRYPTION_KEY_ENV} must decode to ${ADMIN_MFA_KEY_BYTES} bytes.`);
  }
  if (new Set(key).size < 16) {
    throw new Error(`${ADMIN_MFA_ENCRYPTION_KEY_ENV} looks like a placeholder; generate 32 random bytes.`);
  }
  if (otherSecrets.some((other) => present(other) === encoded)) {
    throw new Error(`${ADMIN_MFA_ENCRYPTION_KEY_ENV} must be a dedicated key, not a copy of another secret.`);
  }
  return key;
}

/**
 * The key to use, `null` when it is legitimately absent (outside production only), or throws. The
 * single source of the rule: `validateEnv` calls it at boot and `AppConfigService` again when the
 * cipher reads the key.
 */
export function resolveAdminMfaKey(settings: AdminMfaKeySettings): Buffer | null {
  const isProduction = settings.nodeEnv === 'production';
  if (present(settings.key) === undefined) {
    if (isProduction) {
      throw new Error(
        `${ADMIN_MFA_ENCRYPTION_KEY_ENV} must be set in production: administrator MFA is mandatory and its secrets are encrypted with it.`,
      );
    }
    return null;
  }
  return decodeAdminMfaKey(settings.key, settings.otherSecrets);
}
