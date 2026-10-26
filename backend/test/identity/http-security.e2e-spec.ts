import { randomUUID } from 'crypto';
import request from 'supertest';
import type { TestContext } from '../support/test-app';

/**
 * Work 59 over real HTTP: security headers, health probes, rate limits and trusted proxies.
 *
 * Each app is built from its own module graph (`jest.isolateModulesAsync`) with its own
 * environment, so one suite can compare default and explicitly configured security settings and
 * use low limits without affecting other suites (global setup sets very high limits for them).
 * Limits are exceeded by request count within one long window: no sleeps, no timing.
 */
type Harness = typeof import('../support/test-app');

async function appWith(env: Record<string, string>): Promise<{ ctx: TestContext; harness: Harness }> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    let harness!: Harness;
    await jest.isolateModulesAsync(async () => {
      harness = await import('../support/test-app');
    });
    return { ctx: await harness.createTestApp(), harness };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const loginBody = () => ({
  identifier: '+251911000000',
  password: 'Wrong-Passw0rd!',
  deviceInfo: { fingerprint: 'http-security-e2e', platform: 'WEB', name: 'supertest' },
});

describe('HTTP security hardening (e2e)', () => {
  describe('defaults: no trusted proxy, low limits, no HSTS', () => {
    let app: { ctx: TestContext; harness: Harness };

    beforeAll(async () => {
      app = await appWith({
        RATE_LIMIT_AUTH_LIMIT: '3',
        RATE_LIMIT_AUTH_TTL_SECONDS: '600',
        RATE_LIMIT_DEFAULT_LIMIT: '5',
        RATE_LIMIT_DEFAULT_TTL_SECONDS: '600',
        TRUST_PROXY: '',
        HTTP_HSTS_MAX_AGE_SECONDS: '0',
      });
    }, 120_000);

    afterAll(async () => {
      await app.harness.closeTestApp(app.ctx);
    });

    const expectSecurityHeaders = (headers: Record<string, string>) => {
      expect(headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'");
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(headers['x-powered-by']).toBeUndefined();
      expect(headers['strict-transport-security']).toBeUndefined();
    };

    it('1-2. health probes answer 200 without a token, with security headers, and are not rate-limited', async () => {
      for (let i = 0; i < 12; i += 1) {
        const live = await request(app.ctx.server).get('/health/live').expect(200);
        expect(live.body).toMatchObject({ success: true, data: { status: 'ok' } });
        const ready = await request(app.ctx.server).get('/health/ready').expect(200);
        expect(ready.body.data.info.database.status).toBe('up');
        if (i === 0) expectSecurityHeaders(live.headers as Record<string, string>);
      }
    });

    it('1, 3. security headers are on error responses too, and protected routes still reject anonymous requests', async () => {
      const res = await request(app.ctx.server).get('/users/me').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expectSecurityHeaders(res.headers as Record<string, string>);
    });

    it('4-5. within the auth limit, login behaves normally (401 for bad credentials); beyond it, 429 with Retry-After', async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await request(app.ctx.server).post('/auth/login').send(loginBody()).expect(401);
        expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
      }
      const limited = await request(app.ctx.server).post('/auth/login').send(loginBody()).expect(429);
      expect(limited.body).toMatchObject({ success: false, data: null, error: { code: 'RATE_LIMITED' } });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(600);
      expect(JSON.stringify(limited.body)).not.toMatch(/Wrong-Passw0rd|\+251911000000/);
    });

    it('limits are per route: exhausting login does not lock the client out of other routes', async () => {
      await request(app.ctx.server).post('/auth/resend-otp').send({ identifier: '+251911000001', purpose: 'REGISTER' }).expect((res) => {
        expect(res.status).not.toBe(429);
      });
    });

    it('7. spoofed X-Forwarded-For is ignored when no proxy is trusted: every request counts against the real client', async () => {
      const statuses: number[] = [];
      for (const spoofed of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) {
        const res = await request(app.ctx.server)
          .post('/auth/password/forgot')
          .set('X-Forwarded-For', spoofed)
          .send({ identifier: `+2519110${Math.floor(Math.random() * 90000) + 10000}` });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 3)).not.toContain(429);
      expect(statuses[3]).toBe(429);
    });

    it('ordinary routes have the (looser) default limit', async () => {
      for (let i = 0; i < 5; i += 1) await request(app.ctx.server).get('/catalog/categories').expect(200);
      const res = await request(app.ctx.server).get('/catalog/categories').expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('explicit trusted proxy (loopback) and HSTS', () => {
    let app: { ctx: TestContext; harness: Harness };

    beforeAll(async () => {
      app = await appWith({
        RATE_LIMIT_AUTH_LIMIT: '2',
        RATE_LIMIT_AUTH_TTL_SECONDS: '600',
        RATE_LIMIT_DEFAULT_LIMIT: '1000',
        TRUST_PROXY: 'loopback',
        HTTP_HSTS_MAX_AGE_SECONDS: '31536000',
      });
    }, 120_000);

    afterAll(async () => {
      await app.harness.closeTestApp(app.ctx);
    });

    const login = (xff: string) => request(app.ctx.server).post('/auth/login').set('X-Forwarded-For', xff).send(loginBody());

    it('sends HSTS only when configured, without includeSubDomains', async () => {
      const res = await request(app.ctx.server).get('/health/live').expect(200);
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
    });

    it('6, 8. behind a trusted proxy, different clients get separate limits', async () => {
      await login('203.0.113.10').expect(401);
      await login('203.0.113.10').expect(401);
      await login('203.0.113.10').expect(429);
      await login('203.0.113.11').expect(401);
    });

    it('8. a client cannot choose its identity by prepending addresses: only the nearest untrusted hop counts', async () => {
      await login('192.0.2.1, 203.0.113.20').expect(401);
      await login('192.0.2.2, 203.0.113.20').expect(401);
      await login('192.0.2.3, 203.0.113.20').expect(429);
    });
  });

  describe('shared counters across instances (Redis)', () => {
    let a: { ctx: TestContext; harness: Harness };
    let b: { ctx: TestContext; harness: Harness };

    beforeAll(async () => {
      const env = {
        REDIS_URL: process.env.REDIS_TEST_URL ?? '',
        REDIS_KEY_PREFIX: `http-security-e2e-${randomUUID()}`,
        RATE_LIMIT_AUTH_LIMIT: '2',
        RATE_LIMIT_AUTH_TTL_SECONDS: '600',
        RATE_LIMIT_DEFAULT_LIMIT: '1000',
        TRUST_PROXY: '',
      };
      a = await appWith(env);
      b = await appWith(env);
    }, 120_000);

    afterAll(async () => {
      await b.harness.closeTestApp(b.ctx);
      await a.harness.closeTestApp(a.ctx);
    });

    it('a limit reached through one instance holds on another', async () => {
      expect(process.env.REDIS_TEST_URL).toBeTruthy();
      await request(a.ctx.server).post('/auth/login').send(loginBody()).expect(401);
      await request(b.ctx.server).post('/auth/login').send(loginBody()).expect(401);
      const res = await request(a.ctx.server).post('/auth/login').send(loginBody()).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });
});
