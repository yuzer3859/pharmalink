import request from 'supertest';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { base32Decode, timeStepAt, totpForStep } from '../../src/modules/identity/domain/mfa/totp';
import { TestContext } from './test-app';

export const DEVICE = { fingerprint: 'e2e-device-fingerprint', platform: 'ANDROID' as const };
export const SECOND_DEVICE = { fingerprint: 'e2e-device-second', platform: 'IOS' as const };
export const STRONG_PASSWORD = 'Str0ngPassw0rd';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface RegisteredUser {
  userId: string;
  /** Canonical E.164 form, i.e. what the platform stored. */
  phone: string;
  password: string;
}

/** Unique ET mobile number per call, so tests never collide on the unique phone constraint. */
let phoneCounter = 0;
export function uniquePhone(): string {
  phoneCounter += 1;
  return `+2519${String(10_000_000 + phoneCounter).padStart(8, '0')}`;
}

export function body(res: request.Response): Record<string, unknown> {
  return (res.body as { data: Record<string, unknown> }).data;
}

export function errorOf(res: request.Response): { code: string; message: string } {
  return (res.body as { error: { code: string; message: string } }).error;
}

/**
 * Registers a user and completes OTP verification through the real HTTP surface, reading the
 * code out of the recorded notification exactly as a user would read their SMS.
 */
export async function registerAndVerify(
  ctx: TestContext,
  options: { phone?: string; password?: string } = {},
): Promise<RegisteredUser> {
  const phone = options.phone ?? uniquePhone();
  const password = options.password ?? STRONG_PASSWORD;

  const registration = await request(ctx.server)
    .post('/auth/register')
    .send({ phone, password })
    .expect(201);

  // Registration only writes the outbox row; the relay is what triggers OTP delivery.
  await ctx.drainOutbox();

  const code = ctx.notifications.lastCodeFor(phone, 'otp-register');

  await request(ctx.server)
    .post('/auth/verify-otp')
    .send({ identifier: phone, code, purpose: OtpPurpose.REGISTER })
    .expect(201);

  return { userId: body(registration).userId as string, phone, password };
}

/**
 * Signs in through the real HTTP surface. A platform administrator gets an MFA challenge instead of
 * tokens (Work 66); this completes it the way an operator would, with an authenticator app: the
 * first time by enrolling (the secret is kept in `testAuthenticators`), afterwards with a TOTP code.
 */
export async function login(
  ctx: TestContext,
  identifier: string,
  password: string = STRONG_PASSWORD,
  device: { fingerprint: string; platform: string } = DEVICE,
): Promise<Tokens> {
  const res = await request(ctx.server)
    .post('/auth/login')
    .send({ identifier, password, deviceInfo: device })
    .expect(201);

  const data = body(res);
  if (data.mfaRequired === true) {
    return completeAdminMfa(ctx, identifier, data.challenge as MfaChallenge, device);
  }
  return { accessToken: data.accessToken as string, refreshToken: data.refreshToken as string };
}

export interface MfaChallenge {
  type: 'TOTP' | 'ENROLLMENT';
  token: string;
  expiresAt: string;
  reason?: 'RECOVERY';
}

/** Authenticator secrets (base32) of administrators enrolled through `login`, by identifier. */
export const testAuthenticators = new Map<string, string>();

/**
 * A TOTP code the server will accept now for `userId`: the earliest step in the ±1 window that is
 * newer than the last step it accepted, waiting for the next 30-second step if the window is used up.
 */
export async function freshTotp(ctx: TestContext, userId: string, secret: string): Promise<string> {
  for (;;) {
    const credential = await ctx.prisma.adminMfaCredential.findUnique({ where: { userId } });
    const last = credential?.lastUsedStep == null ? -1 : Number(credential.lastUsedStep);
    const now = timeStepAt(Date.now());
    const step = [now, now + 1].find((candidate) => candidate > last);
    if (step !== undefined) return totpForStep(base32Decode(secret), step);
    await new Promise((resolve) => setTimeout(resolve, 30_000 - (Date.now() % 30_000) + 50));
  }
}

export async function completeAdminMfa(
  ctx: TestContext,
  identifier: string,
  challenge: MfaChallenge,
  device: { fingerprint: string; platform: string } = DEVICE,
): Promise<Tokens> {
  let res: request.Response;
  if (challenge.type === 'ENROLLMENT') {
    const started = await request(ctx.server)
      .post('/auth/mfa/enrollment/start')
      .send({ challengeToken: challenge.token })
      .expect(200);
    const secret = body(started).secret as string;
    testAuthenticators.set(identifier, secret);
    res = await request(ctx.server)
      .post('/auth/mfa/enrollment/confirm')
      .send({ challengeToken: challenge.token, code: totpForStep(base32Decode(secret), timeStepAt(Date.now())), deviceInfo: device })
      .expect(200);
  } else {
    const secret = testAuthenticators.get(identifier);
    if (!secret) throw new Error(`No test authenticator enrolled for ${identifier}`);
    const userId = await userIdFor(ctx, identifier);
    res = await request(ctx.server)
      .post('/auth/mfa/verify')
      .send({ challengeToken: challenge.token, code: await freshTotp(ctx, userId, secret), deviceInfo: device })
      .expect(200);
  }
  const data = body(res);
  return { accessToken: data.accessToken as string, refreshToken: data.refreshToken as string };
}

async function userIdFor(ctx: TestContext, identifier: string): Promise<string> {
  const user = await ctx.prisma.user.findFirstOrThrow({
    where: { OR: [{ phone: identifier }, { email: identifier.toLowerCase() }] },
    select: { id: true },
  });
  return user.id;
}

/**
 * Assigns a role directly through Prisma. Used only to bootstrap the very first privileged
 * account — the chicken-and-egg case a real deployment solves with a seeded super admin. Tests
 * that exercise role assignment itself go through the admin API instead.
 */
export async function grantRoleDirect(
  ctx: TestContext,
  userId: string,
  roleKey: string,
  organizationId: string | null = null,
): Promise<void> {
  const role = await ctx.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await ctx.prisma.userRole.create({ data: { userId, roleId: role.id, organizationId } });
}

/** A verified, logged-in user holding `roleKey`, with a token that already carries its grants. */
export async function createUserWithRole(
  ctx: TestContext,
  roleKey: string,
): Promise<RegisteredUser & Tokens> {
  const user = await registerAndVerify(ctx);
  await grantRoleDirect(ctx, user.userId, roleKey);
  // Log in *after* the grant so the access token carries the role's permissions.
  const tokens = await login(ctx, user.phone, user.password);
  return { ...user, ...tokens };
}

export const auth = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
