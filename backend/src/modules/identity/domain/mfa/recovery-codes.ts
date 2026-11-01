import { createHash, randomBytes } from 'crypto';
import { base32Encode } from './totp';

/**
 * Administrator MFA recovery codes (Work 66).
 *
 * Ten codes, each 80 random bits written as 16 base32 characters in groups of four
 * (`ABCD-EFGH-IJKL-MNOP`). They are shown once and stored only as SHA-256 hashes: at 80 bits of
 * entropy a fast hash can't be brute-forced, so a slow password hash would add cost without adding
 * protection. Input is normalised (case, spaces, dashes) before hashing.
 */
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () =>
    base32Encode(randomBytes(RECOVERY_CODE_BYTES))
      .match(/.{4}/g)!
      .join('-'),
  );
}

/** Canonical form: upper case, no separators. `null` if it can't be a recovery code. */
export function normalizeRecoveryCode(raw: string): string | null {
  const clean = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{16}$/.test(clean) ? clean : null;
}

export function hashRecoveryCode(normalized: string): string {
  return createHash('sha256').update(`admin-mfa-recovery:${normalized}`).digest('hex');
}
