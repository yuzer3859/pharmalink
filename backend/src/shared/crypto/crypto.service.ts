import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';
import { AppConfigService } from '../config/app-config.service';
import { EncryptedPayload, IEncryptionPort } from './crypto.port';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Envelope-encryption helper (see ADR-009). For each record a fresh 256-bit data key is
 * generated, used to AES-256-GCM encrypt the payload, then wrapped (encrypted) under the
 * master key. In production the master key wrap/unwrap is delegated to a KMS; here it is done
 * locally with a configured MASTER_ENCRYPTION_KEY so the contract is identical and swappable.
 */
@Injectable()
export class CryptoService implements IEncryptionPort {
  private readonly masterKey: Buffer;

  constructor(config: AppConfigService) {
    this.masterKey = CryptoService.decodeMasterKey(config.masterEncryptionKey);
  }

  static decodeMasterKey(encoded: string): Buffer {
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `MASTER_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}).`,
      );
    }
    return key;
  }

  encrypt(plaintext: string | Buffer): EncryptedPayload {
    const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');

    const dataKey = randomBytes(KEY_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, dataKey, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();

    const keyIv = randomBytes(IV_BYTES);
    const keyCipher = createCipheriv(ALGO, this.masterKey, keyIv);
    const wrappedKey = Buffer.concat([keyCipher.update(dataKey), keyCipher.final()]);
    const keyTag = keyCipher.getAuthTag();

    return {
      v: 1,
      wrappedKey: wrappedKey.toString('base64'),
      keyIv: keyIv.toString('base64'),
      keyTag: keyTag.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decrypt(payload: EncryptedPayload): Buffer {
    if (payload.v !== 1) {
      throw new Error(`Unsupported encrypted payload version: ${payload.v}`);
    }

    const keyDecipher = createDecipheriv(
      ALGO,
      this.masterKey,
      Buffer.from(payload.keyIv, 'base64'),
    );
    keyDecipher.setAuthTag(Buffer.from(payload.keyTag, 'base64'));
    const dataKey = Buffer.concat([
      keyDecipher.update(Buffer.from(payload.wrappedKey, 'base64')),
      keyDecipher.final(),
    ]);

    const decipher = createDecipheriv(ALGO, dataKey, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]);
  }

  encryptToString(plaintext: string | Buffer): string {
    return Buffer.from(JSON.stringify(this.encrypt(plaintext))).toString('base64');
  }

  decryptFromString(serialized: string): Buffer {
    const payload = JSON.parse(
      Buffer.from(serialized, 'base64').toString('utf8'),
    ) as EncryptedPayload;
    return this.decrypt(payload);
  }
}
