/** Fallback shown when a provider gives no usable reason, or gives one we refuse to repeat. */
export const DEFAULT_DECLINE_REASON = 'The payment was declined by the provider.';

/** `payments.failureReason` is free text; keep it short enough to be a reason, not a payload. */
export const MAX_FAILURE_REASON_LENGTH = 200;

/**
 * A 12-19 digit run, with optional single spaces or dashes between digits - the shape of a PAN.
 * Deliberately broad: this is a last-resort safety net, and over-masking a long numeric reference
 * inside an error string costs nothing, while under-masking a card number is a PCI incident.
 */
const PAN_LIKE = /\b(?:\d[ -]?){11,18}\d\b/g;

/** `cvv: 123`, `cvc=1234`, `security code 999` - a CVV should never appear, but if one does. */
const CVV_LIKE = /\b(?:cvv|cvc|cvv2|security\s*code)\b\s*[:=]?\s*\d{3,4}/gi;

/** Anything that looks like a credential a misbehaving adapter might echo back. */
const SECRET_LIKE =
  /\b(?:api[_-]?key|secret|password|authorization|bearer|token|private[_-]?key)\b\s*[:=]?\s*(?:bearer\s+)?\S+/gi;

/** Control characters have no place in a message that reaches a log or a JSON envelope. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const REDACTED = '[redacted]';

/**
 * Defence-in-depth sanitizer for a provider's decline reason (design section 13, "Never log card
 * data, tokens, or provider secrets"; BRULE-26).
 *
 * `IPaymentProviderPort` already requires adapters to return a sanitized, customer-safe reason.
 * This runs that value through a second, independent filter before it is persisted to
 * `payments.failureReason`, written to the audit log, published on `payment.failed`, or returned
 * to a client - because those are four places a single adapter bug would otherwise leak into, and
 * three of them are durable. An adapter defect must not become a stored card number.
 *
 * It is a *net*, not a parser: it masks PAN-shaped digit runs, CVV-shaped fragments and
 * credential-shaped key/value pairs, strips control characters, collapses whitespace, and
 * truncates. It makes no attempt to understand provider-specific formats, and it never widens
 * what is stored - a value it cannot make safe becomes {@link DEFAULT_DECLINE_REASON}.
 */
export function sanitizeProviderFailureReason(raw: unknown): string {
  if (typeof raw !== 'string') {
    return DEFAULT_DECLINE_REASON;
  }

  const masked = raw
    .replace(CVV_LIKE, REDACTED)
    .replace(SECRET_LIKE, REDACTED)
    .replace(PAN_LIKE, REDACTED)
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (masked.length === 0) {
    return DEFAULT_DECLINE_REASON;
  }
  return masked.length > MAX_FAILURE_REASON_LENGTH
    ? `${masked.slice(0, MAX_FAILURE_REASON_LENGTH - 1).trimEnd()}…`
    : masked;
}
