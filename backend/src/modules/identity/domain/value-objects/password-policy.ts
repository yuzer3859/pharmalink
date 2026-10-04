import { IdentityErrors } from '../errors';

export interface PasswordRules {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
}

export const DEFAULT_PASSWORD_RULES: PasswordRules = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
};

/**
 * Password policy domain service (module-01 §8). Pure and configurable so the ruleset can be
 * driven by IConfigPort later without changing call sites. Validation only — hashing lives
 * behind the IHasher port in the application/infrastructure layers (separation of concerns).
 */
export class PasswordPolicy {
  constructor(private readonly rules: PasswordRules = DEFAULT_PASSWORD_RULES) {}

  /** Returns the list of unmet-requirement messages (empty = valid). */
  check(password: string): string[] {
    const failures: string[] = [];
    if (!password || password.length < this.rules.minLength) {
      failures.push(`Must be at least ${this.rules.minLength} characters.`);
    }
    if (this.rules.requireUppercase && !/[A-Z]/.test(password)) {
      failures.push('Must contain an uppercase letter.');
    }
    if (this.rules.requireLowercase && !/[a-z]/.test(password)) {
      failures.push('Must contain a lowercase letter.');
    }
    if (this.rules.requireDigit && !/\d/.test(password)) {
      failures.push('Must contain a digit.');
    }
    return failures;
  }

  isValid(password: string): boolean {
    return this.check(password).length === 0;
  }

  /** Throws AUTH_WEAK_PASSWORD with field-level details when the password is too weak. */
  assert(password: string): void {
    const failures = this.check(password);
    if (failures.length > 0) {
      throw IdentityErrors.weakPassword({ field: 'password', requirements: failures });
    }
  }
}
