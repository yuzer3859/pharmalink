import request from 'supertest';
import {
  auth,
  body,
  DEVICE,
  errorOf,
  registerAndVerify,
  SECOND_DEVICE,
  STRONG_PASSWORD,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

describe('Login, refresh rotation and logout (e2e)', () => {
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

  // Scenario 2: login → access token → refresh token rotation.
  it('logs in and issues a working access token', async () => {
    const user = await registerAndVerify(ctx);

    const res = await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: user.phone, password: user.password, deviceInfo: DEVICE })
      .expect(201);

    const data = body(res);
    expect(typeof data.accessToken).toBe('string');
    expect(typeof data.refreshToken).toBe('string');

    const me = await request(ctx.server)
      .get('/users/me')
      .set(...auth(data.accessToken as string))
      .expect(200);
    expect(body(me).id).toBe(user.userId);
  });

  it('rejects the wrong password without revealing whether the account exists', async () => {
    const user = await registerAndVerify(ctx);

    const res = await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: user.phone, password: 'WrongPassword1', deviceInfo: DEVICE })
      .expect(401);

    expect(errorOf(res).code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('rotates the refresh token and rejects the old one on reuse (theft response)', async () => {
    const user = await registerAndVerify(ctx);
    const loginRes = await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: user.phone, password: user.password, deviceInfo: DEVICE })
      .expect(201);
    const original = body(loginRes);

    const refreshed = await request(ctx.server)
      .post('/auth/token/refresh')
      .send({ refreshToken: original.refreshToken })
      .expect(201);
    const rotated = body(refreshed);

    expect(rotated.refreshToken).not.toBe(original.refreshToken);
    expect(rotated.accessToken).not.toBe(original.accessToken);

    // New token works.
    await request(ctx.server)
      .get('/users/me')
      .set(...auth(rotated.accessToken as string))
      .expect(200);

    // Replaying the consumed token is treated as theft: the whole rotation family dies,
    // including the token that was just issued from it. Once a token is known-but-revoked,
    // presenting it again is reported as reuse, not as a generic invalid token — that
    // distinction is what lets a client tell "your session ended" apart from "you may have
    // been compromised".
    const reuse = await request(ctx.server)
      .post('/auth/token/refresh')
      .send({ refreshToken: original.refreshToken })
      .expect(401);
    expect(errorOf(reuse).code).toBe('AUTH_REFRESH_REUSE_DETECTED');

    const afterTheft = await request(ctx.server)
      .post('/auth/token/refresh')
      .send({ refreshToken: rotated.refreshToken })
      .expect(401);
    expect(errorOf(afterTheft).code).toBe('AUTH_REFRESH_REUSE_DETECTED');
  });

  // Scenario 3: logout → old refresh token rejected.
  it('rejects the refresh token after logout', async () => {
    const user = await registerAndVerify(ctx);
    const loginRes = await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: user.phone, password: user.password, deviceInfo: DEVICE })
      .expect(201);
    const tokens = body(loginRes);

    // Per module-01 §11.2, /auth/logout requires Bearer auth even though the refresh token
    // alone identifies the session to revoke.
    await request(ctx.server)
      .post('/auth/logout')
      .set(...auth(tokens.accessToken as string))
      .send({ refreshToken: tokens.refreshToken })
      .expect(204);

    const res = await request(ctx.server)
      .post('/auth/token/refresh')
      .send({ refreshToken: tokens.refreshToken })
      .expect(401);
    expect(errorOf(res).code).toBe('AUTH_REFRESH_REUSE_DETECTED');
  });

  it('logout-all revokes every device session, not just the caller device', async () => {
    const user = await registerAndVerify(ctx);
    const deviceA = body(
      await request(ctx.server)
        .post('/auth/login')
        .send({ identifier: user.phone, password: user.password, deviceInfo: DEVICE })
        .expect(201),
    );
    const deviceB = body(
      await request(ctx.server)
        .post('/auth/login')
        .send({ identifier: user.phone, password: user.password, deviceInfo: SECOND_DEVICE })
        .expect(201),
    );

    await request(ctx.server)
      .post('/auth/logout-all')
      .set(...auth(deviceA.accessToken as string))
      .expect(204);

    for (const tokens of [deviceA, deviceB]) {
      const res = await request(ctx.server)
        .post('/auth/token/refresh')
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
      expect(errorOf(res).code).toBe('AUTH_REFRESH_REUSE_DETECTED');
    }
  });

  // Scenario 4: protected endpoint → unauthenticated request rejected.
  it('rejects a protected endpoint with no bearer token', async () => {
    const res = await request(ctx.server).get('/users/me').expect(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a protected endpoint with a garbage bearer token', async () => {
    const res = await request(ctx.server)
      .get('/users/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
    expect(errorOf(res).code).toBe('AUTH_TOKEN_INVALID');
  });

  it('allows @Public endpoints without a token', async () => {
    await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: '+251900000000', password: STRONG_PASSWORD, deviceInfo: DEVICE })
      .expect(401); // reaches the handler (not blocked at the guard) and fails on credentials
  });
});
