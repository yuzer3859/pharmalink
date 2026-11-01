import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { IMfaSecretCipher } from '../../application/ports/mfa-secret-cipher.port';
import { IdentityErrors } from '../../domain/errors';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/**
 * AES-256-GCM under ADMIN_MFA_ENCRYPTION_KEY (Work 66). Format: `v1.<iv>.<tag>.<ciphertext>`, each
 * part base64url. The user id is the additional authenticated data, so ciphertext only decrypts for
 * the account it was written for. The `v1` prefix leaves room for a future key-rotation format.
 *
 * The key is read once at construction. In production `validateEnv` has already refused to start
 * without a valid key; elsewhere a missing key leaves the cipher unconfigured and every MFA
 * operation fails closed.
 */
@Injectable()
export class AesGcmMfaSecretCipher implements IMfaSecretCipher {
  private readonly key: Buffer | null;

  constructor(config: AppConfigService) {
    this.key = config.adminMfaEncryptionKey;
  }

  isConfigured(): boolean {
    return this.key !== null;
  }

  encrypt(secret: Buffer, userId: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    cipher.setAAD(Buffer.from(userId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, ...[iv, tag, ciphertext].map((part) => part.toString('base64url'))].join('.');
  }

  decrypt(serialized: string, userId: string): Buffer {
    const key = this.requireKey();
    const [version, iv, tag, ciphertext] = serialized.split('.');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Unsupported MFA secret format.');
    }
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(userId, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw IdentityErrors.mfaUnavailable();
    }
    return this.key;
  }
}
