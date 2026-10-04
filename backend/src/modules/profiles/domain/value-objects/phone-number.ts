import { ProfileErrors } from '../errors';

/**
 * Ethiopian phone number value object for the Profiles module (module-02 §4.2). Mirrors
 * `modules/identity/domain/value-objects/phone-number.ts`'s normalization contract exactly, kept
 * as a local copy per the spec's default answer to §14 Q5 (hoisting to `shared/` was flagged as
 * an open question, not approved) — reconcile the two if that hoist is later approved.
 *
 * Accepted inputs (mobile): `09XXXXXXXX`, `9XXXXXXXX`, `+2519XXXXXXXX`, `2519XXXXXXXX`
 * and the `7`-prefixed equivalents (Ethio Telecom / Safaricom ranges).
 */
export class PhoneNumber {
  private constructor(readonly value: string) {}

  static create(raw: string, field = 'phone'): PhoneNumber {
    const normalized = PhoneNumber.normalize(raw);
    if (!normalized) {
      throw ProfileErrors.validation('Invalid Ethiopian phone number.', { field });
    }
    return new PhoneNumber(normalized);
  }

  /** Returns the E.164 form or null if the input is not a valid ET mobile number. */
  static normalize(raw: string): string | null {
    if (!raw) {
      return null;
    }
    const digits = raw.replace(/[\s\-()]/g, '');
    let local: string | null = null;

    if (/^\+2519\d{8}$/.test(digits) || /^\+2517\d{8}$/.test(digits)) {
      return digits;
    }
    if (/^2519\d{8}$/.test(digits) || /^2517\d{8}$/.test(digits)) {
      return `+${digits}`;
    }
    if (/^09\d{8}$/.test(digits) || /^07\d{8}$/.test(digits)) {
      local = digits.slice(1); // drop leading 0
    } else if (/^9\d{8}$/.test(digits) || /^7\d{8}$/.test(digits)) {
      local = digits;
    }

    return local ? `+251${local}` : null;
  }

  toString(): string {
    return this.value;
  }
}
