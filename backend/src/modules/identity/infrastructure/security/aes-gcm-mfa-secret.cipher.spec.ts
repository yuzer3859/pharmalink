import { randomBytes } from 'crypto';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AesGcmMfaSecretCipher } from './aes-gcm-mfa-secret.cipher';

const configWith = (key: Buffer | null) => ({ adminMfaEncryptionKey: key }) as unknown as AppConfigService;

describe('AesGcmMfaSecretCipher (Work 66)', () => {
  // Test-only key material, generated per run.
  const cipher = new AesGcmMfaSecretCipher(configWith(randomBytes(32)));
  const secret = randomBytes(20);

  it('round-trips a secret without the plaintext appearing in the ciphertext', () => {
    const encrypted = cipher.encrypt(secret, 'user-1');
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(encrypted).not.toContain(secret.toString('base64url'));
    expect(encrypted).not.toContain(secret.toString('hex'));
    expect(cipher.decrypt(encrypted, 'user-1').equals(secret)).toBe(true);
  });

  it('uses a fresh IV every time', () => {
    expect(cipher.encrypt(secret, 'user-1')).not.toBe(cipher.encrypt(secret, 'user-1'));
  });

  it('refuses ciphertext copied to another account (user id is authenticated data)', () => {
    const encrypted = cipher.encrypt(secret, 'user-1');
    expect(() => cipher.decrypt(encrypted, 'user-2')).toThrow();
  });

  it('refuses tampered ciphertext', () => {
    const [v, iv, tag, data] = cipher.encrypt(secret, 'user-1').split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;
    expect(() => cipher.decrypt([v, iv, tag, flipped.toString('base64url')].join('.'), 'user-1')).toThrow();
  });

  it('refuses ciphertext written under another key', () => {
    const other = new AesGcmMfaSecretCipher(configWith(randomBytes(32)));
    expect(() => cipher.decrypt(other.encrypt(secret, 'user-1'), 'user-1')).toThrow();
  });

  it('fails closed when the key is not configured', () => {
    const unconfigured = new AesGcmMfaSecretCipher(configWith(null));
    expect(unconfigured.isConfigured()).toBe(false);
    expect(() => unconfigured.encrypt(secret, 'user-1')).toThrow(expect.objectContaining({ code: 'DEPENDENCY_UNAVAILABLE' }));
  });
});
