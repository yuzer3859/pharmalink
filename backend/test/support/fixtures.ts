import request from 'supertest';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
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
  return { accessToken: data.accessToken as string, refreshToken: data.refreshToken as string };
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
