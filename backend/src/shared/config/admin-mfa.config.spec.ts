import { randomBytes } from 'crypto';
import { decodeAdminMfaKey, resolveAdminMfaKey } from './admin-mfa.config';
import { validateEnv } from './env.validation';

describe('ADMIN_MFA_ENCRYPTION_KEY (Work 66)', () => {
  // Test-only key material, generated per run.
  const key = randomBytes(32).toString('base64');

  describe('decodeAdminMfaKey', () => {
    it('accepts 32 random bytes in base64', () => {
      expect(decodeAdminMfaKey(key)).toHaveLength(32);
    });

    it.each([
      ['missing', undefined, /must be set/],
      ['blank', '   ', /must be set/],
      ['too short', randomBytes(16).toString('base64'), /32 random bytes/],
      ['too long', randomBytes(48).toString('base64'), /32 random bytes/],
      ['not base64', '!'.repeat(43) + '=', /32 random bytes/],
      ['a placeholder', Buffer.alloc(32, 7).toString('base64'), /placeholder/],
    ])('rejects a key that is %s', (_label, raw, message) => {
      expect(() => decodeAdminMfaKey(raw)).toThrow(message);
    });

    it('rejects a copy of another secret', () => {
      expect(() => decodeAdminMfaKey(key, ['other', key])).toThrow(/dedicated key/);
    });

    it('never puts the value in the error message', () => {
      const bad = randomBytes(31).toString('base64');
      expect(() => decodeAdminMfaKey(bad)).toThrow(expect.objectContaining({ message: expect.not.stringContaining(bad) }));
    });
  });

  describe('resolveAdminMfaKey', () => {
    it('is required in production, with no fallback', () => {
      expect(() => resolveAdminMfaKey({ nodeEnv: 'production', key: undefined })).toThrow(/must be set in production/);
      expect(resolveAdminMfaKey({ nodeEnv: 'production', key })).toHaveLength(32);
    });

    it('is optional elsewhere (MFA then fails closed), but must be valid when set', () => {
      expect(resolveAdminMfaKey({ nodeEnv: 'development', key: undefined })).toBeNull();
      expect(resolveAdminMfaKey({ nodeEnv: 'test', key: '' })).toBeNull();
      expect(() => resolveAdminMfaKey({ nodeEnv: 'development', key: 'short' })).toThrow();
    });
  });

  describe('validateEnv', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_ACCESS_SECRET: 'access-secret-0123456789',
      JWT_REFRESH_SECRET: 'refresh-secret-0123456789',
      MASTER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      IDENTITY_VERIFICATION_PROVIDER: 'fayda',
      REDIS_URL: 'redis://localhost:6379',
      OTP_HASH_SECRET: 'q7Vb2Lx9Rk4Tz1Wm8Np3Hs6Df0Gj5Ya2',
    };

    it('refuses to start production without the key', () => {
      expect(() => validateEnv(production)).toThrow(/ADMIN_MFA_ENCRYPTION_KEY must be set in production/);
    });

    it('refuses to start production with a malformed key or a reused secret', () => {
      expect(() => validateEnv({ ...production, ADMIN_MFA_ENCRYPTION_KEY: 'not-a-key' })).toThrow(/ADMIN_MFA_ENCRYPTION_KEY/);
      expect(() =>
        validateEnv({ ...production, ADMIN_MFA_ENCRYPTION_KEY: production.MASTER_ENCRYPTION_KEY }),
      ).toThrow(/dedicated key/);
    });

    it('starts production with a valid dedicated key', () => {
      expect(() => validateEnv({ ...production, ADMIN_MFA_ENCRYPTION_KEY: key })).not.toThrow();
    });
  });
});
