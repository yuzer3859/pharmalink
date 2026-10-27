import { validateEnv } from './env.validation';
import { assertOtpHashSecret, resolveOtpStore } from './otp.config';

/** Work 60: which OTP store may run where, and what it needs. */
describe('OTP store configuration', () => {
  const SECRET = 'q7Vb2Lx9Rk4Tz1Wm8Np3Hs6Df0Gj5Ya2';
  const REDIS = 'redis://localhost:6379';

  describe('resolveOtpStore', () => {
    it('defaults to memory outside production, so local work and tests need no Redis', () => {
      expect(resolveOtpStore({ nodeEnv: 'development', store: undefined, redisUrl: undefined, hashSecret: undefined })).toBe('memory');
      expect(resolveOtpStore({ nodeEnv: 'test', store: '', redisUrl: undefined, hashSecret: undefined })).toBe('memory');
    });

    it('defaults to redis in production', () => {
      expect(resolveOtpStore({ nodeEnv: 'production', store: undefined, redisUrl: REDIS, hashSecret: SECRET })).toBe('redis');
    });

    it('rejects the in-memory store in production', () => {
      expect(() => resolveOtpStore({ nodeEnv: 'production', store: 'memory', redisUrl: REDIS, hashSecret: SECRET })).toThrow(
        /OTP_STORE=memory is not allowed in production/,
      );
    });

    it('requires REDIS_URL for the redis store, in production and elsewhere', () => {
      expect(() => resolveOtpStore({ nodeEnv: 'production', store: undefined, redisUrl: '', hashSecret: SECRET })).toThrow(/requires REDIS_URL/);
      expect(() => resolveOtpStore({ nodeEnv: 'development', store: 'redis', redisUrl: undefined, hashSecret: SECRET })).toThrow(/requires REDIS_URL/);
    });

    it('requires a usable OTP_HASH_SECRET for the redis store', () => {
      expect(() => resolveOtpStore({ nodeEnv: 'production', store: 'redis', redisUrl: REDIS, hashSecret: undefined })).toThrow(/OTP_HASH_SECRET must be set/);
    });

    it('rejects unknown values', () => {
      expect(() => resolveOtpStore({ nodeEnv: 'development', store: 'file', redisUrl: REDIS, hashSecret: SECRET })).toThrow(/must be one of redis, memory/);
    });
  });

  describe('assertOtpHashSecret', () => {
    it('accepts a long random secret', () => {
      expect(assertOtpHashSecret(SECRET)).toBe(SECRET);
    });

    it.each([
      ['too short', 'a1B2c3D4e5F6g7H8'],
      ['a placeholder', 'REPLACE_ME_REPLACE_ME_REPLACE_ME_1234'],
      ['low entropy', 'abababababababababababababababababab'],
    ])('rejects %s, without echoing the value', (_label, value) => {
      let message = '';
      try {
        assertOtpHashSecret(value);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/OTP_HASH_SECRET/);
      expect(message).not.toContain(value);
    });

    it('rejects a copy of another secret', () => {
      expect(() => assertOtpHashSecret(SECRET, ['x', SECRET])).toThrow(/dedicated secret/);
    });
  });

  describe('validateEnv', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_ACCESS_SECRET: 'access-secret-0123456789',
      JWT_REFRESH_SECRET: 'refresh-secret-0123456789',
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    };

    it('boots outside production with no OTP settings (in-memory store)', () => {
      const env = validateEnv({ ...base, NODE_ENV: 'development' });
      expect(env.OTP_TTL_SECONDS).toBe(300);
      expect(env.OTP_MAX_ATTEMPTS).toBe(5);
      expect(env.OTP_RESEND_COOLDOWN_SECONDS).toBe(30);
    });

    it('refuses production without Redis and an OTP secret', () => {
      const production = { ...base, NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'fayda' };
      expect(() => validateEnv(production)).toThrow(/OTP_STORE=redis requires REDIS_URL/);
      expect(() => validateEnv({ ...production, REDIS_URL: REDIS })).toThrow(/OTP_HASH_SECRET must be set/);
      expect(() => validateEnv({ ...production, REDIS_URL: REDIS, OTP_HASH_SECRET: SECRET, OTP_STORE: 'memory' })).toThrow(
        /OTP_STORE=memory is not allowed in production/,
      );
      // Complete OTP settings pass this check (production startup itself is still blocked later,
      // by the unbound Fayda adapter: ADR-027).
      expect(() => validateEnv({ ...production, REDIS_URL: REDIS, OTP_HASH_SECRET: SECRET })).not.toThrow();
    });

    it('accepts a complete redis configuration', () => {
      expect(validateEnv({ ...base, NODE_ENV: 'development', OTP_STORE: 'redis', REDIS_URL: REDIS, OTP_HASH_SECRET: SECRET }).OTP_STORE).toBe('redis');
    });

    it('rejects the OTP secret reusing a JWT secret', () => {
      const reused = 'access-secret-0123456789-access-secret';
      expect(() =>
        validateEnv({ ...base, JWT_ACCESS_SECRET: reused, NODE_ENV: 'development', OTP_STORE: 'redis', REDIS_URL: REDIS, OTP_HASH_SECRET: reused }),
      ).toThrow(/dedicated secret/);
    });

    it.each([
      ['OTP_TTL_SECONDS', '0'],
      ['OTP_TTL_SECONDS', '86400'],
      ['OTP_MAX_ATTEMPTS', '0'],
      ['OTP_RESEND_COOLDOWN_SECONDS', '0'],
      ['OTP_RESEND_COOLDOWN_SECONDS', 'soon'],
    ])('rejects %s=%s at boot', (key, value) => {
      expect(() => validateEnv({ ...base, [key]: value })).toThrow(/Invalid environment configuration/);
    });
  });
});
