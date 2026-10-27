import 'reflect-metadata';
import { resolveIdentityVerificationProvider } from './identity-verification.config';
import { validateEnv } from './env.validation';

/**
 * The runtime-mode / provider-selection contract (Work 58, ADR-027), at the rule and through the
 * real boot-time `validateEnv` path.
 */
describe('identity verification provider selection', () => {
  describe('resolveIdentityVerificationProvider', () => {
    it.each(['development', 'test', undefined])('defaults to the mock outside production (NODE_ENV=%s)', (nodeEnv) => {
      expect(resolveIdentityVerificationProvider(nodeEnv, undefined)).toBe('mock');
      expect(resolveIdentityVerificationProvider(nodeEnv, '  ')).toBe('mock');
    });

    it('honours an explicit selection outside production', () => {
      expect(resolveIdentityVerificationProvider('development', 'mock')).toBe('mock');
      expect(resolveIdentityVerificationProvider('development', 'fayda')).toBe('fayda');
    });

    it('requires an explicit value in production and never defaults it', () => {
      expect(() => resolveIdentityVerificationProvider('production', undefined)).toThrow(/must be set explicitly in production/);
      expect(() => resolveIdentityVerificationProvider('production', '')).toThrow(/must be set explicitly in production/);
    });

    it('rejects the mock in production', () => {
      expect(() => resolveIdentityVerificationProvider('production', 'mock')).toThrow(/not allowed in production/);
    });

    it('accepts fayda in production (the adapter itself is checked at composition)', () => {
      expect(resolveIdentityVerificationProvider('production', 'fayda')).toBe('fayda');
    });

    it('rejects unknown values in every mode instead of replacing them', () => {
      for (const nodeEnv of ['development', 'test', 'production']) {
        expect(() => resolveIdentityVerificationProvider(nodeEnv, 'Fayda')).toThrow(/must be one of mock, fayda/);
        expect(() => resolveIdentityVerificationProvider(nodeEnv, 'real')).toThrow(/must be one of mock, fayda/);
      }
    });
  });

  describe('boot-time validation (validateEnv)', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      JWT_ACCESS_SECRET: 'access-secret-0123456789',
      JWT_REFRESH_SECRET: 'refresh-secret-0123456789',
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    };

    it('accepts development and test without the setting (mock by default)', () => {
      expect(validateEnv({ ...base, NODE_ENV: 'development' }).IDENTITY_VERIFICATION_PROVIDER).toBeUndefined();
      expect(validateEnv({ ...base, NODE_ENV: 'test' }).IDENTITY_VERIFICATION_PROVIDER).toBeUndefined();
    });

    it('rejects production without the setting', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
        /Invalid environment configuration: IDENTITY_VERIFICATION_PROVIDER must be set explicitly in production/,
      );
    });

    it('rejects the contradictory production + mock combination', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'mock' })).toThrow(
        /Invalid environment configuration: IDENTITY_VERIFICATION_PROVIDER=mock is not allowed in production/,
      );
    });

    it('rejects a value outside the allowed set', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'development', IDENTITY_VERIFICATION_PROVIDER: 'real' })).toThrow(
        /Invalid environment configuration: .*IDENTITY_VERIFICATION_PROVIDER/,
      );
    });

    it('passes production + fayda through validation', () => {
      // Production also requires the Redis OTP store's settings (Work 60).
      const otp = { REDIS_URL: 'redis://localhost:6379', OTP_HASH_SECRET: 'q7Vb2Lx9Rk4Tz1Wm8Np3Hs6Df0Gj5Ya2' };
      expect(validateEnv({ ...base, ...otp, NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'fayda' }).IDENTITY_VERIFICATION_PROVIDER).toBe('fayda');
    });
  });
});
