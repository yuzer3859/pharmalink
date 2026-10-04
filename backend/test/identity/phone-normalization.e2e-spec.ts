import request from 'supertest';
import { DEVICE, STRONG_PASSWORD } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Scenario 11: phone normalization across every accepted input format, over real HTTP. This is
 * the regression coverage for the bug where registration stored the E.164 form but login/OTP
 * verification queried by the raw user input, so anyone who registered with a local-format
 * number could never verify or log back in.
 */
describe('Phone number normalization (e2e)', () => {
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

  it('registers with one phone form and logs in with every other accepted form', async () => {
    const canonical = '+251933445566';
    const localForms = ['0933445566', '933445566', '251933445566', '+251933445566'];

    await request(ctx.server)
      .post('/auth/register')
      .send({ phone: '0933445566', password: STRONG_PASSWORD })
      .expect(201);
    await ctx.drainOutbox();

    // Verify using a *different* local form than the one used to register.
    const code = ctx.notifications.lastCodeFor(canonical, 'otp-register');
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: '933445566', code, purpose: 'REGISTER' })
      .expect(201);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { phone: canonical } });
    expect(stored.phoneVerifiedAt).not.toBeNull();

    for (const form of localForms) {
      await request(ctx.server)
        .post('/auth/login')
        .send({ identifier: form, password: STRONG_PASSWORD, deviceInfo: DEVICE })
        .expect(201);
    }
  });

  it('normalizes the identifier for the password-reset OTP as well', async () => {
    await request(ctx.server)
      .post('/auth/register')
      .send({ phone: '0977112233', password: STRONG_PASSWORD })
      .expect(201);
    await ctx.drainOutbox();
    const registerCode = ctx.notifications.lastCodeFor('+251977112233', 'otp-register');
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: '0977112233', code: registerCode, purpose: 'REGISTER' })
      .expect(201);

    // Request the reset with one local form...
    await request(ctx.server)
      .post('/auth/password/forgot')
      .send({ identifier: '977112233' })
      .expect(201);
    const resetCode = ctx.notifications.lastCodeFor('+251977112233', 'otp-reset');

    // ...and complete it with a different one.
    await request(ctx.server)
      .post('/auth/password/reset')
      .send({ identifier: '+251977112233', code: resetCode, newPassword: 'AnotherStr0ngPass' })
      .expect(201);

    await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: '0977112233', password: 'AnotherStr0ngPass', deviceInfo: DEVICE })
      .expect(201);
  });
});
