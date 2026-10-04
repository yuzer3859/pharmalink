import { IdentityErrors } from '../errors';

// Pragmatic RFC 5322 subset: single @, no spaces, a dotted domain with a 2+ char TLD.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Email value object. Stored and compared in lowercase to keep uniqueness case-insensitive. */
export class Email {
  private constructor(readonly value: string) {}

  static create(raw: string): Email {
    const normalized = Email.normalize(raw);
    if (!normalized) {
      throw IdentityErrors.validation('Invalid email address.', { field: 'email' });
    }
    return new Email(normalized);
  }

  static normalize(raw: string): string | null {
    if (!raw) {
      return null;
    }
    const trimmed = raw.trim().toLowerCase();
    return EMAIL_RE.test(trimmed) ? trimmed : null;
  }

  masked(): string {
    const [user, domain] = this.value.split('@');
    const head = user.slice(0, Math.min(2, user.length));
    return `${head}***@${domain}`;
  }

  toString(): string {
    return this.value;
  }
}
