import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';

/**
 * Firebase Cloud Messaging configuration keys (module-13 Work 14), read through `IConfigPort`. The
 * three values of a Firebase service-account key: no credential is ever a literal in source.
 *
 * Like the Telebirr gateway's keys, they are deliberately **not** in `env.validation.ts`: that
 * schema validates what the app needs to boot, and push is optional — with any of these unset the
 * platform runs, the PUSH provider is not bound, and PUSH delivery jobs wait `PENDING`.
 */
export const FCM_CONFIG_KEYS = {
  /** The Firebase project id (`project_id` in the service-account JSON). */
  projectId: 'FCM_PROJECT_ID',
  /** The service account's e-mail (`client_email`). */
  clientEmail: 'FCM_CLIENT_EMAIL',
  /** The service account's PEM private key (`private_key`); `\n` escapes are accepted. Never logged. */
  privateKey: 'FCM_PRIVATE_KEY',
} as const;

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** Reads the FCM credentials without ever exposing them; `missing()` reports key *names* only. */
@Injectable()
export class FcmConfig {
  constructor(@Inject(CONFIG_PORT) private readonly config: IConfigPort) {}

  private value(key: string): string | null {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  }

  missing(): string[] {
    return Object.values(FCM_CONFIG_KEYS).filter((key) => this.value(key) === null);
  }

  /** The credentials, or `null` when any is unset. Callers must never log the result. */
  credentials(): FcmCredentials | null {
    const projectId = this.value(FCM_CONFIG_KEYS.projectId);
    const clientEmail = this.value(FCM_CONFIG_KEYS.clientEmail);
    const privateKey = this.value(FCM_CONFIG_KEYS.privateKey);
    if (!projectId || !clientEmail || !privateKey) return null;
    return { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') };
  }
}
