import request from 'supertest';
import { AccountStatus, OtpPurpose } from '../../src/modules/identity/domain/enums';
import { body, errorOf, registerAndVerify, STRONG_PASSWORD, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/** Scenario 1: register → OTP generation → OTP verification → account activation. */
describe('Registration and OTP verification (e2e)', () => {
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

  it('registers a pending user, assigns the CUSTOMER role and delivers an OTP', async () => {
    const phone = uniquePhone();

    const res = await request(ctx.server)
      .post('/auth/register')
      .send({ phone, password: STRONG_PASSWORD })
      .expect(201);

    const data = body(res);
    expect(data.status).toBe(AccountStatus.PENDING_VERIFICATION);
    expect(data.verification).toMatchObject({ channel: 'SMS' });

    // The response must never echo the full phone number back.
    expect(JSON.stringify(data.verification)).not.toContain(phone);

    const stored = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: data.userId as string },
      include: { userRoles: { include: { role: true } } },
    });
    expect(stored.status).toBe(AccountStatus.PENDING_VERIFICATION);
    expect(stored.passwordHash).not.toBe(STRONG_PASSWORD);
    expect(stored.userRoles.map((ur) => ur.role.key)).toEqual(['CUSTOMER']);

    // OTP delivery is driven by the outbox → event bus → handler chain, not inline.
    expect(ctx.notifications.sent).toHaveLength(0);
    await ctx.drainOutbox();
    expect(ctx.notifications.lastCodeFor(phone, 'otp-register')).toMatch(/^\d{6}$/);

    const outbox = await ctx.prisma.outbox.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventType).toBe('identity.user.registered');
    expect(outbox[0].publishedAt).not.toBeNull();
  });

  it('activates the account once the OTP is verified', async () => {
    const user = await registerAndVerify(ctx);

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(stored.status).toBe(AccountStatus.ACTIVE);
    expect(stored.phoneVerifiedAt).not.toBeNull();
  });

  it('rejects a wrong OTP and leaves the account pending', async () => {
    const phone = uniquePhone();
    const res = await request(ctx.server)
      .post('/auth/register')
      .send({ phone, password: STRONG_PASSWORD })
      .expect(201);
    await ctx.drainOutbox();

    const wrong = await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: phone, code: '000000', purpose: OtpPurpose.REGISTER })
      .expect(400);

    expect(errorOf(wrong).code).toBe('AUTH_OTP_INVALID');

    const stored = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: body(res).userId as string },
    });
    expect(stored.status).toBe(AccountStatus.PENDING_VERIFICATION);
  });

  it('refuses a duplicate phone number', async () => {
    const phone = uniquePhone();
    await request(ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(201);

    const duplicate = await request(ctx.server)
      .post('/auth/register')
      .send({ phone, password: STRONG_PASSWORD })
      .expect(409);

    expect(errorOf(duplicate).code).toBe('AUTH_DUPLICATE_IDENTIFIER');
  });

  it('refuses a weak password before creating anything', async () => {
    const phone = uniquePhone();

    const res = await request(ctx.server)
      .post('/auth/register')
      .send({ phone, password: 'weakpass' })
      .expect(422);

    expect(errorOf(res).code).toBe('AUTH_WEAK_PASSWORD');
    expect(await ctx.prisma.user.count()).toBe(0);
  });
});
