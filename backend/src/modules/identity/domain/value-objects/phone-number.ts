import { IdentityErrors } from '../errors';

/**
 * Ethiopian phone number value object. Normalizes accepted local/international forms to E.164
 * (`+2519XXXXXXXX` / `+2517XXXXXXXX`). Immutable; construction fails fast on invalid input so
 * the rest of the domain can trust the value.
 *
 * Accepted inputs (mobile): `09XXXXXXXX`, `9XXXXXXXX`, `+2519XXXXXXXX`, `2519XXXXXXXX`
 * and the `7`-prefixed equivalents (Ethio Telecom / Safaricom ranges).
 */
export class PhoneNumber {
  private constructor(readonly value: string) {}

  static create(raw: string): PhoneNumber {
    const normalized = PhoneNumber.normalize(raw);
    if (!normalized) {
      throw IdentityErrors.validation('Invalid Ethiopian phone number.', {
        field: 'phone',
      });
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

  /** Masked form for display / verification responses, e.g. `+2519****4321`. */
  masked(): string {
    return `${this.value.slice(0, 5)}****${this.value.slice(-4)}`;
  }

  toString(): string {
    return this.value;
  }
}
