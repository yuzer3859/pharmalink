import { createHmac, timingSafeEqual } from 'crypto';

/** Svix's recommended tolerance between `svix-timestamp` and the receiver's clock. */
export const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface SvixDelivery {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  /** The exact received bytes, before any JSON parsing. */
  rawBody: Buffer | undefined;
}

/**
 * Svix webhook signature verification (module-13 Work 18) — the scheme Resend signs its webhooks
 * with, per Svix's documented manual verification:
 *
 *     signed  = `${svix-id}.${svix-timestamp}.${rawBody}`
 *     key     = base64-decode(secret without its `whsec_` prefix)
 *     expect  = base64(HMAC-SHA256(key, signed))
 *     header  = space-separated `v1,<base64>` entries; any one matching (constant-time) is valid
 *
 * and the timestamp must be within `SVIX_TIMESTAMP_TOLERANCE_SECONDS` of `now`. Returns `true`
 * only when everything holds; never throws and never reveals which check failed.
 */
export function verifySvixSignature(secret: string, d: SvixDelivery, now: Date = new Date()): boolean {
  try {
    if (!d.id || !d.timestamp || !d.signature || !d.rawBody) return false;
    if (!/^\d{1,12}$/.test(d.timestamp)) return false;
    if (Math.abs(Math.floor(now.getTime() / 1000) - Number(d.timestamp)) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) return false;

    const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
    if (key.length === 0) return false;
    const expected = createHmac('sha256', key)
      .update(`${d.id}.${d.timestamp}.`)
      .update(d.rawBody)
      .digest();

    for (const entry of d.signature.split(' ')) {
      const [version, value] = entry.split(',', 2);
      if (version !== 'v1' || !value) continue;
      const given = Buffer.from(value, 'base64');
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Signs like Svix — for tests and the e2e suite, which send properly signed requests. */
export function signSvix(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
}
