import { createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC-SHA256 over the exact received bytes, hex-encoded — the scheme almost every payment
 * gateway uses for callback signatures, and the reason this lives here rather than in a
 * per-provider adapter: it is a standard construction, not a Telebirr/bank/card algorithm. A
 * gateway that signs differently supplies its own `IPaymentWebhookPort.verify`; this is the
 * shared default those adapters can reuse.
 */
export function computeHmacSignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of a received signature against the expected one.
 *
 * Constant-time matters: a byte-by-byte comparison that returns early leaks, through response
 * timing, how much of a guessed signature was correct — enough to forge one given patience. It
 * also returns `false` rather than throwing on a malformed or wrong-length input, so callers
 * cannot distinguish "badly formatted" from "wrong" and learn something from the difference.
 */
export function verifyHmacSignature(
  secret: string,
  rawBody: string,
  received: string | undefined | null,
): boolean {
  if (typeof received !== 'string' || received.length === 0) {
    return false;
  }
  const expected = computeHmacSignature(secret, rawBody);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received.trim(), 'utf8');
  // `timingSafeEqual` throws on differing lengths, which would itself be a timing/behaviour leak,
  // so an unequal length is answered with a plain false.
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}
