import request from 'supertest';
import { randomUUID } from 'crypto';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { ProviderLicenceExpirySweeper } from '../../src/modules/provider-directory/infrastructure/provider-licence-expiry.sweeper';
import { auth, body, createUserWithRole, errorOf, STRONG_PASSWORD } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test facility licence\n%%EOF\n');
const pathOf = (url: string) => new URL(url).pathname;
const DAY = 24 * 60 * 60 * 1000;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

/**
 * Work 160: Module 09 begins. The Super Admin registers a hospital, clinic, diagnostic centre or
 * lab for its administrator in one step — organisation, facility licence (approved), directory
 * profile, activation — finds it by name, and disables or enables it. An expired licence
 * suspends it automatically.
 */
describe('Admin — registers and controls healthcare providers (Work 160, e2e)', () => {
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

  /** A facility administrator who signed up with an e-mail address and confirmed it. */
  async function facilityAdmin() {
    const email = `facility-${randomUUID().slice(0, 8)}@pharmalink.test`;
    const registered = await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    await ctx.drainOutbox();
    const code = ctx.notifications.lastCodeFor(email, 'otp-register');
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(201);
    return { userId: body(registered).userId as string, email };
  }

  async function licenceFile(token: string, adminUserId: string): Promise<string> {
    const issued = body(
      await request(ctx.server)
        .post('/admin/provider-registrations/uploads')
        .set(...auth(token))
        .send({ adminUserId, contentType: 'application/pdf', bytes: PDF.length })
        .expect(201),
    ) as { storageRef: string; upload: { url: string } };
    await request(ctx.server).put(pathOf(issued.upload.url)).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    return issued.storageRef;
  }

  const form = (adminUserId: string, storageRef: string, over: Record<string, unknown> = {}) => ({
    adminUserId,
    type: 'HOSPITAL',
    legalName: `Tikur Anbessa Hospital PLC ${randomUUID().slice(0, 4)}`,
    displayName: 'Tikur Anbessa Hospital',
    licenseNumber: 'MOH/HF/2026/0160',
    licenseExpiresOn: day(365),
    documents: [{ kind: 'FACILITY_LICENSE', storageRef }],
    idempotencyKey: randomUUID(),
    ...over,
  });
  const register = (token: string, payload: Record<string, unknown>) =>
    request(ctx.server).post('/admin/provider-registrations').set(...auth(token)).send(payload);
  const record = async (token: string, providerId: string) =>
    body(await request(ctx.server).get(`/admin/providers/${providerId}`).set(...auth(token)).expect(200));

  it('registers a working hospital: organisation, approved facility licence with its file, profile, active', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const f = await facilityAdmin();
    const res = await register(admin.accessToken, form(f.userId, await licenceFile(admin.accessToken, f.userId)));
    expect(res.status).toBe(201);
    const { organizationId, providerId } = body(res) as { organizationId: string; providerId: string };

    const detail = await record(admin.accessToken, providerId);
    expect(detail).toEqual(
      expect.objectContaining({
        providerId,
        organizationId,
        type: 'HOSPITAL',
        displayName: 'Tikur Anbessa Hospital',
        status: 'ACTIVE',
        licenseStatus: 'VALID',
        locations: [],
        departments: [],
        services: [],
        organization: expect.objectContaining({
          type: 'HOSPITAL',
          status: 'ACTIVE',
          licenseNumber: 'MOH/HF/2026/0160',
          owner: expect.objectContaining({ userId: f.userId, email: f.email }),
          members: [expect.objectContaining({ userId: f.userId, roles: ['HOSPITAL_ADMIN'] })],
        }),
      }),
    );

    // The facility licence is on record, approved by the administrator.
    const files = body(await request(ctx.server).get(`/admin/verifications?organizationId=${organizationId}&status=APPROVED`).set(...auth(admin.accessToken)).expect(200));
    const items = files.items as Array<{ requestId: string; status: string; type: string }>;
    expect(items.map((i) => [i.type, i.status])).toEqual([['FACILITY_LICENSE', 'APPROVED']]);
    const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: items[0].requestId } });
    expect(stored.reviewerId).toBe(admin.userId);

    expect(await ctx.prisma.auditLog.count({ where: { action: 'PROVIDER_REGISTERED_BY_ADMIN', resourceId: providerId, actorUserId: admin.userId } })).toBe(1);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'provider.provider.activated', aggregateId: providerId } })).toBe(1);
  });

  it('a lab or diagnostic centre is a LAB organisation run by a diagnostic centre administrator', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const f = await facilityAdmin();
    const lab = body(
      await register(admin.accessToken, form(f.userId, await licenceFile(admin.accessToken, f.userId), { type: 'DIAGNOSTIC_CENTER', displayName: 'Pioneer Diagnostics' })).expect(201),
    );
    const detail = await record(admin.accessToken, lab.providerId as string);
    expect(detail).toEqual(
      expect.objectContaining({
        type: 'DIAGNOSTIC_CENTER',
        status: 'ACTIVE',
        organization: expect.objectContaining({ type: 'LAB', members: [expect.objectContaining({ roles: ['DIAGNOSTIC_CENTER_ADMIN'] })] }),
      }),
    );

    // The same administrator may run a second facility.
    const clinic = body(
      await register(admin.accessToken, form(f.userId, await licenceFile(admin.accessToken, f.userId), { type: 'CLINIC', displayName: 'Pioneer Clinic', licenseNumber: 'MOH/HF/2026/0161' })).expect(201),
    );
    expect(clinic.organizationId).not.toBe(lab.organizationId);
    expect(await ctx.prisma.organization.count({ where: { ownerUserId: f.userId, status: 'ACTIVE' } })).toBe(2);
  });

  it('a retry with the same key continues instead of registering twice', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const f = await facilityAdmin();
    const payload = form(f.userId, await licenceFile(admin.accessToken, f.userId));
    const a = body(await register(admin.accessToken, payload).expect(201));
    const b = body(await register(admin.accessToken, payload).expect(201));
    expect(b).toEqual(a);
    expect(await ctx.prisma.healthcareProvider.count()).toBe(1);
    expect(await ctx.prisma.verificationRequest.count({ where: { type: 'FACILITY_LICENSE' } })).toBe(1);
  });

  it('finds providers by name, type and status', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const f = await facilityAdmin();
    const hospital = body(await register(admin.accessToken, form(f.userId, await licenceFile(admin.accessToken, f.userId))).expect(201));
    const lab = body(
      await register(admin.accessToken, form(f.userId, await licenceFile(admin.accessToken, f.userId), { type: 'LAB', displayName: 'Bethel Medical Laboratory', licenseNumber: 'MOH/LAB/1' })).expect(201),
    );
    const list = async (query: string) =>
      (body(await request(ctx.server).get(`/admin/providers${query}`).set(...auth(admin.accessToken)).expect(200)).items as Array<{ providerId: string }>).map((i) => i.providerId);

    expect((await list('')).sort()).toEqual([hospital.providerId, lab.providerId].sort());
    expect(await list('?q=anbessa')).toEqual([hospital.providerId]);
    expect(await list('?q=%25')).toEqual([]);
    expect(await list('?type=LAB')).toEqual([lab.providerId]);
    expect(await list('?status=SUSPENDED')).toEqual([]);
    await request(ctx.server).get('/admin/providers?type=PHARMACY').set(...auth(admin.accessToken)).expect(400);
  });

  it('disables a provider with a reason and enables it again', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const f = await facilityAdmin();
    const { providerId } = body(await register(admin.accessToken, form(f.userId, await licenceFile(admin.accessToken, f.userId))).expect(201)) as { providerId: string };
    const post = (path: string, payload?: Record<string, unknown>) =>
      request(ctx.server).post(`/admin/providers/${providerId}/${path}`).set(...auth(admin.accessToken)).send(payload ?? {});

    expect((await post('suspend', { reason: 'no' })).status).toBe(400);
    expect(body(await post('suspend', { reason: 'Unlicensed department found on inspection' }).expect(200))).toEqual({ suspended: true });
    expect(body(await post('suspend', { reason: 'Again' }).expect(200))).toEqual({ suspended: false });
    expect((await record(admin.accessToken, providerId)).status).toBe('SUSPENDED');
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'provider.provider.suspended', aggregateId: providerId } })).toBe(1);

    expect(body(await post('reactivate').expect(200))).toEqual({ reactivated: true });
    expect(body(await post('reactivate').expect(200))).toEqual({ reactivated: false });
    expect((await record(admin.accessToken, providerId)).status).toBe('ACTIVE');
    expect(await ctx.prisma.auditLog.count({ where: { resourceId: providerId, action: { in: ['PROVIDER_SUSPENDED', 'PROVIDER_ACTIVATED'] } } })).toBe(3);

    await request(ctx.server).post(`/admin/providers/${randomUUID()}/reactivate`).set(...auth(admin.accessToken)).expect(404);
  });

  it('an expired licence suspends the provider, and it cannot be enabled until the licence is renewed', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const f = await facilityAdmin();
    const { providerId, organizationId } = body(await register(admin.accessToken, form(f.userId, await licenceFile(admin.accessToken, f.userId))).expect(201));
    const past = new Date(Date.now() - DAY);
    await ctx.prisma.organization.update({ where: { id: organizationId as string }, data: { licenseExpiresAt: past } });
    await ctx.prisma.healthcareProvider.update({ where: { id: providerId as string }, data: { licenseExpiresAt: past } });

    expect(await ctx.app.get(ProviderLicenceExpirySweeper).run()).toBe(1);
    expect(await record(admin.accessToken, providerId as string)).toEqual(expect.objectContaining({ status: 'SUSPENDED', licenseStatus: 'EXPIRED' }));
    expect(await ctx.prisma.auditLog.count({ where: { action: 'PROVIDER_AUTO_SUSPENDED', resourceId: providerId as string } })).toBe(1);

    const refused = await request(ctx.server).post(`/admin/providers/${providerId}/reactivate`).set(...auth(admin.accessToken)).send({});
    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toEqual(expect.objectContaining({ code: 'PROVIDER_NOT_ELIGIBLE', details: { reason: 'LICENSE_EXPIRED' } }));
  });

  it('refuses an expired licence, a type that is not a facility, a file that is not the administrator’s, and anyone without the permission', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const f = await facilityAdmin();
    const other = await facilityAdmin();
    const ref = await licenceFile(admin.accessToken, f.userId);

    const expired = await register(admin.accessToken, form(f.userId, ref, { licenseExpiresOn: day(-1) }));
    expect(expired.status).toBe(400);
    expect(errorOf(expired).message).toMatch(/expired/);
    expect((await register(admin.accessToken, form(f.userId, ref, { type: 'PHARMACY' }))).status).toBe(400);
    expect((await register(admin.accessToken, form(other.userId, ref))).status).toBe(400);
    expect(await ctx.prisma.healthcareProvider.count()).toBe(0);

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    expect((await register(customer.accessToken, form(f.userId, ref))).status).toBe(403);
    await request(ctx.server).get('/admin/providers').set(...auth(customer.accessToken)).expect(403);
  });
});
