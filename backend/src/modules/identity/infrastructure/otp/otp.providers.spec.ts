import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { validateEnv } from '../../../../shared/config/env.validation';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { RedisService } from '../../../../shared/redis/redis.service';
import { OTP_SERVICE } from '../../application/ports/otp.service';
import { InMemoryOtpService } from './in-memory-otp.service';
import { otpProviders } from './otp.providers';
import { RedisOtpService } from './redis-otp.service';

/**
 * Work 60: the identity module's real OTP binding (`otpProviders`), compiled in a Nest testing
 * module. Production resolves to the Redis store or refuses to start; the in-memory store is never
 * constructed there, and nothing falls back from one to the other.
 */
const BASE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'access-secret-0123456789',
  JWT_REFRESH_SECRET: 'refresh-secret-0123456789',
  MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const SECRET = 'q7Vb2Lx9Rk4Tz1Wm8Np3Hs6Df0Gj5Ya2';
const REDIS = 'redis://localhost:6379';

/** `validated: false` skips `validateEnv`, to prove composition refuses a bad selection by itself. */
function configFor(env: Record<string, string>, { validated = true } = {}): AppConfigService {
  const values: Record<string, unknown> = validated ? { ...validateEnv({ ...BASE_ENV, ...env }) } : { ...BASE_ENV, ...env };
  const nodeEnv = (values.NODE_ENV as string | undefined) ?? 'development';
  return {
    get: <T>(key: string) => values[key] as T | undefined,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    jwtAccessSecret: values.JWT_ACCESS_SECRET,
    jwtRefreshSecret: values.JWT_REFRESH_SECRET,
    masterEncryptionKey: values.MASTER_ENCRYPTION_KEY,
    otpTtlSeconds: 300,
    otpMaxAttempts: 5,
    otpResendCooldownSeconds: 30,
  } as unknown as AppConfigService;
}

/** A RedisService that never connects; selection only needs `isEnabled`. */
const redisFor = (env: Record<string, string>) => ({ isEnabled: Boolean(env.REDIS_URL) }) as RedisService;

async function compile(env: Record<string, string>, options?: { validated?: boolean }) {
  return Test.createTestingModule({
    providers: [
      { provide: AppConfigService, useValue: configFor(env, options) },
      { provide: RedisService, useValue: redisFor(env) },
      AppLogger,
      ...otpProviders,
    ],
  }).compile();
}

describe('OTP store wiring (DI)', () => {
  beforeEach(() => jest.spyOn(AppLogger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('production selects the Redis store', async () => {
    const announced = jest.spyOn(AppLogger.prototype, 'log').mockImplementation(() => undefined);
    const moduleRef = await compile({ NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'fayda', REDIS_URL: REDIS, OTP_HASH_SECRET: SECRET });
    expect(moduleRef.get(OTP_SERVICE)).toBeInstanceOf(RedisOtpService);
    expect(announced).toHaveBeenCalledWith('OTP challenges are stored in Redis (OTP_STORE=redis).');
    expect(JSON.stringify(announced.mock.calls)).not.toContain(SECRET);
  });

  it('production never selects the in-memory store, even when validation is bypassed', async () => {
    const constructed = jest.spyOn(AppLogger.prototype, 'setContext');
    const production = { NODE_ENV: 'production', REDIS_URL: REDIS, OTP_HASH_SECRET: SECRET };
    await expect(compile({ ...production, OTP_STORE: 'memory' }, { validated: false })).rejects.toThrow(/OTP_STORE=memory is not allowed in production/);
    await expect(compile({ NODE_ENV: 'production', OTP_HASH_SECRET: SECRET }, { validated: false })).rejects.toThrow(/requires REDIS_URL/);
    await expect(compile({ NODE_ENV: 'production', REDIS_URL: REDIS }, { validated: false })).rejects.toThrow(/OTP_HASH_SECRET must be set/);
    expect(constructed).not.toHaveBeenCalledWith(InMemoryOtpService.name);
  });

  it('the in-memory store refuses production on its own as well', () => {
    expect(() => new InMemoryOtpService(configFor({ NODE_ENV: 'production' }, { validated: false }), new AppLogger())).toThrow(
      /must not be used in production/,
    );
  });

  it('outside production, unset selects the in-memory store and says so', async () => {
    const envs: Array<Record<string, string>> = [{ NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { NODE_ENV: 'development', OTP_STORE: 'memory', REDIS_URL: REDIS }];
    for (const env of envs) {
      const moduleRef = await compile(env);
      expect(moduleRef.get(OTP_SERVICE)).toBeInstanceOf(InMemoryOtpService);
    }
    expect(AppLogger.prototype.warn).toHaveBeenCalledWith(expect.stringMatching(/in memory .*Local development and tests only/));
  });

  it('OTP_STORE=redis without Redis configured fails at startup instead of falling back to memory', async () => {
    await expect(compile({ NODE_ENV: 'development', OTP_STORE: 'redis', OTP_HASH_SECRET: SECRET }, { validated: false })).rejects.toThrow(
      /requires REDIS_URL/,
    );
    expect(() => new RedisOtpService(redisFor({}), configFor({ NODE_ENV: 'development' }), new AppLogger())).toThrow(
      /in-memory store is never substituted/,
    );
  });

  it('OTP_STORE=redis outside production selects the Redis store', async () => {
    const moduleRef = await compile({ NODE_ENV: 'development', OTP_STORE: 'redis', REDIS_URL: REDIS, OTP_HASH_SECRET: SECRET });
    expect(moduleRef.get(OTP_SERVICE)).toBeInstanceOf(RedisOtpService);
  });
});
