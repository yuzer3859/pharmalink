import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { base32Decode, timeStepAt, totpForStep } from '../../src/modules/identity/domain/mfa/totp';
import { PERM_VERSION_STORE } from '../../src/modules/identity/application/ports/perm-version.port';
import { ITokenService, TOKEN_SERVICE } from '../../src/modules/identity/application/ports/token.service';
import { CachedPermVersionStore } from '../../src/modules/identity/infrastructure/security/cached-perm-version.store';
import {
  DEVICE,
  MfaChallenge,
  RegisteredUser,
  STRONG_PASSWORD,
  auth,
  body,
  createUserWithRole,
  errorOf,
  freshTotp,
  grantRoleDirect,
  login,
  registerAndVerify,
  testAuthenticators,
  uniquePhone,
} from '../support/fixtures';
import { TestContext, closeTestApp, createTestApp } from '../support/test-app';

/**
 * Work 66: mandatory administrator MFA, end to end against the real application and a disposable
 * PostgreSQL. Every session-issuing path is exercised: password login, the MFA endpoints, OTP
 * auto-login (REGISTER and LOGIN), refresh-token rotation and the access-token guard.
 */
describe('Administrator MFA (e2e)', () => {
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

  // --- helpers ------------------------------------------------------------------------------

  async function passwordLogin(identifier: string, device = DEVICE): Promise<request.Response> {
    return request(ctx.server)
      .post('/auth/login')
      .send({ identifier, password: STRONG_PASSWORD, deviceInfo: device })
      .expect(201);
  }

  /** A verified account holding a global (platform) role, not yet signed in. */
  async function adminAccount(roleKey: 'ADMIN' | 'SUPER_ADMIN'): Promise<RegisteredUser> {
    const user = await registerAndVerify(ctx);
    await grantRoleDirect(ctx, user.userId, roleKey);
    return user;
  }

  async function challengeFor(identifier: string): Promise<MfaChallenge> {
    const res = await passwordLogin(identifier);
    const data = body(res);
    expect(data).toMatchObject({ mfaRequired: true });
    return data.challenge as MfaChallenge;
  }

  async function startEnrollment(challenge: MfaChallenge): Promise<string> {
    const res = await request(ctx.server)
      .post('/auth/mfa/enrollment/start')
      .send({ challengeToken: challenge.token })
      .expect(200);
    return body(res).secret as string;
  }

  const codeNow = (secret: string, offset = 0) => totpForStep(base32Decode(secret), timeStepAt(Date.now()) + offset);
  const wrongCode = (secret: string) => (['000000', '111111', '222222'].find((c) => ![-1, 0, 1].some((o) => codeNow(secret, o) === c)) as string);

  function clearPermVersionCache(): void {
    ctx.app.get<CachedPermVersionStore>(PERM_VERSION_STORE).clear();
  }

  // --- password login -----------------------------------------------------------------------

  describe('password login', () => {
    it.each(['ADMIN', 'SUPER_ADMIN'] as const)(
      'gives an unenrolled %s (global role) an enrolment challenge and no tokens',
      async (roleKey) => {
        const admin = await adminAccount(roleKey);
        const res = await passwordLogin(admin.phone);
        const data = body(res);

        expect(data).toEqual({
          mfaRequired: true,
          challenge: { type: 'ENROLLMENT', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) },
        });
        expect(await ctx.prisma.refreshToken.count({ where: { userId: admin.userId } })).toBe(0);
        expect(await ctx.prisma.session.count({ where: { userId: admin.userId } })).toBe(0);
        const history = await ctx.prisma.loginHistory.findFirst({ where: { userId: admin.userId }, orderBy: { createdAt: 'desc' } });
        expect(history?.outcome).toBe('MFA_REQUIRED');
        // Only a hash of the challenge token is stored.
        expect(JSON.stringify(await ctx.prisma.adminMfaChallenge.findMany())).not.toContain(data.challenge && (data.challenge as MfaChallenge).token);
      },
    );

    it('treats primaryRole SUPER_ADMIN as an administrator even without a role assignment', async () => {
      const user = await registerAndVerify(ctx);
      await ctx.prisma.user.update({ where: { id: user.userId }, data: { primaryRole: 'SUPER_ADMIN' } });
      const res = await passwordLogin(user.phone);
      expect(body(res)).toMatchObject({ mfaRequired: true, challenge: { type: 'ENROLLMENT' } });
    });

    it.each(['ADMIN', 'SUPER_ADMIN'] as const)(
      'lets a %s sign in only after enrolling with a valid authenticator code',
      async (roleKey) => {
        const admin = await adminAccount(roleKey);
        const challenge = await challengeFor(admin.phone);
        const secret = await startEnrollment(challenge);

        // Not enough: the password and a started enrolment.
        await request(ctx.server)
          .post('/auth/mfa/enrollment/confirm')
          .send({ challengeToken: challenge.token, code: wrongCode(secret), deviceInfo: DEVICE })
          .expect(401);
        expect(await ctx.prisma.refreshToken.count({ where: { userId: admin.userId } })).toBe(0);

        const confirmed = await request(ctx.server)
          .post('/auth/mfa/enrollment/confirm')
          .send({ challengeToken: challenge.token, code: codeNow(secret), deviceInfo: DEVICE })
          .expect(200);
        const data = body(confirmed);
        expect(data.accessToken).toEqual(expect.any(String));
        expect(data.recoveryCodes).toHaveLength(10);

        await request(ctx.server).get('/admin/rbac/roles').set(...auth(data.accessToken as string)).expect(200);
        const status = await request(ctx.server).get('/auth/mfa/status').set(...auth(data.accessToken as string)).expect(200);
        expect(body(status)).toEqual({ required: true, enrolled: true, enabledAt: expect.any(String), recoveryCodesRemaining: 10 });
        const stored = await ctx.prisma.refreshToken.findFirstOrThrow({ where: { userId: admin.userId } });
        expect(stored.mfaVerifiedAt).not.toBeNull();
      },
    );

    it('requires an enrolled administrator to enter an authenticator code at every sign-in', async () => {
      const admin = await createUserWithRole(ctx, 'ADMIN');
      const challenge = await challengeFor(admin.phone);
      expect(challenge.type).toBe('TOTP');

      const secret = testAuthenticators.get(admin.phone)!;
      const res = await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: challenge.token, code: await freshTotp(ctx, admin.userId, secret), deviceInfo: DEVICE })
        .expect(200);
      await request(ctx.server).get('/admin/rbac/roles').set(...auth(body(res).accessToken as string)).expect(200);
    });
  });

  // --- challenge security -------------------------------------------------------------------

  describe('TOTP challenges', () => {
    it('rejects wrong codes and kills the challenge after five failures', async () => {
      const admin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      const secret = testAuthenticators.get(admin.phone)!;
      const challenge = await challengeFor(admin.phone);

      for (let i = 0; i < 5; i += 1) {
        const res = await request(ctx.server)
          .post('/auth/mfa/verify')
          .send({ challengeToken: challenge.token, code: wrongCode(secret), deviceInfo: DEVICE })
          .expect(401);
        expect(errorOf(res).code).toBe('AUTH_MFA_CODE_INVALID');
      }
      const res = await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: challenge.token, code: await freshTotp(ctx, admin.userId, secret), deviceInfo: DEVICE })
        .expect(401);
      expect(errorOf(res).code).toBe('AUTH_MFA_CHALLENGE_INVALID');
    });

    it('answers concurrent wrong codes as wrong codes (never a server error) and counts each one', async () => {
      const admin = await createUserWithRole(ctx, 'ADMIN');
      const secret = testAuthenticators.get(admin.phone)!;
      const challenge = await challengeFor(admin.phone);

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(ctx.server)
            .post('/auth/mfa/verify')
            .send({ challengeToken: challenge.token, code: wrongCode(secret), deviceInfo: DEVICE }),
        ),
      );

      expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401]);
      expect(results.every((r) => errorOf(r).code === 'AUTH_MFA_CODE_INVALID')).toBe(true);
      const stored = await ctx.prisma.adminMfaChallenge.findFirstOrThrow({ where: { userId: admin.userId, consumedAt: null } });
      expect(stored.attempts).toBe(4);
    });

    it('refuses a time step that was already accepted', async () => {
      const admin = await adminAccount('ADMIN');
      const enrollment = await challengeFor(admin.phone);
      const secret = await startEnrollment(enrollment);
      const code = codeNow(secret);
      await request(ctx.server)
        .post('/auth/mfa/enrollment/confirm')
        .send({ challengeToken: enrollment.token, code, deviceInfo: DEVICE })
        .expect(200);

      const challenge = await challengeFor(admin.phone);
      const replay = await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: challenge.token, code, deviceInfo: DEVICE })
        .expect(401);
      expect(errorOf(replay).code).toBe('AUTH_MFA_CODE_INVALID');
    });

    it('issues one session when the same challenge and code are submitted concurrently', async () => {
      const admin = await createUserWithRole(ctx, 'ADMIN');
      const secret = testAuthenticators.get(admin.phone)!;
      const challenge = await challengeFor(admin.phone);
      const code = await freshTotp(ctx, admin.userId, secret);
      const before = await ctx.prisma.refreshToken.count({ where: { userId: admin.userId } });

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(ctx.server).post('/auth/mfa/verify').send({ challengeToken: challenge.token, code, deviceInfo: DEVICE }),
        ),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(3);
      expect(await ctx.prisma.refreshToken.count({ where: { userId: admin.userId } })).toBe(before + 1);
    });

    it('issues one session when one code is used on two challenges concurrently', async () => {
      const admin = await createUserWithRole(ctx, 'ADMIN');
      const secret = testAuthenticators.get(admin.phone)!;
      const first = await challengeFor(admin.phone);
      const second = await challengeFor(admin.phone);
      const code = await freshTotp(ctx, admin.userId, secret);

      const results = await Promise.all(
        [first, second].map((c) =>
          request(ctx.server).post('/auth/mfa/verify').send({ challengeToken: c.token, code, deviceInfo: DEVICE }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('rejects consumed, expired, unknown and malformed challenges without issuing tokens', async () => {
      const admin = await createUserWithRole(ctx, 'ADMIN');
      const secret = testAuthenticators.get(admin.phone)!;

      const consumed = await challengeFor(admin.phone);
      await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: consumed.token, code: await freshTotp(ctx, admin.userId, secret), deviceInfo: DEVICE })
        .expect(200);
      const tokensBefore = await ctx.prisma.refreshToken.count();

      const again = await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: consumed.token, code: await freshTotp(ctx, admin.userId, secret), deviceInfo: DEVICE })
        .expect(401);
      expect(errorOf(again).code).toBe('AUTH_MFA_CHALLENGE_INVALID');

      const expired = await challengeFor(admin.phone);
      await ctx.prisma.adminMfaChallenge.updateMany({ where: { consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const late = await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: expired.token, code: await freshTotp(ctx, admin.userId, secret), deviceInfo: DEVICE })
        .expect(401);
      expect(errorOf(late).code).toBe('AUTH_MFA_CHALLENGE_INVALID');

      const unknown = await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: 'A'.repeat(43), code: '123456', deviceInfo: DEVICE })
        .expect(401);
      expect(errorOf(unknown).code).toBe('AUTH_MFA_CHALLENGE_INVALID');

      for (const malformed of ['short', 'A'.repeat(42) + '!', '']) {
        await request(ctx.server)
          .post('/auth/mfa/verify')
          .send({ challengeToken: malformed, code: '123456', deviceInfo: DEVICE })
          .expect(400);
      }
      // A caller-supplied user id is not accepted anywhere.
      await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: 'A'.repeat(43), code: '123456', deviceInfo: DEVICE, userId: admin.userId })
        .expect(400);

      expect(await ctx.prisma.refreshToken.count()).toBe(tokensBefore);
    });

    it('does not let a challenge token act as an access token', async () => {
      const admin = await adminAccount('ADMIN');
      const challenge = await challengeFor(admin.phone);
      const res = await request(ctx.server).get('/auth/mfa/status').set(...auth(challenge.token)).expect(401);
      expect(errorOf(res).code).toBe('AUTH_TOKEN_INVALID');
    });
  });

  // --- recovery -----------------------------------------------------------------------------

  describe('recovery codes', () => {
    async function enrolledAdmin() {
      const admin = await adminAccount('ADMIN');
      const challenge = await challengeFor(admin.phone);
      const secret = await startEnrollment(challenge);
      const res = await request(ctx.server)
        .post('/auth/mfa/enrollment/confirm')
        .send({ challengeToken: challenge.token, code: codeNow(secret), deviceInfo: DEVICE })
        .expect(200);
      const data = body(res);
      return { admin, secret, recoveryCodes: data.recoveryCodes as string[], tokens: data };
    }

    it('stores only hashes, and each code works once', async () => {
      const { admin, recoveryCodes } = await enrolledAdmin();
      const stored = await ctx.prisma.adminMfaRecoveryCode.findMany({ where: { userId: admin.userId } });
      expect(stored).toHaveLength(10);
      const dump = JSON.stringify(stored);
      for (const code of recoveryCodes) {
        expect(dump).not.toContain(code);
        expect(dump).not.toContain(code.replace(/-/g, ''));
      }

      const first = await challengeFor(admin.phone);
      await request(ctx.server).post('/auth/mfa/recovery').send({ challengeToken: first.token, recoveryCode: recoveryCodes[0] }).expect(200);

      const second = await challengeFor(admin.phone);
      const reuse = await request(ctx.server)
        .post('/auth/mfa/recovery')
        .send({ challengeToken: second.token, recoveryCode: recoveryCodes[0] })
        .expect(401);
      expect(errorOf(reuse).code).toBe('AUTH_MFA_CODE_INVALID');
    });

    it('forces a replacement authenticator before any session, then issues fresh codes', async () => {
      const { admin, secret: oldSecret, recoveryCodes, tokens } = await enrolledAdmin();

      const challenge = await challengeFor(admin.phone);
      const recovered = await request(ctx.server)
        .post('/auth/mfa/recovery')
        .send({ challengeToken: challenge.token, recoveryCode: recoveryCodes[1].toLowerCase() })
        .expect(200);
      const replacement = body(recovered);
      expect(replacement).toEqual({
        mfaRequired: true,
        challenge: { type: 'ENROLLMENT', reason: 'RECOVERY', token: expect.any(String), expiresAt: expect.any(String) },
      });
      expect(replacement).not.toHaveProperty('accessToken');
      const replacementChallenge = replacement.challenge as MfaChallenge;

      // The replacement challenge is not a sign-in challenge.
      await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: replacementChallenge.token, code: await freshTotp(ctx, admin.userId, oldSecret), deviceInfo: DEVICE })
        .expect(401);

      const newSecret = await startEnrollment(replacementChallenge);
      expect(newSecret).not.toBe(oldSecret);
      const confirmed = await request(ctx.server)
        .post('/auth/mfa/enrollment/confirm')
        .send({ challengeToken: replacementChallenge.token, code: codeNow(newSecret), deviceInfo: DEVICE })
        .expect(200);
      const fresh = body(confirmed);
      expect(fresh.recoveryCodes).toHaveLength(10);
      expect(fresh.recoveryCodes).not.toContain(recoveryCodes[2]);

      // Sessions from the old authenticator are gone.
      await request(ctx.server).post('/auth/token/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
      await request(ctx.server).get('/auth/mfa/status').set(...auth(tokens.accessToken as string)).expect(401);
      await request(ctx.server).get('/auth/mfa/status').set(...auth(fresh.accessToken as string)).expect(200);

      // The old authenticator no longer signs in; the new one does.
      const next = await challengeFor(admin.phone);
      const oldCode = codeNow(oldSecret, 1);
      if (![-1, 0, 1].some((o) => codeNow(newSecret, o) === oldCode)) {
        await request(ctx.server)
          .post('/auth/mfa/verify')
          .send({ challengeToken: next.token, code: oldCode, deviceInfo: DEVICE })
          .expect(401);
      }
      await request(ctx.server)
        .post('/auth/mfa/verify')
        .send({ challengeToken: next.token, code: await freshTotp(ctx, admin.userId, newSecret), deviceInfo: DEVICE })
        .expect(200);
    });

    it('rotates recovery codes only with a current authenticator code', async () => {
      const { admin, secret, recoveryCodes, tokens } = await enrolledAdmin();
      const token = tokens.accessToken as string;

      await request(ctx.server).post('/auth/mfa/recovery-codes/rotate').set(...auth(token)).send({}).expect(400);
      const wrong = await request(ctx.server)
        .post('/auth/mfa/recovery-codes/rotate')
        .set(...auth(token))
        .send({ code: wrongCode(secret) })
        .expect(401);
      expect(errorOf(wrong).code).toBe('AUTH_MFA_CODE_INVALID');

      const rotated = await request(ctx.server)
        .post('/auth/mfa/recovery-codes/rotate')
        .set(...auth(token))
        .send({ code: await freshTotp(ctx, admin.userId, secret) })
        .expect(200);
      const fresh = body(rotated).recoveryCodes as string[];
      expect(fresh).toHaveLength(10);

      // The old codes are void.
      const challenge = await challengeFor(admin.phone);
      await request(ctx.server)
        .post('/auth/mfa/recovery')
        .send({ challengeToken: challenge.token, recoveryCode: recoveryCodes[0] })
        .expect(401);
    });
  });

  // --- other session paths ------------------------------------------------------------------

  describe('OTP auto-login', () => {
    it('verifies a REGISTER code for an administrator without issuing a session', async () => {
      const phone = uniquePhone();
      const registered = await request(ctx.server).post('/auth/register').send({ phone, password: STRONG_PASSWORD }).expect(201);
      const userId = body(registered).userId as string;
      await grantRoleDirect(ctx, userId, 'SUPER_ADMIN');
      await ctx.drainOutbox();
      const code = ctx.notifications.lastCodeFor(phone, 'otp-register');

      const res = await request(ctx.server)
        .post('/auth/verify-otp')
        .send({ identifier: phone, code, purpose: OtpPurpose.REGISTER, deviceInfo: DEVICE })
        .expect(201);

      expect(body(res)).toEqual({ verified: true, mfaRequired: true });
      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(stored.status).toBe('ACTIVE');
      expect(await ctx.prisma.refreshToken.count({ where: { userId } })).toBe(0);
    });

    it('does not let an OTP LOGIN code sign an administrator in', async () => {
      const admin = await adminAccount('ADMIN');
      await request(ctx.server).post('/auth/resend-otp').send({ identifier: admin.phone, purpose: OtpPurpose.LOGIN }).expect(201);
      const code = ctx.notifications.lastCodeFor(admin.phone, 'otp-login');

      const res = await request(ctx.server)
        .post('/auth/verify-otp')
        .send({ identifier: admin.phone, code, purpose: OtpPurpose.LOGIN, deviceInfo: DEVICE })
        .expect(201);

      expect(body(res)).toEqual({ verified: true, mfaRequired: true });
      expect(await ctx.prisma.refreshToken.count({ where: { userId: admin.userId } })).toBe(0);
    });

    it('still signs a customer in after an OTP LOGIN code', async () => {
      const customer = await registerAndVerify(ctx);
      await request(ctx.server).post('/auth/resend-otp').send({ identifier: customer.phone, purpose: OtpPurpose.LOGIN }).expect(201);
      const code = ctx.notifications.lastCodeFor(customer.phone, 'otp-login');
      const res = await request(ctx.server)
        .post('/auth/verify-otp')
        .send({ identifier: customer.phone, code, purpose: OtpPurpose.LOGIN, deviceInfo: DEVICE })
        .expect(201);
      expect((body(res).tokens as Record<string, unknown>).accessToken).toEqual(expect.any(String));
    });
  });

  describe('refresh tokens and access tokens', () => {
    it('keeps an MFA-verified administrator session refreshable, with its assurance', async () => {
      const admin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      const res = await request(ctx.server).post('/auth/token/refresh').send({ refreshToken: admin.refreshToken }).expect(201);
      await request(ctx.server).get('/admin/rbac/roles').set(...auth(body(res).accessToken as string)).expect(200);
    });

    it('rejects a legacy administrator refresh token without MFA assurance and revokes its family', async () => {
      const admin = await createUserWithRole(ctx, 'ADMIN');
      // As every refresh token that existed before the Work 66 migration.
      await ctx.prisma.refreshToken.updateMany({ where: { userId: admin.userId }, data: { mfaVerifiedAt: null } });

      const res = await request(ctx.server).post('/auth/token/refresh').send({ refreshToken: admin.refreshToken }).expect(401);
      expect(errorOf(res).code).toBe('AUTH_MFA_REQUIRED');
      const family = await ctx.prisma.refreshToken.findMany({ where: { userId: admin.userId } });
      expect(family.every((t) => t.revokedAt !== null)).toBe(true);
    });

    it('keeps customer refresh working normally', async () => {
      const customer = await createUserWithRole(ctx, 'CUSTOMER');
      const res = await request(ctx.server).post('/auth/token/refresh').send({ refreshToken: customer.refreshToken }).expect(201);
      const next = body(res);
      await request(ctx.server).get('/auth/sessions').set(...auth(next.accessToken as string)).expect(200);
      await request(ctx.server).post('/auth/token/refresh').send({ refreshToken: next.refreshToken }).expect(201);
    });

    it('does not let a promoted user keep access through pre-promotion tokens', async () => {
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      const customer = await createUserWithRole(ctx, 'CUSTOMER');

      await request(ctx.server)
        .post(`/admin/users/${customer.userId}/roles`)
        .set(...auth(superAdmin.accessToken))
        .send({ roleKey: 'ADMIN' })
        .expect(201);

      const stale = await request(ctx.server).get('/auth/sessions').set(...auth(customer.accessToken)).expect(401);
      expect(errorOf(stale).code).toBe('TOKEN_EXPIRED');
      const refresh = await request(ctx.server).post('/auth/token/refresh').send({ refreshToken: customer.refreshToken }).expect(401);
      expect(errorOf(refresh).code).toBe('AUTH_MFA_REQUIRED');

      // The next sign-in demands MFA enrolment.
      expect((await challengeFor(customer.phone)).type).toBe('ENROLLMENT');
    });

    it('refuses an administrator access token without MFA assurance even at the current permVersion', async () => {
      const customer = await createUserWithRole(ctx, 'CUSTOMER');
      // Promoted behind the API's back (no permVersion bump): the guard still checks current roles.
      await grantRoleDirect(ctx, customer.userId, 'ADMIN');
      clearPermVersionCache();

      const res = await request(ctx.server).get('/auth/sessions').set(...auth(customer.accessToken)).expect(401);
      expect(errorOf(res).code).toBe('AUTH_MFA_REQUIRED');
    });

    it('invalidates pre-existing administrator access tokens with the rollout statement', async () => {
      const admin = await adminAccount('ADMIN');
      const superAdmin = await registerAndVerify(ctx);
      await ctx.prisma.user.update({ where: { id: superAdmin.userId }, data: { primaryRole: 'SUPER_ADMIN' } });
      const customer = await createUserWithRole(ctx, 'CUSTOMER');
      const versions = async () =>
        Object.fromEntries(
          (await ctx.prisma.user.findMany({ select: { id: true, permVersion: true } })).map((u) => [u.id, u.permVersion]),
        );
      const before = await versions();

      // An access token as minted before Work 66: current permVersion, no MFA claim.
      const tokens = ctx.app.get<ITokenService>(TOKEN_SERVICE);
      const legacy = tokens.issueAccessToken({ sub: admin.userId, permissions: ['*'], permVersion: before[admin.userId] }, 900).token;
      const rejected = await request(ctx.server).get('/auth/sessions').set(...auth(legacy)).expect(401);
      expect(errorOf(rejected).code).toBe('AUTH_MFA_REQUIRED');

      const migration = readFileSync(
        join(__dirname, '../../prisma/schema/migrations/20261102000000_module01_admin_mfa/migration.sql'),
        'utf8',
      );
      const rollout = migration.split('-- rollout:begin')[1].split('-- rollout:end')[0];
      await ctx.prisma.$executeRawUnsafe(rollout);
      clearPermVersionCache();

      const after = await versions();
      expect(after[admin.userId]).toBe(before[admin.userId] + 1);
      expect(after[superAdmin.userId]).toBe(before[superAdmin.userId] + 1);
      expect(after[customer.userId]).toBe(before[customer.userId]);

      const expired = await request(ctx.server).get('/auth/sessions').set(...auth(legacy)).expect(401);
      expect(errorOf(expired).code).toBe('TOKEN_EXPIRED');
      await request(ctx.server).get('/auth/sessions').set(...auth(customer.accessToken)).expect(200);
    });
  });

  describe('who is a platform administrator', () => {
    it('does not classify a customer or a pharmacy employee as one', async () => {
      for (const roleKey of ['CUSTOMER', 'PHARMACY_OWNER', 'FINANCE_OFFICER']) {
        const user = await createUserWithRole(ctx, roleKey);
        expect(user.accessToken).toEqual(expect.any(String));
        const status = await request(ctx.server).get('/auth/mfa/status').set(...auth(user.accessToken)).expect(200);
        expect(body(status)).toEqual({ required: false, enrolled: false, enabledAt: null, recoveryCodesRemaining: 0 });
      }
    });

    it('does not treat an organisation-scoped ADMIN assignment as a platform administrator', async () => {
      const owner = await registerAndVerify(ctx);
      const org = await ctx.prisma.organization.create({ data: { type: 'PHARMACY', name: 'Scoped Pharmacy', ownerUserId: owner.userId } });
      const user = await registerAndVerify(ctx);
      await grantRoleDirect(ctx, user.userId, 'ADMIN', org.id);
      await grantRoleDirect(ctx, user.userId, 'PHARMACY_OWNER', org.id);

      const res = await passwordLogin(user.phone);
      expect(body(res).accessToken).toEqual(expect.any(String));
      expect(body(res)).not.toHaveProperty('mfaRequired');
    });

    it('signs a pharmacy owner into the pharmacy portal as before', async () => {
      const owner = await registerAndVerify(ctx);
      const org = await ctx.prisma.organization.create({ data: { type: 'PHARMACY', name: 'Owner Pharmacy', ownerUserId: owner.userId } });
      await grantRoleDirect(ctx, owner.userId, 'PHARMACY_OWNER', org.id);
      const tokens = await login(ctx, owner.phone);
      const me = await request(ctx.server).get('/users/me').set(...auth(tokens.accessToken)).expect(200);
      expect(body(me).roles).toEqual(expect.arrayContaining([expect.objectContaining({ roleKey: 'PHARMACY_OWNER', organizationId: org.id })]));
    });
  });

  describe('secret material', () => {
    it('never appears in audit entries, login history or error responses', async () => {
      const admin = await adminAccount('SUPER_ADMIN');
      const challenge = await challengeFor(admin.phone);
      const started = await request(ctx.server)
        .post('/auth/mfa/enrollment/start')
        .send({ challengeToken: challenge.token })
        .expect(200);
      const { secret, otpauthUri } = body(started) as { secret: string; otpauthUri: string };
      const failed = await request(ctx.server)
        .post('/auth/mfa/enrollment/confirm')
        .send({ challengeToken: challenge.token, code: wrongCode(secret), deviceInfo: DEVICE })
        .expect(401);
      const confirmed = await request(ctx.server)
        .post('/auth/mfa/enrollment/confirm')
        .send({ challengeToken: challenge.token, code: codeNow(secret), deviceInfo: DEVICE })
        .expect(200);
      const recoveryCodes = body(confirmed).recoveryCodes as string[];
      const next = await challengeFor(admin.phone);
      await request(ctx.server).post('/auth/mfa/recovery').send({ challengeToken: next.token, recoveryCode: recoveryCodes[0] }).expect(200);

      const secrets = [secret, otpauthUri, challenge.token, next.token, ...recoveryCodes, ...recoveryCodes.map((c) => c.replace(/-/g, ''))];
      const persisted = JSON.stringify([
        await ctx.prisma.auditLog.findMany(),
        await ctx.prisma.loginHistory.findMany(),
        await ctx.prisma.adminMfaCredential.findMany({ select: { encryptedSecret: true } }),
        await ctx.prisma.adminMfaChallenge.findMany(),
      ]);
      const responses = JSON.stringify([failed.body, errorOf(failed)]);
      for (const value of secrets) {
        expect(persisted).not.toContain(value);
        expect(responses).not.toContain(value);
      }
      expect(JSON.stringify(body(confirmed))).not.toContain(secret);
    });
  });
});
