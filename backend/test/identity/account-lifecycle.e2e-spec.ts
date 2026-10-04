import request from 'supertest';
import { auth, body, createUserWithRole, DEVICE, errorOf, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

describe('Account recovery and suspension (e2e)', () => {
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

  // Scenario 9: forgot password → reset → previous sessions/tokens invalidated.
  it('resets the password and invalidates every prior session and token', async () => {
    const user = await registerAndVerify(ctx);
    const original = await login(ctx, user.phone, user.password);

    const forgot = await request(ctx.server)
      .post('/auth/password/forgot')
      .send({ identifier: user.phone })
      .expect(201);
    expect(body(forgot)).toEqual({ challengeSent: true });

    const code = ctx.notifications.lastCodeFor(user.phone, 'otp-reset');
    const newPassword = 'NewStr0ngPassw0rd';

    const reset = await request(ctx.server)
      .post('/auth/password/reset')
      .send({ identifier: user.phone, code, newPassword })
      .expect(201);
    expect(body(reset)).toEqual({ reset: true });

    // The access token minted before the reset must be dead — permVersion bumped on reset.
    const staleAccess = await request(ctx.server)
      .get('/users/me')
      .set(...auth(original.accessToken))
      .expect(401);
    expect(errorOf(staleAccess).code).toBe('TOKEN_EXPIRED');

    // The refresh token must be dead too — logout-all runs as part of reset. It is
    // known-but-revoked rather than unknown, so this reports as reuse (see auth-session spec).
    const staleRefresh = await request(ctx.server)
      .post('/auth/token/refresh')
      .send({ refreshToken: original.refreshToken })
      .expect(401);
    expect(errorOf(staleRefresh).code).toBe('AUTH_REFRESH_REUSE_DETECTED');

    // The old password no longer works; the new one does.
    await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: user.phone, password: user.password, deviceInfo: DEVICE })
      .expect(401);

    await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: user.phone, password: newPassword, deviceInfo: DEVICE })
      .expect(201);
  });

  it('reports success for an unknown identifier without issuing an otp (no enumeration)', async () => {
    const res = await request(ctx.server)
      .post('/auth/password/forgot')
      .send({ identifier: '+251999999999' })
      .expect(201);
    expect(body(res)).toEqual({ challengeSent: true });
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('rejects an invalid reset code', async () => {
    const user = await registerAndVerify(ctx);
    await request(ctx.server).post('/auth/password/forgot').send({ identifier: user.phone }).expect(201);

    const res = await request(ctx.server)
      .post('/auth/password/reset')
      .send({ identifier: user.phone, code: '000000', newPassword: 'NewStr0ngPassw0rd' })
      .expect(400);
    expect(errorOf(res).code).toBe('AUTH_OTP_INVALID');
  });

  // Scenario 10: account suspension → access and refresh tokens rejected.
  it('suspends the account and rejects every access and refresh token', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);
    const admin = await createUserWithRole(ctx, 'ADMIN');

    await request(ctx.server)
      .post(`/admin/users/${user.userId}/suspend`)
      .set(...auth(admin.accessToken))
      .send({ reason: 'fraud investigation' })
      .expect(204);

    const staleAccess = await request(ctx.server)
      .get('/users/me')
      .set(...auth(tokens.accessToken))
      .expect(401);
    expect(errorOf(staleAccess).code).toBe('TOKEN_EXPIRED');

    const staleRefresh = await request(ctx.server)
      .post('/auth/token/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
    expect(errorOf(staleRefresh).code).toBe('AUTH_REFRESH_REUSE_DETECTED');

    const loginAttempt = await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: user.phone, password: user.password, deviceInfo: DEVICE })
      .expect(403);
    expect(errorOf(loginAttempt).code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  it('reactivation restores login without restoring the old session', async () => {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);
    const admin = await createUserWithRole(ctx, 'ADMIN');

    await request(ctx.server)
      .post(`/admin/users/${user.userId}/suspend`)
      .set(...auth(admin.accessToken))
      .send({ reason: 'fraud investigation' })
      .expect(204);
    await request(ctx.server)
      .post(`/admin/users/${user.userId}/reactivate`)
      .set(...auth(admin.accessToken))
      .expect(204);

    await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: user.phone, password: user.password, deviceInfo: DEVICE })
      .expect(201);

    // The pre-suspension refresh token stays dead — reactivation does not resurrect old sessions.
    const res = await request(ctx.server)
      .post('/auth/token/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
    expect(errorOf(res).code).toBe('AUTH_REFRESH_REUSE_DETECTED');
  });

  it('a non-admin cannot suspend anyone', async () => {
    const attacker = await registerAndVerify(ctx);
    const attackerTokens = await login(ctx, attacker.phone, attacker.password);
    const victim = await registerAndVerify(ctx);

    const res = await request(ctx.server)
      .post(`/admin/users/${victim.userId}/suspend`)
      .set(...auth(attackerTokens.accessToken))
      .send({ reason: 'malicious' })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });
});
