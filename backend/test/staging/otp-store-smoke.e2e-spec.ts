import { randomUUID } from 'crypto';
import Redis from 'ioredis';

/**
 * Work 61: the local-staging OTP smoke test (`otp-store.smoke.ts`) against the suite's disposable
 * Redis container, so the script the rehearsal runs is itself tested: it passes on a Redis-backed
 * configuration, fails (exit code 1) on any other, prints no code or secret, and leaves no live
 * challenge behind. Each case imports the script in its own module registry with its own env,
 * because the config module reads the environment when it is loaded.
 */
type Smoke = typeof import('./otp-store.smoke');

const SECRET = 'smoke-e2e-otp-hmac-Zq4Wv8Tn2Lr6Kx1Ms9Pd';

async function runSmokeWith(env: Record<string, string>): Promise<{ code: number; out: string }> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const lines: string[] = [];
  const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const log = jest.spyOn(console, 'log').mockImplementation(capture);
  const error = jest.spyOn(console, 'error').mockImplementation(capture);
  try {
    let code = -1;
    // main() runs inside the isolated registry too: the script imports the config module lazily,
    // and that import must resolve in the same registry as the OTP token it compares against.
    await jest.isolateModulesAsync(async () => {
      const smoke: Smoke = await import('./otp-store.smoke');
      code = await smoke.main();
    });
    return { code, out: lines.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('Local staging OTP smoke test (e2e)', () => {
  const prefix = `otp-smoke-e2e-${randomUUID()}`;
  let raw: Redis;

  beforeAll(() => {
    expect(process.env.REDIS_TEST_URL).toBeTruthy();
    raw = new Redis(process.env.REDIS_TEST_URL ?? '');
  });

  afterAll(() => raw?.disconnect());

  const redisEnv = () => ({
    NODE_ENV: 'development',
    REDIS_URL: process.env.REDIS_TEST_URL ?? '',
    REDIS_KEY_PREFIX: prefix,
    OTP_STORE: 'redis',
    OTP_HASH_SECRET: SECRET,
  });

  it('passes all seven checks on the Redis store, printing only check names', async () => {
    const { code, out } = await runSmokeWith(redisEnv());
    expect(out).toContain('OTP SMOKE PASSED (7/7 checks)');
    expect(code).toBe(0);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(out).toMatch(new RegExp(`^PASS ${n}\\. `, 'm'));
    // No six-digit code, synthetic identifier, secret or connection string reaches the output.
    expect(out).not.toMatch(/\b\d{6}\b/);
    expect(out).not.toContain('.invalid');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(process.env.REDIS_TEST_URL);
  }, 60_000);

  it('leaves no live challenge behind: only the cooldown keys, which expire on their own', async () => {
    const keys = await raw.keys(`${prefix}:otp:*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.endsWith(':cooldown'))).toBe(true);
    for (const key of keys) {
      const ttl = await raw.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30_000);
    }
  });

  it('fails with exit code 1 when the in-memory store is selected', async () => {
    const { code, out } = await runSmokeWith({ ...redisEnv(), OTP_STORE: 'memory' });
    expect(code).toBe(1);
    expect(out).toMatch(/OTP SMOKE FAILED after 0 passing check\(s\): OTP_SERVICE is InMemoryOtpService, not RedisOtpService/);
    expect(out).not.toContain('PASS 1.');
  }, 60_000);

  it('fails with exit code 1, without echoing the value, when OTP_HASH_SECRET is a placeholder', async () => {
    const { code, out } = await runSmokeWith({ ...redisEnv(), OTP_HASH_SECRET: 'REPLACE_ME' });
    expect(code).toBe(1);
    expect(out).toMatch(/OTP SMOKE FAILED/);
    expect(out).not.toContain('REPLACE_ME');
  }, 60_000);

  it('fails with exit code 1 when Redis is unreachable, instead of falling back to memory', async () => {
    const { code, out } = await runSmokeWith({ ...redisEnv(), REDIS_URL: 'redis://127.0.0.1:1' });
    expect(code).toBe(1);
    expect(out).toMatch(/OTP SMOKE FAILED after 0 passing check\(s\): the shared Redis connection is not ready/);
  }, 60_000);
});
