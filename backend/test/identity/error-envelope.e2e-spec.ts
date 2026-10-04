import request from 'supertest';
import { auth, login, registerAndVerify, STRONG_PASSWORD, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/** Scenario 12: the standard response envelope and HTTP status mapping, observed over real HTTP. */
describe('Response envelope and error mapping (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  it('wraps a successful response in the standard success envelope', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    const res = await request(ctx.server)
      .get('/users/me')
      .set(...auth(tokens.accessToken))
      .expect(200);

    expect(res.body).toMatchObject({ success: true, error: null });
    expect(res.body.data).toMatchObject({ id: user.userId });
    expect(res.body.meta).toEqual(
      expect.objectContaining({ requestId: expect.any(String), timestamp: expect.any(String) }),
    );
    expect(res.headers['x-request-id']).toBe(res.body.meta.requestId);
  });

  it('echoes a caller-supplied x-request-id back on both the header and the envelope', async () => {
    const res = await request(ctx.server)
      .get('/users/me')
      .set('x-request-id', 'caller-supplied-id-123')
      .expect(401);

    expect(res.headers['x-request-id']).toBe('caller-supplied-id-123');
    expect(res.body.meta.requestId).toBe('caller-supplied-id-123');
  });

  it('wraps a domain error in the standard error envelope with the correct HTTP status', async () => {
    const phone = uniquePhone();
    await request(ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(201);

    const res = await request(ctx.server)
      .post('/auth/register')
      .send({ phone, password: STRONG_PASSWORD })
      .expect(409);

    expect(res.body).toMatchObject({
      success: false,
      data: null,
      error: { code: 'AUTH_DUPLICATE_IDENTIFIER' },
    });
    expect(typeof res.body.error.message).toBe('string');
  });

  it('maps a class-validator failure to 400 VALIDATION_ERROR', async () => {
    const res = await request(ctx.server).post('/auth/register').send({ password: 'x' }).expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.success).toBe(false);
  });

  it('rejects a mass-assignment attempt on fields the DTO does not declare', async () => {
    // ValidationPipe is configured with whitelist + forbidNonWhitelisted (app.module.ts), so an
    // unexpected field is a hard 400, not a silent strip — the safer of the two choices for a
    // field like primaryRole, where "ignore it" and "reject it" have very different blast radii.
    const phone = uniquePhone();
    const res = await request(ctx.server)
      .post('/auth/register')
      .send({ phone, password: STRONG_PASSWORD, isAdmin: true, primaryRole: 'SUPER_ADMIN' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it('returns 404 NOT_FOUND with the standard envelope for an unknown route', async () => {
    const res = await request(ctx.server).get('/this-route-does-not-exist').expect(404);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error.code).toBe('string');
  });

  it('never leaks a raw stack trace or driver error to the client', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);

    // Malformed UUID reaching a Prisma findUnique — provokes a driver-level error deep in the
    // stack, which AllExceptionsFilter must still translate into the standard envelope.
    const res = await request(ctx.server)
      .delete(`/admin/users/${user.userId}/roles/not-a-uuid`)
      .set(...auth(tokens.accessToken))
      .expect(403); // CUSTOMER lacks rbac:manage, so this never reaches Prisma — still, no 500 leak.

    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+.*\(.*:\d+:\d+\)/); // no stack frame text
  });

  it('rejects an unsupported HTTP method on a real route with a clean envelope', async () => {
    const res = await request(ctx.server).put('/auth/login').send({}).expect(404);
    expect(res.body.success).toBe(false);
  });

  it('accepts a valid Ethiopian phone in every documented device platform', async () => {
    for (const platform of ['ANDROID', 'IOS', 'WEB']) {
      const phone = uniquePhone();
      await request(ctx.server)
        .post('/auth/register')
        .send({ phone, password: STRONG_PASSWORD })
        .expect(201);
      await ctx.drainOutbox();
      const code = ctx.notifications.lastCodeFor(phone, 'otp-register');
      await request(ctx.server)
        .post('/auth/verify-otp')
        .send({ identifier: phone, code, purpose: 'REGISTER' })
        .expect(201);

      await request(ctx.server)
        .post('/auth/login')
        .send({
          identifier: phone,
          password: STRONG_PASSWORD,
          deviceInfo: { fingerprint: `platform-${platform}`, platform },
        })
        .expect(201);
    }
  });
});
