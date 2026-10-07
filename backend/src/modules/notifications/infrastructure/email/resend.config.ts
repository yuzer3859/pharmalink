import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';

/**
 * Resend configuration keys (module-13 Work 17), read through `IConfigPort` like FCM's and
 * Telebirr's — no credential or sender is ever a literal in source, and none is in
 * `env.validation.ts`: e-mail is optional, and with either key unset the platform runs, the e-mail
 * provider is not registered, and EMAIL delivery jobs wait `PENDING`.
 */
export const RESEND_CONFIG_KEYS = {
  /** A Resend API key (`re_…`) with sending access. Never logged. */
  apiKey: 'RESEND_API_KEY',
  /**
   * The sender, on a domain verified in Resend: `alerts@example.com` or `PharmaLink <alerts@example.com>`.
   * Used verbatim as the `from` field; there is no default.
   */
  fromEmail: 'RESEND_FROM_EMAIL',
} as const;

export interface ResendCredentials {
  apiKey: string;
  from: string;
}

/**
 * Reads the Resend settings without ever exposing them; `missing()` reports key *names* only.
 *
 * **Never configured under `NODE_ENV=test`.** The automated suites must not be able to send real
 * e-mail even if a developer's shell happens to export `RESEND_*`; tests bind the in-memory
 * transport or script the HTTP layer instead. The opt-in smoke script (`test/manual/resend-smoke.ts`)
 * runs outside Jest.
 */
@Injectable()
export class ResendConfig {
  constructor(@Inject(CONFIG_PORT) private readonly config: IConfigPort) {}

  private value(key: string): string | null {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  }

  missing(): string[] {
    return Object.values(RESEND_CONFIG_KEYS).filter((key) => this.value(key) === null);
  }

  /** The credentials, or `null` when either is unset (or under test). Callers must never log the result. */
  credentials(): ResendCredentials | null {
    if (this.config.get<string>('NODE_ENV') === 'test') return null;
    const apiKey = this.value(RESEND_CONFIG_KEYS.apiKey);
    const from = this.value(RESEND_CONFIG_KEYS.fromEmail);
    if (!apiKey || !from || !from.includes('@')) return null;
    return { apiKey, from };
  }
}
