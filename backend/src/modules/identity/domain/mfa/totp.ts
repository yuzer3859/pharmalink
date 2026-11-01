import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Authenticator-app TOTP (RFC 6238, over HOTP RFC 4226) for administrator MFA (Work 66).
 *
 * Parameters are the ones every authenticator app supports by default: HMAC-SHA1, 30-second time
 * steps, six digits, a 160-bit random secret. The only cryptographic primitive is Node's HMAC; this
 * module adds the RFC's counter encoding and dynamic truncation, and is checked against the RFC 6238
 * Appendix B test vectors (`totp.spec.ts`). That keeps the implementation small and reviewable rather
 * than adding a dependency for ~40 lines.
 *
 * Clock skew: a code is accepted for the current step and one step either side (±30 seconds).
 * Replay: callers must persist the accepted step and refuse any step that is not newer (see
 * `IAdminMfaRepository.advanceTimeStep`).
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_SKEW_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, without padding (how authenticator apps expect a secret). */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Decodes RFC 4648 base32, ignoring case, spaces and padding. Throws on any other character. */
export function base32Decode(encoded: string): Buffer {
  const clean = encoded.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character.');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

export function timeStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The HOTP value for one counter (time step), zero-padded to `digits`. */
export function totpForStep(secret: Buffer, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The time step whose code matches, within the skew window, or `null`. Every candidate is compared
 * (in constant time) so timing doesn't reveal which step matched.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const current = timeStepAt(nowMs);
  const presented = Buffer.from(code);
  let matched: number | null = null;
  for (let step = current - TOTP_SKEW_STEPS; step <= current + TOTP_SKEW_STEPS; step += 1) {
    if (step < 0) continue;
    const expected = Buffer.from(totpForStep(secret, step));
    if (timingSafeEqual(expected, presented) && matched === null) {
      matched = step;
    }
  }
  return matched;
}

/**
 * The `otpauth://` provisioning URI (Key Uri Format) an authenticator app reads from a QR code or a
 * pasted link. It contains the secret, so it is returned only in the enrolment response and never
 * logged or put in a browser URL.
 */
export function buildOtpauthUri(params: { issuer: string; account: string; secretBase32: string }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
