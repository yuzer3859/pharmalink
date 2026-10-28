import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import request from 'supertest';
import type { IOtpService } from '../../src/modules/identity/application/ports/otp.service';
import { OtpVerifyResult } from '../../src/modules/identity/application/ports/otp.service';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { body, errorOf, STRONG_PASSWORD, uniquePhone } from '../support/fixtures';
import type { TestContext } from '../support/test-app';

/**
 * Work 60: the Redis OTP store against the suite's disposable Redis container, through two
 * independent application instances that share it — the same shape as two API nodes. Nothing here
 * mocks Redis: TTLs, single use, attempt limits, the cooldown and concurrency are Redis's own
 * behaviour under the adapter's Lua scripts. Codes are read from the recording notification
 * transport, the way a user reads an SMS; no route exposes them.
 */
type Harness = typeof import('../support/test-app');
interface App {
  ctx: TestContext;
  harness: Harness;
  /** This app's own module registry's token and adapter class (each app is isolated). */
  otp: IOtpService;
  RedisOtpService: typeof import('../../src/modules/identity/infrastructure/otp/redis-otp.service').RedisOtpService;
}

const SECRET = 'e2e-otp-hmac-key-Qx7Lm2Vb9Rk4Tz1Wn8Ps';

async function appWith(env: Record<string, string>): Promise<App> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    let harness!: Harness;
    let ports!: typeof import('../../src/modules/identity/application/ports/otp.service');
    let adapter!: typeof import('../../src/modules/identity/infrastructure/otp/redis-otp.service');
    await jest.isolateModulesAsync(async () => {
      harness = await import('../support/test-app');
      ports = await import('../../src/modules/identity/application/ports/otp.service');
      adapter = await import('../../src/modules/identity/infrastructure/otp/redis-otp.service');
    });
    const ctx = await harness.createTestApp();
    return { ctx, harness, otp: ctx.app.get<IOtpService>(ports.OTP_SERVICE), RedisOtpService: adapter.RedisOtpService };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const otpOf = (app: App) => app.otp;

async function issued(app: App, identifier: string, purpose: OtpPurpose): Promise<string> {
  const outcome = await otpOf(app).issue(identifier, purpose);
  if (outcome.status !== 'ISSUED') throw new Error(`expected ISSUED, got ${outcome.status}`);
  return outcome.code;
}

const otherCode = (code: string) => (code === '000000' ? '000001' : '000000');

