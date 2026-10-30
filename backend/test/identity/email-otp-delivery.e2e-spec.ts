import request from 'supertest';
import { NOTIFICATION_PORT } from '../../src/modules/identity/application/ports/notification.port';
import { OTP_SERVICE } from '../../src/modules/identity/application/ports/otp.service';
import { AccountStatus, OtpPurpose } from '../../src/modules/identity/domain/enums';
import { InMemoryOtpService } from '../../src/modules/identity/infrastructure/otp/in-memory-otp.service';
import { IdentityNotificationAdapter } from '../../src/modules/identity/infrastructure/messaging/identity-notification.adapter';
import { InMemoryEmailTransport } from '../../src/modules/notifications/infrastructure/email/in-memory-email.transport';
import { EMAIL_TRANSPORT } from '../../src/shared/email/email-transport.port';
import { body, DEVICE, errorOf, STRONG_PASSWORD, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 62: the e-mail OTP journey through the real Module 01 delivery adapter
 * (`IdentityNotificationAdapter`) and the platform's shared `EMAIL_TRANSPORT` — the same token
 * Module 13 uses. Only the transport is replaced, by the in-memory one: no network, no real
 * e-mail. Codes are read out of the message text, the way a user reads their inbox.
 */
describe('E-mail OTP delivery (e2e)', () => {
  let ctx: TestContext;
  const mailer = new InMemoryEmailTransport();
  let counter = 0;
  const uniqueEmail = () => `user${Date.now()}${(counter += 1)}@Example.com`;
  const lower = (email: string) => email.toLowerCase();

  beforeAll(async () => {
    ctx = await createTestApp([
      { provide: NOTIFICATION_PORT, useClass: IdentityNotificationAdapter },
      { provide: EMAIL_TRANSPORT, useValue: mailer },
    ]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    mailer.sent.length = 0;
    mailer.script.clear();
    mailer.configured = true;
  });

  const mailTo = (address: string) => mailer.sent.filter((s) => s.message.to === lower(address)).map((s) => s.message);
  const codeIn = (text: string) => /Your PharmaLink code is (\d{6})/.exec(text)?.[1] ?? null;
  const lastCode = (address: string, subject: string) => {
    const message = [...mailTo(address)].reverse().find((m) => m.subject === subject);
    if (!message) throw new Error(`no "${subject}" e-mail to ${address}; sent: ${mailer.sent.map((s) => s.message.subject).join(', ')}`);
    return codeIn(message.text)!;
  };
  const clearCooldowns = () => (ctx.app.get(OTP_SERVICE) as InMemoryOtpService).clear();

  it('wires Module 01 to the shared transport: the real adapter, the same transport instance as Module 13', () => {
    expect(ctx.app.get(NOTIFICATION_PORT)).toBeInstanceOf(IdentityNotificationAdapter);
    expect(ctx.app.get(EMAIL_TRANSPORT)).toBe(mailer);
  });

  it('register by e-mail → code by e-mail → verify → active account and a session', async () => {
    const email = uniqueEmail();
    const registered = await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    expect(body(registered)).toMatchObject({ status: AccountStatus.PENDING_VERIFICATION, verification: { channel: 'EMAIL' } });
    expect(JSON.stringify(body(registered))).not.toContain(lower(email));

    await ctx.drainOutbox();
    const code = lastCode(email, 'Your PharmaLink verification code');
    expect(code).toMatch(/^\d{6}$/);
    expect(mailTo(email)[0].text).toContain('expires in 5 minutes');

    const verified = await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: email, code, purpose: OtpPurpose.REGISTER, deviceInfo: DEVICE })
      .expect(201);
    const tokens = (body(verified).tokens ?? {}) as { accessToken?: string };
    expect(tokens.accessToken).toEqual(expect.any(String));

    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: body(registered).userId as string } });
    expect(stored.status).toBe(AccountStatus.ACTIVE);
    expect(stored.emailVerifiedAt).not.toBeNull();
    expect(stored.faydaVerifiedAt).toBeNull();

    const me = await request(ctx.server).get('/users/me').set('Authorization', `Bearer ${tokens.accessToken}`).expect(200);
    expect(body(me)).toMatchObject({ faydaVerified: false, status: AccountStatus.ACTIVE });
    expect(await ctx.prisma.verificationRequest.count({ where: { userId: stored.id } })).toBe(0);

    // Single use: the same code again is refused.
    const replay = await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(410);
    expect(errorOf(replay).code).toBe('AUTH_OTP_EXPIRED');
  });

  it('e-mail plus phone: the code goes to the e-mail address only, and e-mail verification activates the account', async () => {
    const email = uniqueEmail();
    const phone = uniquePhone();
    const registered = await request(ctx.server).post('/auth/register').send({ email, phone, password: STRONG_PASSWORD }).expect(201);
    expect(body(registered)).toMatchObject({ verification: { channel: 'EMAIL' } });
    await ctx.drainOutbox();

    expect(mailer.sent.map((s) => s.message.to)).toEqual([lower(email)]);
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: email, code: lastCode(email, 'Your PharmaLink verification code'), purpose: OtpPurpose.REGISTER })
      .expect(201);
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: body(registered).userId as string } });
    expect(stored.status).toBe(AccountStatus.ACTIVE);
    expect(stored.phoneVerifiedAt).toBeNull();
    expect(stored.faydaVerifiedAt).toBeNull();
  });

  it('phone-only registration is refused while SMS has no provider, and no account is created', async () => {
    const phone = uniquePhone();
    const res = await request(ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'email', reason: 'SMS_UNAVAILABLE' } });
    expect(await ctx.prisma.user.count({ where: { phone } })).toBe(0);
    expect(await ctx.prisma.outbox.count()).toBe(0);
  });

  it('an OTP for a phone number fails clearly instead of reporting it sent', async () => {
    const res = await request(ctx.server).post('/auth/resend-otp').send({ identifier: uniquePhone(), purpose: OtpPurpose.LOGIN }).expect(503);
    expect(res.body.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', details: { channel: 'SMS', reason: 'NOT_CONFIGURED' } });
    expect(mailer.sent).toHaveLength(0);
  });

  it('resend: delivered by e-mail, refused during the cooldown, and purposes stay isolated', async () => {
    const email = uniqueEmail();
    await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    await ctx.drainOutbox();
    const registerCode = lastCode(email, 'Your PharmaLink verification code');

    const again = await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.REGISTER }).expect(429);
    expect(errorOf(again).code).toBe('RATE_LIMITED');
    expect(mailTo(email)).toHaveLength(1);

    const login = await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.LOGIN }).expect(201);
    expect(body(login)).toEqual({ resent: true, cooldownSeconds: expect.any(Number) });
    const loginCode = lastCode(email, 'Your PharmaLink sign-in code');

    if (loginCode !== registerCode) {
      const crossed = await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code: loginCode, purpose: OtpPurpose.REGISTER }).expect(400);
      expect(errorOf(crossed).code).toBe('AUTH_OTP_INVALID');
    }
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code: registerCode, purpose: OtpPurpose.REGISTER }).expect(201);
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code: loginCode, purpose: OtpPurpose.LOGIN, deviceInfo: DEVICE }).expect(201);
  });

  it('password reset by e-mail: code, reset, security notice, new password works; unknown address gets the same answer and no mail', async () => {
    const email = uniqueEmail();
    await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    await ctx.drainOutbox();
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: email, code: lastCode(email, 'Your PharmaLink verification code'), purpose: OtpPurpose.REGISTER })
      .expect(201);

    const known = await request(ctx.server).post('/auth/password/forgot').send({ identifier: email });
    const unknownAddress = uniqueEmail();
    const unknown = await request(ctx.server).post('/auth/password/forgot').send({ identifier: unknownAddress });
    expect([known.status, unknown.status]).toEqual([201, 201]);
    expect(body(known)).toEqual(body(unknown));
    expect(mailTo(unknownAddress)).toHaveLength(0);

    const code = lastCode(email, 'Your PharmaLink password reset code');
    const newPassword = 'An0therStr0ngPass';
    await request(ctx.server).post('/auth/password/reset').send({ identifier: email, code, newPassword }).expect(201);

    const notice = mailTo(email).find((m) => m.subject === 'Your PharmaLink password was reset');
    expect(notice?.text).toContain('signed out of every device');
    expect(codeIn(notice!.text)).toBeNull();

    await request(ctx.server).post('/auth/login').send({ identifier: email, password: newPassword, deviceInfo: DEVICE }).expect(201);
  });

  it('a send the provider does not accept is a 503 with the cooldown, never a success; the user recovers with resend', async () => {
    const email = uniqueEmail();
    await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    mailer.script.set(lower(email), { kind: 'TRANSIENT', code: 'EMAIL_TIMEOUT' });
    await ctx.drainOutbox(); // the registration handler's send fails; logged, not retried

    clearCooldowns();
    const failed = await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.REGISTER }).expect(503);
    expect(failed.body.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', details: { channel: 'EMAIL', reason: 'FAILED', retryAfterSeconds: expect.any(Number) } });
    expect(failed.body.data ?? null).toBeNull();

    // The undelivered code exists and its cooldown runs: an immediate retry is refused, not re-sent.
    await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.REGISTER }).expect(429);

    // Once the provider works and the cooldown has passed, a new code replaces the undelivered one.
    mailer.script.clear();
    clearCooldowns();
    await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.REGISTER }).expect(201);
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: email, code: lastCode(email, 'Your PharmaLink verification code'), purpose: OtpPurpose.REGISTER })
      .expect(201);
  });

  it.each([
    ['rejected', { kind: 'REJECTED', code: 'EMAIL_REJECTED' } as const],
    ['credentials refused', { kind: 'NOT_CONFIGURED' } as const],
    ['transport threw', 'THROW' as const],
  ])('resend reports a %s send as 503', async (_name, behaviour) => {
    const email = uniqueEmail();
    mailer.script.set(lower(email), behaviour);
    const res = await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.LOGIN }).expect(503);
    expect(errorOf(res).code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('with no e-mail provider: registration refused before any account exists, resend and forgot refused before any code is issued', async () => {
    mailer.configured = false;
    const email = uniqueEmail();

    const reg = await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(503);
    expect(reg.body.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', details: { channel: 'EMAIL', reason: 'NOT_CONFIGURED' } });
    expect(await ctx.prisma.user.count({ where: { email: lower(email) } })).toBe(0);

    await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.LOGIN }).expect(503);
    for (const identifier of [email, uniqueEmail()]) {
      const forgot = await request(ctx.server).post('/auth/password/forgot').send({ identifier }).expect(503);
      expect(errorOf(forgot).code).toBe('DEPENDENCY_UNAVAILABLE');
    }
    expect(mailer.sent).toHaveLength(0);

    // Nothing was issued, so restoring the provider allows an immediate request (no cooldown started).
    mailer.configured = true;
    await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.LOGIN }).expect(201);
  });

  it('forgot-password keeps the generic answer when the e-mail to a known account fails', async () => {
    const email = uniqueEmail();
    await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    mailer.script.set(lower(email), { kind: 'REJECTED', code: 'EMAIL_REJECTED' });
    const known = await request(ctx.server).post('/auth/password/forgot').send({ identifier: email }).expect(201);
    const unknown = await request(ctx.server).post('/auth/password/forgot').send({ identifier: uniqueEmail() }).expect(201);
    expect(body(known)).toEqual(body(unknown));
  });

  it('no OTP code, address or provider detail reaches logs, responses or any persisted row', async () => {
    const writes: string[] = [];
    const streams = [process.stdout, process.stderr].map((s) =>
      jest.spyOn(s, 'write').mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof s.write),
    );
    const responses: string[] = [];
    const email = uniqueEmail();
    let codes: string[] = [];
    try {
      responses.push(JSON.stringify((await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD })).body));
      await ctx.drainOutbox();
      responses.push(JSON.stringify((await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.LOGIN })).body));
      responses.push(JSON.stringify((await request(ctx.server).post('/auth/password/forgot').send({ identifier: email })).body));
      mailer.script.set(lower(email), 'THROW');
      clearCooldowns();
      responses.push(JSON.stringify((await request(ctx.server).post('/auth/resend-otp').send({ identifier: email, purpose: OtpPurpose.REGISTER })).body));
      codes = mailer.sent.map((s) => codeIn(s.message.text)).filter((c): c is string => c !== null);
    } finally {
      for (const s of streams) s.mockRestore();
    }
    expect(codes.length).toBeGreaterThanOrEqual(3);

    const persisted = JSON.stringify([
      await ctx.prisma.outbox.findMany(),
      await ctx.prisma.auditLog.findMany(),
      await ctx.prisma.notification.findMany(),
      await ctx.prisma.notificationDeliveryJob.findMany(),
    ]);
    const everything = { logs: writes.join(''), responses: responses.join('\n'), persisted };
    for (const [where, text] of Object.entries(everything)) {
      for (const secret of [...codes, lower(email), 'FAKE_EMAIL_SECRET', 'relay refused']) {
        expect({ where, secret, found: text.includes(secret) }).toEqual({ where, secret, found: false });
      }
    }
    expect(everything.logs).toContain('Identity e-mail not delivered: template=otp-register result=TRANSIENT/EMAIL_ERROR');
  });
});
