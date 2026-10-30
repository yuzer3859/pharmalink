import request from 'supertest';
import { randomUUID } from 'crypto';
import { ORGANIZATION_REPOSITORY } from '../../src/modules/identity/domain/repositories/organization.repository';
import { PrismaOrganizationRepository } from '../../src/modules/identity/infrastructure/persistence/prisma-organization.repository';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  login,
  registerAndVerify,
  STRONG_PASSWORD,
  Tokens,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 65: `POST /organizations/pharmacy` — an e-mail-verified customer applies to own a pending
 * pharmacy organisation, receives the org-scoped PHARMACY_OWNER membership, and continues with the
 * existing `POST /pharmacy/register`.
 */

/** Fails the membership insert, after the organisation insert, inside the same transaction. */
class FailingMembershipRepository extends PrismaOrganizationRepository {
  failNext = false;
  async addMembership(input: Parameters<PrismaOrganizationRepository['addMembership']>[0], tx: unknown) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('injected membership failure');
    }
    return super.addMembership(input, tx);
  }
}

interface EmailCustomer extends Tokens {
  userId: string;
  email: string;
}

describe('Pharmacy organisation onboarding (e2e)', () => {
  let ctx: TestContext;
  let failing: FailingMembershipRepository;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: ORGANIZATION_REPOSITORY, useClass: FailingMembershipRepository }]);
    failing = ctx.app.get<FailingMembershipRepository>(ORGANIZATION_REPOSITORY);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  /** Registers by e-mail and verifies through the real OTP flow (the recording adapter holds the code). */
  async function emailCustomer(): Promise<EmailCustomer> {
    const email = `customer-${randomUUID().slice(0, 8)}@pharmalink.test`;
    const registered = await request(ctx.server)
      .post('/auth/register')
      .send({ email, password: STRONG_PASSWORD })
      .expect(201);
    await ctx.drainOutbox();
    const code = ctx.notifications.lastCodeFor(email, 'otp-register');
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(201);
    const tokens = await login(ctx, email);
    return { userId: body(registered).userId as string, email, ...tokens };
  }

  const apply = (token: string, payload: Record<string, unknown>) =>
    request(ctx.server).post('/organizations/pharmacy').set(...auth(token)).send(payload);
  const application = (overrides: Record<string, unknown> = {}) => ({
    legalName: 'Abebe Pharmacy PLC',
    idempotencyKey: randomUUID(),
    ...overrides,
  });
  const refresh = async (refreshToken: string): Promise<Tokens> => {
    const data = body(await request(ctx.server).post('/auth/token/refresh').send({ refreshToken }).expect(201));
    return { accessToken: data.accessToken as string, refreshToken: data.refreshToken as string };
  };

  it('rejects unauthenticated callers', async () => {
    const res = await request(ctx.server).post('/organizations/pharmacy').send(application()).expect(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it('denies an account without pharmacy:apply:own', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    expect(errorOf(await apply(admin.accessToken, application()).expect(403)).code).toBe('FORBIDDEN');

    // Remove the grant from the CUSTOMER role before this customer exists, so no cache holds it.
    const grant = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'pharmacy:apply:own' } });
    await ctx.prisma.rolePermission.deleteMany({ where: { permissionId: grant.id } });
    const customer = await emailCustomer();
    expect(errorOf(await apply(customer.accessToken, application()).expect(403)).code).toBe('FORBIDDEN');
    expect(await ctx.prisma.organization.count()).toBe(0);
  });

  it('denies an active customer whose e-mail is not verified', async () => {
    const phoneOnly = await registerAndVerify(ctx);
    const tokens = await login(ctx, phoneOnly.phone);
    const res = await apply(tokens.accessToken, application()).expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
    expect(body(res)).toBeNull();
    expect((res.body as { error: { details: unknown } }).error.details).toEqual({ reason: 'EMAIL_NOT_VERIFIED' });
    expect(await ctx.prisma.organization.count()).toBe(0);
  });

  it('rejects client-supplied ownership, type, status and role fields', async () => {
    const customer = await emailCustomer();
    for (const extra of [
      { ownerUserId: randomUUID() },
      { organizationId: randomUUID() },
      { type: 'HOSPITAL' },
      { status: 'ACTIVE' },
      { roleKey: 'SUPER_ADMIN' },
      { licenseStatus: 'VALID' },
      { faydaVerifiedAt: new Date().toISOString() },
      { permissions: ['*'] },
    ]) {
      const res = await apply(customer.accessToken, application(extra)).expect(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    expect(await ctx.prisma.organization.count()).toBe(0);
  });

  it('creates a pending PHARMACY organisation owned by the caller with an org-scoped PHARMACY_OWNER membership', async () => {
    const customer = await emailCustomer();
    const before = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });

    const res = await apply(customer.accessToken, application({ legalName: '  Abebe   Pharmacy PLC ' })).expect(201);
    const view = body(res);
    expect(view).toMatchObject({
      type: 'PHARMACY',
      name: 'Abebe Pharmacy PLC',
      status: 'PENDING_APPROVAL',
      membership: { roleKey: 'PHARMACY_OWNER', organizationId: view.organizationId },
    });
    expect(JSON.stringify(view)).not.toMatch(/passwordHash|applicationKey|ownerUserId/);

    const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: view.organizationId as string } });
    expect(org).toMatchObject({
      type: 'PHARMACY',
      status: 'PENDING_APPROVAL',
      ownerUserId: customer.userId,
      licenseNumber: null,
      licenseExpiresAt: null,
      deletedAt: null,
    });

    const roles = await ctx.prisma.userRole.findMany({ where: { userId: customer.userId }, include: { role: true } });
    expect(roles.map((r) => [r.role.key, r.organizationId, r.assignedBy]).sort()).toEqual(
      [
        ['CUSTOMER', null, null],
        ['PHARMACY_OWNER', org.id, customer.userId],
      ].sort(),
    );

    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(after.primaryRole).toBe('CUSTOMER');
    expect(after.faydaVerifiedAt).toBeNull();
    expect(after.permVersion).toBe(before.permVersion + 1);

    const actions = (await ctx.prisma.auditLog.findMany({ where: { actorUserId: customer.userId } })).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['identity.organization.pharmacy_application_created', 'rbac.user_role.assigned']),
    );
  });

  it('propagates the permission change: the old token is rejected and a refreshed one can register the pharmacy', async () => {
    const customer = await emailCustomer();
    const view = body(await apply(customer.accessToken, application()).expect(201));
    const organizationId = view.organizationId as string;

    const stale = await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(customer.accessToken))
      .send({ organizationId, displayName: 'Abebe Pharmacy' })
      .expect(401);
    expect(errorOf(stale).code).toBe('TOKEN_EXPIRED');

    const owner = await refresh(customer.refreshToken);
    const registered = body(
      await request(ctx.server)
        .post('/pharmacy/register')
        .set(...auth(owner.accessToken))
        .send({ organizationId, displayName: 'Abebe Pharmacy' })
        .expect(201),
    );
    expect(registered.transactingStatus).toBe('PENDING');

    const duplicate = await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(owner.accessToken))
      .send({ organizationId, displayName: 'Abebe Pharmacy' });
    expect(duplicate.status).toBe(409);

    // Nothing was approved or activated along the way.
    const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.status).toBe('PENDING_APPROVAL');
  });

  it("does not let another customer register someone else's organisation", async () => {
    const first = await emailCustomer();
    const firstOrg = body(await apply(first.accessToken, application()).expect(201)).organizationId as string;

    const second = await emailCustomer();
    await apply(second.accessToken, application({ legalName: 'Second Pharmacy' })).expect(201);
    const secondOwner = await refresh(second.refreshToken);
    const res = await request(ctx.server)
      .post('/pharmacy/register')
      .set(...auth(secondOwner.accessToken))
      .send({ organizationId: firstOrg, displayName: 'Hijack' })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
    expect(await ctx.prisma.pharmacy.count({ where: { organizationId: firstOrg } })).toBe(0);
  });

  it('returns the same organisation for a same-key retry and conflicts on a changed name', async () => {
    const customer = await emailCustomer();
    const key = randomUUID();
    const first = body(await apply(customer.accessToken, application({ idempotencyKey: key })).expect(201));
    const owner = await refresh(customer.refreshToken);

    const retry = body(await apply(owner.accessToken, application({ idempotencyKey: key })).expect(201));
    expect(retry.organizationId).toBe(first.organizationId);

    const conflict = await apply(owner.accessToken, application({ idempotencyKey: key, legalName: 'Different Name' })).expect(409);
    expect(errorOf(conflict).code).toBe('IDEMPOTENCY_CONFLICT');

    expect(await ctx.prisma.organization.count()).toBe(1);
    expect(await ctx.prisma.userRole.count({ where: { userId: customer.userId, role: { key: 'PHARMACY_OWNER' } } })).toBe(1);
  });

  it('creates one organisation for concurrent submissions with the same key', async () => {
    const customer = await emailCustomer();
    const payload = application();
    const responses = await Promise.all([apply(customer.accessToken, payload), apply(customer.accessToken, payload)]);
    const ok = responses.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // A request that lost the race either replays the winner (201) or was rejected because the
    // winner's commit bumped permVersion (401 TOKEN_EXPIRED): never a second organisation.
    for (const r of responses) expect([201, 401]).toContain(r.status);
    expect(new Set(ok.map((r) => body(r).organizationId)).size).toBe(1);
    expect(await ctx.prisma.organization.count()).toBe(1);
    expect(await ctx.prisma.userRole.count({ where: { role: { key: 'PHARMACY_OWNER' } } })).toBe(1);
  });

  it('fails closed when the PHARMACY_OWNER role is missing or mis-scoped', async () => {
    const customer = await emailCustomer();
    await ctx.prisma.role.update({ where: { key: 'PHARMACY_OWNER' }, data: { scope: 'PLATFORM' } });
    const res = await apply(customer.accessToken, application()).expect(500);
    expect(errorOf(res).code).toBe('INTERNAL_ERROR');
    expect(await ctx.prisma.organization.count()).toBe(0);
    expect(await ctx.prisma.userRole.count({ where: { organizationId: { not: null } } })).toBe(0);
  });

  it('rolls back the organisation when the membership cannot be written', async () => {
    const customer = await emailCustomer();
    const auditBefore = await ctx.prisma.auditLog.count();
    failing.failNext = true;
    await apply(customer.accessToken, application()).expect(500);
    expect(await ctx.prisma.organization.count()).toBe(0);
    expect(await ctx.prisma.userRole.count({ where: { organizationId: { not: null } } })).toBe(0);
    expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.permVersion).toBe(1);
  });

  it('keeps the CUSTOMER grant narrow: no privileged permissions', async () => {
    const role = await ctx.prisma.role.findUniqueOrThrow({
      where: { key: 'CUSTOMER' },
      include: { rolePermissions: { include: { permission: true } } },
    });
    const keys = role.rolePermissions.map((rp) => rp.permission.key);
    expect(keys).toContain('pharmacy:apply:own');
    for (const privileged of ['*', 'rbac:manage', 'provider:verify:any', 'pharmacy:register', 'pharmacy:manage:org']) {
      expect(keys).not.toContain(privileged);
    }
  });
});
