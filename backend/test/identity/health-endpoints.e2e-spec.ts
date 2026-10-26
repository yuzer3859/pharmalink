import request from 'supertest';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Health probes over real HTTP, without a token.
 *
 * Regression for the staging rehearsal (Work 57): `/health/live` and `/health/ready` carried no
 * public-route metadata, so the global `JwtAuthGuard` answered every container or monitor probe
 * with 401. Lives with the identity suites because what it pins is the guard's public-route
 * behaviour; the last case makes sure marking the probes public did not open anything else.
 */
describe('Health endpoints without authentication (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('GET /health/live succeeds with no Authorization header', async () => {
    const res = await request(ctx.server).get('/health/live').expect(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' }, error: null });
  });

  it('GET /health/ready succeeds with no Authorization header and reports the database up', async () => {
    const res = await request(ctx.server).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { status: 'ok', info: { database: { status: 'up' } } },
      error: null,
    });
  });

  it('a protected route still rejects an anonymous request', async () => {
    const res = await request(ctx.server).get('/users/me').expect(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });
  });
});