describe('Redis-backed OTP storage (e2e)', () => {
  const prefix = `redis-otp-e2e-${randomUUID()}`;
  let a: App;
  let b: App;
  let raw: Redis;

  beforeAll(async () => {
    expect(process.env.REDIS_TEST_URL).toBeTruthy();
    const env = {
      REDIS_URL: process.env.REDIS_TEST_URL ?? '',
      REDIS_KEY_PREFIX: prefix,
      OTP_STORE: 'redis',
      OTP_HASH_SECRET: SECRET,
      OTP_MAX_ATTEMPTS: '5',
    };
    a = await appWith(env);
    b = await appWith(env);
    raw = new Redis(process.env.REDIS_TEST_URL ?? '');
  }, 120_000);

  afterAll(async () => {
    raw?.disconnect();
    await b?.harness.closeTestApp(b.ctx);
    await a?.harness.closeTestApp(a.ctx);
  });

  const otpKeys = () => raw.keys(`${prefix}:otp:*`);

  beforeEach(async () => {
    await a.ctx.reset();
    b.ctx.notifications.clear();
    // Only this run's own prefix: other suites and other data in the container are untouched.
    const keys = await otpKeys();
    if (keys.length > 0) await raw.del(...keys);
  });

  const challengeKey = async (purpose: OtpPurpose) =>
    (await otpKeys()).find((k) => k.includes(`{${purpose}:`) && !k.endsWith(':cooldown'));

  it('both instances use the Redis store', () => {
    expect(otpOf(a)).toBeInstanceOf(a.RedisOtpService);
    expect(otpOf(b)).toBeInstanceOf(b.RedisOtpService);
  });

  describe('storage', () => {
    it('1. stores a hashed six-digit code with the configured TTL and cooldown, keyed without the raw identifier', async () => {
      const phone = uniquePhone();
      const code = await issued(a, phone, OtpPurpose.REGISTER);
      expect(code).toMatch(/^\d{6}$/);

      const keys = (await otpKeys()).filter((k) => k.includes('{REGISTER:'));
      expect(keys).toHaveLength(2);
      const challenge = keys.find((k) => !k.endsWith(':cooldown'))!;
      const cooldown = keys.find((k) => k.endsWith(':cooldown'))!;
      expect(challenge.startsWith(`${prefix}:otp:v1:`)).toBe(true);

      const ttl = await raw.pttl(challenge);
      expect(ttl).toBeGreaterThan(290_000);
      expect(ttl).toBeLessThanOrEqual(300_000);
      const cooldownTtl = await raw.pttl(cooldown);
      expect(cooldownTtl).toBeGreaterThan(25_000);
      expect(cooldownTtl).toBeLessThanOrEqual(30_000);

      const stored = await raw.hgetall(challenge);
      expect(stored).toEqual({ h: expect.stringMatching(/^[0-9a-f]{64}$/), a: '0' });
      const everything = JSON.stringify({ keys, stored });
      for (const secretThing of [code, phone, phone.slice(1), SECRET]) expect(everything).not.toContain(secretThing);
    });
  });

  describe('verification', () => {
    it('2. the right code verifies exactly once', async () => {
      const phone = uniquePhone();
      const code = await issued(a, phone, OtpPurpose.LOGIN);
      expect(await otpOf(b).verify(phone, OtpPurpose.LOGIN, code)).toBe(OtpVerifyResult.OK);
      expect(await otpOf(a).verify(phone, OtpPurpose.LOGIN, code)).toBe(OtpVerifyResult.EXPIRED);
      expect(await challengeKey(OtpPurpose.LOGIN)).toBeUndefined();
    });

    it('3-4. wrong codes count attempts; past the limit even the right code is refused', async () => {
      const phone = uniquePhone();
      const code = await issued(a, phone, OtpPurpose.RESET);
      for (let i = 1; i <= 5; i += 1) {
        expect(await otpOf(i % 2 ? a : b).verify(phone, OtpPurpose.RESET, otherCode(code))).toBe(OtpVerifyResult.INVALID);
        expect(await raw.hget((await challengeKey(OtpPurpose.RESET))!, 'a')).toBe(String(i));
      }
      expect(await otpOf(a).verify(phone, OtpPurpose.RESET, code)).toBe(OtpVerifyResult.ATTEMPTS_EXCEEDED);
      expect(await otpOf(a).verify(phone, OtpPurpose.RESET, code)).toBe(OtpVerifyResult.EXPIRED);
    });

    it('5. an expired code cannot verify (Redis removes it at its TTL)', async () => {
      const phone = uniquePhone();
      const code = await issued(a, phone, OtpPurpose.REGISTER);
      // Shorten the real TTL rather than waiting five minutes; Redis itself does the expiring.
      await raw.pexpire((await challengeKey(OtpPurpose.REGISTER))!, 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await otpOf(a).verify(phone, OtpPurpose.REGISTER, code)).toBe(OtpVerifyResult.EXPIRED);
    });

    it('6. a replacement invalidates the previous code and resets the attempt count', async () => {
      const phone = uniquePhone();
      const first = await issued(a, phone, OtpPurpose.STEP_UP);
      await otpOf(a).verify(phone, OtpPurpose.STEP_UP, otherCode(first));
      let second = first;
      while (second === first) {
        // End the cooldown instead of waiting it out.
        await raw.del((await otpKeys()).find((k) => k.includes('{STEP_UP:') && k.endsWith(':cooldown'))!);
        second = await issued(b, phone, OtpPurpose.STEP_UP);
      }
      expect(await raw.hget((await challengeKey(OtpPurpose.STEP_UP))!, 'a')).toBe('0');
      expect(await otpOf(a).verify(phone, OtpPurpose.STEP_UP, first)).toBe(OtpVerifyResult.INVALID);
      expect(await otpOf(a).verify(phone, OtpPurpose.STEP_UP, second)).toBe(OtpVerifyResult.OK);
    });

    it('7. challenges are isolated by purpose and by normalized identifier', async () => {
      const phone = uniquePhone();
      const register = await issued(a, phone, OtpPurpose.REGISTER);
      const login = await issued(a, phone, OtpPurpose.LOGIN);
      for (const purpose of [OtpPurpose.RESET, OtpPurpose.STEP_UP]) {
        expect(await otpOf(a).verify(phone, purpose, register)).toBe(OtpVerifyResult.EXPIRED);
      }
      if (login !== register) {
        expect(await otpOf(a).verify(phone, OtpPurpose.LOGIN, register)).toBe(OtpVerifyResult.INVALID);
      }
      expect(await otpOf(a).verify(uniquePhone(), OtpPurpose.REGISTER, register)).toBe(OtpVerifyResult.EXPIRED);
      expect(await otpOf(a).verify(phone, OtpPurpose.REGISTER, register)).toBe(OtpVerifyResult.OK);
    });
  });

  describe('cooldown and concurrency', () => {
    it('8. the cooldown holds across independent instances', async () => {
      const phone = uniquePhone();
      await issued(a, phone, OtpPurpose.REGISTER);
      const refused = await otpOf(b).issue(phone, OtpPurpose.REGISTER);
      expect(refused).toEqual({ status: 'COOLDOWN', retryAfterSeconds: expect.any(Number) });
      if (refused.status === 'COOLDOWN') {
        expect(refused.retryAfterSeconds).toBeGreaterThan(0);
        expect(refused.retryAfterSeconds).toBeLessThanOrEqual(30);
      }
    });

    it('9. concurrent verification consumes a challenge once and cannot exceed the attempt limit', async () => {
      const phone = uniquePhone();
      const code = await issued(a, phone, OtpPurpose.LOGIN);
      const right = await Promise.all(
        Array.from({ length: 12 }, (_, i) => otpOf(i % 2 ? a : b).verify(phone, OtpPurpose.LOGIN, code)),
      );
      expect(right.filter((r) => r === OtpVerifyResult.OK)).toHaveLength(1);
      expect(right.filter((r) => r === OtpVerifyResult.EXPIRED)).toHaveLength(11);

      const other = uniquePhone();
      const code2 = await issued(a, other, OtpPurpose.LOGIN);
      const wrong = await Promise.all(
        Array.from({ length: 20 }, (_, i) => otpOf(i % 2 ? a : b).verify(other, OtpPurpose.LOGIN, otherCode(code2))),
      );
      expect(wrong.filter((r) => r === OtpVerifyResult.INVALID)).toHaveLength(5);
      expect(wrong.filter((r) => r === OtpVerifyResult.ATTEMPTS_EXCEEDED)).toHaveLength(1);
      expect(wrong.filter((r) => r === OtpVerifyResult.EXPIRED)).toHaveLength(14);
      expect(await otpOf(a).verify(other, OtpPurpose.LOGIN, code2)).toBe(OtpVerifyResult.EXPIRED);
    });

    it('10. concurrent resends cannot bypass the cooldown', async () => {
      const phone = uniquePhone();
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, i) => otpOf(i % 2 ? a : b).issue(phone, OtpPurpose.RESET)),
      );
      expect(outcomes.filter((o) => o.status === 'ISSUED')).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === 'COOLDOWN')).toHaveLength(11);
    });
  });

  describe('HTTP behaviour on the Redis store', () => {
    it('15. register → OTP delivered → verify activates; an immediate resend is refused with 429 and sends nothing', async () => {
      const phone = uniquePhone();
      await request(a.ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(201);
      await a.ctx.drainOutbox();
      const code = a.ctx.notifications.lastCodeFor(phone, 'otp-register');

      for (const app of [a, b]) {
        const resend = await request(app.ctx.server).post('/auth/resend-otp').send({ identifier: phone, purpose: OtpPurpose.REGISTER }).expect(429);
        expect(errorOf(resend).code).toBe('RATE_LIMITED');
        expect(resend.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      }
      expect(a.ctx.notifications.sent.filter((n) => n.to === phone)).toHaveLength(1);
      expect(b.ctx.notifications.sent).toHaveLength(0);

      const wrong = await request(b.ctx.server)
        .post('/auth/verify-otp')
        .send({ identifier: phone, code: otherCode(code), purpose: OtpPurpose.REGISTER })
        .expect(400);
      expect(errorOf(wrong).code).toBe('AUTH_OTP_INVALID');
      const ok = await request(b.ctx.server).post('/auth/verify-otp').send({ identifier: phone, code, purpose: OtpPurpose.REGISTER }).expect(201);
      expect(body(ok)).toEqual({ verified: true });
      const user = await a.ctx.prisma.user.findFirstOrThrow({ where: { phone } });
      expect(user.status).toBe('ACTIVE');
      const replay = await request(a.ctx.server).post('/auth/verify-otp').send({ identifier: phone, code, purpose: OtpPurpose.REGISTER }).expect(410);
      expect(errorOf(replay).code).toBe('AUTH_OTP_EXPIRED');
    });

    it('a client resend before the registration event is relayed keeps that code; the handler does not issue a second', async () => {
      const phone = uniquePhone();
      await request(a.ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(201);
      const resent = await request(b.ctx.server).post('/auth/resend-otp').send({ identifier: phone, purpose: OtpPurpose.REGISTER }).expect(201);
      expect(body(resent)).toEqual({ resent: true, cooldownSeconds: 30 });
      await a.ctx.drainOutbox();

      expect(a.ctx.notifications.sent.filter((n) => n.to === phone)).toHaveLength(0);
      const code = b.ctx.notifications.lastCodeFor(phone, 'otp-register');
      await request(a.ctx.server).post('/auth/verify-otp').send({ identifier: phone, code, purpose: OtpPurpose.REGISTER }).expect(201);
    });

    it('forgot → reset works across instances; a second forgot within the cooldown sends nothing but answers the same', async () => {
      const phone = uniquePhone();
      await request(a.ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(201);
      await a.ctx.drainOutbox();
      const reg = a.ctx.notifications.lastCodeFor(phone, 'otp-register');
      await request(a.ctx.server).post('/auth/verify-otp').send({ identifier: phone, code: reg, purpose: OtpPurpose.REGISTER }).expect(201);

      const first = await request(a.ctx.server).post('/auth/password/forgot').send({ identifier: phone }).expect(201);
      const second = await request(b.ctx.server).post('/auth/password/forgot').send({ identifier: phone }).expect(201);
      expect(body(first)).toEqual({ challengeSent: true });
      expect(body(second)).toEqual({ challengeSent: true });
      expect(a.ctx.notifications.sent.filter((n) => n.template === 'otp-reset')).toHaveLength(1);
      expect(b.ctx.notifications.sent).toHaveLength(0);

      const code = a.ctx.notifications.lastCodeFor(phone, 'otp-reset');
      await request(b.ctx.server)
        .post('/auth/password/reset')
        .send({ identifier: phone, code, newPassword: 'NewStr0ngPassw0rd' })
        .expect(201);
      await request(a.ctx.server)
        .post('/auth/login')
        .send({ identifier: phone, password: 'NewStr0ngPassw0rd', deviceInfo: { fingerprint: 'redis-otp-e2e', platform: 'WEB' } })
        .expect(201);
    });

    it('14. OTP codes, identifiers, the secret and hashes never reach the application logs', async () => {
      const written: string[] = [];
      const capture = (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      };
      const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
      const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
      const phone = uniquePhone();
      let code = '';
      let hash: string | null = null;
      try {
        await request(a.ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(201);
        await a.ctx.drainOutbox();
        code = a.ctx.notifications.lastCodeFor(phone, 'otp-register');
        await request(b.ctx.server).post('/auth/resend-otp').send({ identifier: phone, purpose: OtpPurpose.REGISTER }).expect(429);
        await request(b.ctx.server).post('/auth/verify-otp').send({ identifier: phone, code: otherCode(code), purpose: OtpPurpose.REGISTER }).expect(400);
        hash = await raw.hget((await challengeKey(OtpPurpose.REGISTER))!, 'h');
        await request(b.ctx.server).post('/auth/verify-otp').send({ identifier: phone, code, purpose: OtpPurpose.REGISTER }).expect(201);
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      const logs = written.join('');
      // The flow does log (the 429 and 400 responses, the event relay); none of it may carry these.
      expect(logs.length).toBeGreaterThan(0);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      for (const secretThing of [code, otherCode(code), phone, phone.slice(4), SECRET, STRONG_PASSWORD, hash!]) {
        expect(logs).not.toContain(secretThing);
      }
    });
  });

  describe('Redis unavailable', () => {
    let down: App;

    beforeAll(async () => {
      // Nothing listens on port 1: Redis is configured but unreachable from boot.
      down = await appWith({
        REDIS_URL: 'redis://127.0.0.1:1',
        REDIS_KEY_PREFIX: `${prefix}-down`,
        OTP_STORE: 'redis',
        OTP_HASH_SECRET: SECRET,
      });
    }, 120_000);

    afterAll(async () => {
      await down?.harness.closeTestApp(down.ctx);
    });

    it('11. fails closed with 503 and never falls back to memory', async () => {
      expect(otpOf(down)).toBeInstanceOf(down.RedisOtpService);
      const phone = uniquePhone();

      const resend = await request(down.ctx.server).post('/auth/resend-otp').send({ identifier: phone, purpose: OtpPurpose.REGISTER }).expect(503);
      expect(errorOf(resend).code).toBe('DEPENDENCY_UNAVAILABLE');
      const verify = await request(down.ctx.server)
        .post('/auth/verify-otp')
        .send({ identifier: phone, code: '123456', purpose: OtpPurpose.REGISTER })
        .expect(503);
      expect(errorOf(verify).code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(JSON.stringify([resend.body, verify.body])).not.toContain(phone);
      expect(down.ctx.notifications.sent).toHaveLength(0);
    });

    it('password recovery stays non-enumerating: the generic answer, and nothing issued or sent', async () => {
      const phone = uniquePhone();
      await request(down.ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(201);
      const known = await request(down.ctx.server).post('/auth/password/forgot').send({ identifier: phone }).expect(201);
      const unknown = await request(down.ctx.server).post('/auth/password/forgot').send({ identifier: uniquePhone() }).expect(201);
      expect(body(known)).toEqual({ challengeSent: true });
      expect(body(unknown)).toEqual({ challengeSent: true });
      expect(down.ctx.notifications.sent).toHaveLength(0);
    });
  });
});
