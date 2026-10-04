import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../../shared/config/config.port';

/**
 * Telebirr configuration keys, read through `IConfigPort` (env-backed today, DB-backed once
 * Module 16 lands). **No credential is ever a literal in source** (§4).
 *
 * ## These names are provisional
 *
 * The authoritative Telebirr integration contract is not present in this repository (see
 * `TelebirrAdapter`), so the *exact* credential set this gateway requires is unknown — it may
 * need an app id and short code, a merchant id and API secret, an RSA key pair, or some
 * combination. The four keys below are a minimal, deliberately generic placeholder so the
 * configuration boundary exists and can be pointed at a sandbox the moment the contract arrives.
 *
 * Nothing depends on them being right: `TelebirrAdapter.isAvailable()` returns false regardless
 * of configuration while the contract is missing, so a wrong guess here cannot change runtime
 * behaviour. They are the seam, not an assertion about Telebirr's API.
 *
 * They are intentionally **not** added to `env.validation.ts`: that schema validates variables the
 * app requires to boot, and every one of these is optional — the platform runs, and every other
 * payment path works, with none of them set.
 */
export const TELEBIRR_CONFIG_KEYS = {
  /** Explicit opt-in. Absent or not `'true'` means the gateway is not in use. */
  enabled: 'TELEBIRR_ENABLED',
  /** Base URL of the Telebirr API environment (sandbox or production). */
  baseUrl: 'TELEBIRR_BASE_URL',
  /** Merchant/app identifier issued by Telebirr. */
  merchantId: 'TELEBIRR_MERCHANT_ID',
  /** Shared secret / API key used to authenticate outbound calls. Never logged. */
  apiSecret: 'TELEBIRR_API_SECRET',
  /** Secret used to verify inbound callback signatures. Never logged. */
  webhookSecret: 'TELEBIRR_WEBHOOK_SECRET',
} as const;

export interface TelebirrConfigState {
  enabled: boolean;
  /** Config keys that are required-when-enabled and currently absent. */
  missing: string[];
  /** True when enabled and nothing is missing. */
  complete: boolean;
}

/**
 * Reads and reports the Telebirr configuration without ever exposing its values.
 *
 * `describe()` returns key *names* only. That is what makes it safe to put in an error detail, an
 * audit context or a startup log — a diagnostic that says "TELEBIRR_API_SECRET is missing" is
 * useful; one that echoes the secret is an incident.
 */
@Injectable()
export class TelebirrConfig {
  constructor(@Inject(CONFIG_PORT) private readonly config: IConfigPort) {}

  describe(): TelebirrConfigState {
    const enabled = String(this.config.get<string>(TELEBIRR_CONFIG_KEYS.enabled) ?? '')
      .trim()
      .toLowerCase() === 'true';

    const required = [
      TELEBIRR_CONFIG_KEYS.baseUrl,
      TELEBIRR_CONFIG_KEYS.merchantId,
      TELEBIRR_CONFIG_KEYS.apiSecret,
      TELEBIRR_CONFIG_KEYS.webhookSecret,
    ];
    const missing = required.filter((key) => {
      const value = this.config.get<string>(key);
      return typeof value !== 'string' || value.trim().length === 0;
    });

    return { enabled, missing, complete: enabled && missing.length === 0 };
  }

  /** The webhook signing secret, or `null` when unset. Callers must never log the result. */
  webhookSecret(): string | null {
    const value = this.config.get<string>(TELEBIRR_CONFIG_KEYS.webhookSecret);
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }
}
