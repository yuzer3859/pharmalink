import 'reflect-metadata';
import { parseTrustProxy } from './http-security.config';
import { validateEnv } from './env.validation';

/** Work 59: trusted-proxy parsing and boot-time validation of the HTTP security settings. */
describe('HTTP security configuration', () => {
  describe('parseTrustProxy', () => {
    it.each([undefined, null, '', '  ', 'false', 'FALSE'])('trusts no proxy by default (%p)', (raw) => {
      expect(parseTrustProxy(raw)).toBe(false);
    });

    it('accepts explicit proxy addresses, subnets and Express keywords', () => {
      expect(parseTrustProxy('loopback')).toEqual(['loopback']);
      expect(parseTrustProxy('10.0.0.5, 10.0.0.0/8 ,uniquelocal')).toEqual(['10.0.0.5', '10.0.0.0/8', 'uniquelocal']);
      expect(parseTrustProxy('fd00::/8,::1')).toEqual(['fd00::/8', '::1']);
    });

    it.each(['true', '*', 'all', 'TRUE'])('refuses to trust every proxy (%s)', (raw) => {
      expect(() => parseTrustProxy(raw)).toThrow(/must not trust every proxy/);
    });

    it('refuses hop counts', () => {
      expect(() => parseTrustProxy('1')).toThrow(/hop counts/);
    });

    it.each(['proxy.internal', '10.0.0.0/33', '::1/129', '300.1.1.1', '10.0.0.1,', '10.0.0.1/8/1'])('rejects malformed entries (%s)', (raw) => {
      expect(() => parseTrustProxy(raw)).toThrow(/TRUST_PROXY/);
    });
  });

  describe('validateEnv', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      JWT_ACCESS_SECRET: 'access-secret-0123456789',
      JWT_REFRESH_SECRET: 'refresh-secret-0123456789',
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    };

    it('applies safe defaults: no trusted proxy, limits in force, no HSTS', () => {
      const config = validateEnv(base);
      expect(config.TRUST_PROXY).toBeUndefined();
      expect(config.RATE_LIMIT_AUTH_LIMIT).toBe(10);
      expect(config.RATE_LIMIT_AUTH_TTL_SECONDS).toBe(60);
      expect(config.RATE_LIMIT_DEFAULT_LIMIT).toBe(300);
      expect(config.RATE_LIMIT_DEFAULT_TTL_SECONDS).toBe(60);
      expect(config.HTTP_HSTS_MAX_AGE_SECONDS).toBe(0);
    });

    it('converts string settings to numbers', () => {
      const config = validateEnv({ ...base, RATE_LIMIT_AUTH_LIMIT: '5', RATE_LIMIT_AUTH_TTL_SECONDS: '900', HTTP_HSTS_MAX_AGE_SECONDS: '31536000' });
      expect(config.RATE_LIMIT_AUTH_LIMIT).toBe(5);
      expect(config.RATE_LIMIT_AUTH_TTL_SECONDS).toBe(900);
      expect(config.HTTP_HSTS_MAX_AGE_SECONDS).toBe(31536000);
    });

    it.each([
      ['RATE_LIMIT_AUTH_LIMIT', '0'],
      ['RATE_LIMIT_AUTH_LIMIT', '-1'],
      ['RATE_LIMIT_AUTH_LIMIT', 'unlimited'],
      ['RATE_LIMIT_AUTH_LIMIT', '2.5'],
      ['RATE_LIMIT_AUTH_TTL_SECONDS', '0'],
      ['RATE_LIMIT_DEFAULT_LIMIT', '1000001'],
      ['RATE_LIMIT_DEFAULT_TTL_SECONDS', '86401'],
      ['HTTP_HSTS_MAX_AGE_SECONDS', '-5'],
      ['TRUST_PROXY', 'true'],
      ['TRUST_PROXY', '1'],
      ['TRUST_PROXY', 'my-proxy'],
    ])('refuses to boot on an invalid %s (%s), never treating it as unlimited or trusted', (key, value) => {
      expect(() => validateEnv({ ...base, [key]: value })).toThrow(new RegExp(`Invalid environment configuration: .*${key === 'TRUST_PROXY' ? 'TRUST_PROXY' : key}`));
    });
  });
});
