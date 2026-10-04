import { Email } from './email';
import { PhoneNumber } from './phone-number';

export interface NormalizedIdentifier {
  /** Canonical stored form: E.164 phone or lowercased email. */
  value: string;
  channel: 'SMS' | 'EMAIL';
  /** Display-safe form for logs, audit context and notifications. */
  masked: string;
}

/**
 * Normalizes a login identifier (phone or email) to the canonical form used for storage and OTP
 * keys. Returns null instead of throwing: recovery flows must not reveal whether a value was
 * even well-formed, so callers decide between a generic response and a validation error.
 */
export function normalizeIdentifier(raw: string): NormalizedIdentifier | null {
  if (!raw) {
    return null;
  }

  if (raw.includes('@')) {
    const email = Email.normalize(raw);
    return email
      ? { value: email, channel: 'EMAIL', masked: Email.create(email).masked() }
      : null;
  }

  const phone = PhoneNumber.normalize(raw);
  return phone ? { value: phone, channel: 'SMS', masked: PhoneNumber.create(phone).masked() } : null;
}
