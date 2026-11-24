import request from 'supertest';
import { randomUUID } from 'crypto';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { auth, body, createUserWithRole, errorOf, login, STRONG_PASSWORD } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test licence\n%%EOF\n');
const pathOf = (url: string) => new URL(url).pathname;
const DAY = 24 * 60 * 60 * 1000;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

/**
 * Work 154: the Super Admin registers a pharmacy for an owner in one step — organisation, licence
 * files and number (approved), storefront, activation — and one owner may hold several pharmacies.
 */
describe('Admin — registers a pharmacy for an owner (Work 154, e2e)', () => {
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

  /** An owner who signed up with an e-mail address and confirmed it. */
  async function owner() {
    const email = `owner-${randomUUID().slice(0, 8)}@pharmalink.test`;
    const registered = await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    await ctx.drainOutbox();
    const code = ctx.notifications.lastCodeFor(email, 'otp-register');
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(201);
    return { userId: body(registered).userId as string, email };
  }

  async function licenceFile(token: string, ownerUserId: string): Promise<string> {
    const issued = body(
      await request(ctx.server)
        .post('/admin/pharmacy-registrations/uploads')
        .set(...auth(token))
        .send({ ownerUserId, contentType: 'application/pdf', bytes: PDF.length })
        .expect(201),
    ) as { storageRef: string; upload: { url: string } };
    await request(ctx.server).put(pathOf(issued.upload.url)).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    return issued.storageRef;
  }

  const form = (ownerUserId: string, storageRef: string, over: Record<string, unknown> = {}) => ({
    ownerUserId,
    legalName: `Selam Pharmacy PLC ${randomUUID().slice(0, 4)}`,
    displayName: 'Selam Pharmacy',
    licenseNumber: 'EFDA/PH/2026/0154',
    licenseExpiresOn: day(365),
    documents: [{ kind: 'PHARMACY_LICENSE', storageRef }],
    idempotencyKey: randomUUID(),
    ...over,
  });
  const register = (token: string, payload: Record<string, unknown>) =>
    request(ctx.server).post('/admin/pharmacy-registrations').set(...auth(token)).send(payload);

  it('registers a working pharmacy: organisation, approved licence with its file, storefront, active', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const o = await owner();
    const ref = await licenceFile(admin.accessToken, o.userId);

    const res = await register(admin.accessToken, form(o.userId, ref));
    expect(res.status).toBe(201);
    const { organizationId, pharmacyId } = body(res) as { organizationId: string; pharmacyId: string };

    const detail = body(await request(ctx.server).get(`/admin/operations/pharmacies/${pharmacyId}`).set(...auth(admin.accessToken)).expect(200));
    expect(detail).toEqual(expect.objectContaining({ displayName: 'Selam Pharmacy', transactingStatus: 'ACTIVE', eligible: true, organizationId }));
    const people = body(await request(ctx.server).get(`/admin/operations/pharmacies/${pharmacyId}/people`).set(...auth(admin.accessToken)).expect(200));
    expect(people).toEqual(expect.objectContaining({ status: 'ACTIVE', licenseNumber: 'EFDA/PH/2026/0154', owner: expect.objectContaining({ userId: o.userId, email: o.email }) }));

    // The licence file is on record, approved by the administrator, and previewable.
    const files = body(await request(ctx.server).get(`/admin/verifications?organizationId=${organizationId}&status=APPROVED`).set(...auth(admin.accessToken)).expect(200));
    const items = files.items as Array<{ requestId: string; status: string; type: string }>;
    expect(items.map((i) => [i.type, i.status])).toEqual([['PHARMACY_LICENSE', 'APPROVED']]);
    const stored = await ctx.prisma.verificationRequest.findUniqueOrThrow({ where: { id: items[0].requestId } });
    expect(stored.reviewerId).toBe(admin.userId);
    await request(ctx.server).post(`/admin/verifications/${items[0].requestId}/documents/0/preview`).set(...auth(admin.accessToken)).send({}).expect(200);

    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'PHARMACY_REGISTERED_BY_ADMIN', resourceId: pharmacyId } });
    expect(audit?.actorUserId).toBe(admin.userId);

    // The owner signs in and finds their pharmacy.
    const tokens = await login(ctx, o.email);
    const profile = body(await request(ctx.server).get('/pharmacy/profile').set(...auth(tokens.accessToken)).expect(200));
    expect(profile.id).toBe(pharmacyId);
  });

  it('one owner can hold several pharmacies', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const o = await owner();
    const first = body(await register(admin.accessToken, form(o.userId, await licenceFile(admin.accessToken, o.userId))).expect(201));
    const second = body(
      await register(admin.accessToken, form(o.userId, await licenceFile(admin.accessToken, o.userId), { displayName: 'Selam Pharmacy — Piassa', licenseNumber: 'EFDA/PH/2026/0155' })).expect(201),
    );
    expect(second.organizationId).not.toBe(first.organizationId);
    const owned = await ctx.prisma.organization.findMany({ where: { ownerUserId: o.userId } });
    expect(owned).toHaveLength(2);
    expect(owned.every((org) => org.status === 'ACTIVE')).toBe(true);
  });

  it('a retry with the same key continues instead of registering twice', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const o = await owner();
    const payload = form(o.userId, await licenceFile(admin.accessToken, o.userId));
    const a = body(await register(admin.accessToken, payload).expect(201));
    const b = body(await register(admin.accessToken, payload).expect(201));
    expect(b).toEqual(a);
    expect(await ctx.prisma.organization.count({ where: { ownerUserId: o.userId } })).toBe(1);
    expect(await ctx.prisma.pharmacy.count()).toBe(1);
  });

  it('refuses an expired licence, a file that is not the owner’s, and anyone without the permission', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const o = await owner();
    const other = await owner();
    const ref = await licenceFile(admin.accessToken, o.userId);

    const expired = await register(admin.accessToken, form(o.userId, ref, { licenseExpiresOn: day(-1) }));
    expect(expired.status).toBe(400);
    expect(errorOf(expired).message).toMatch(/expired/);

    const foreign = await register(admin.accessToken, form(other.userId, ref));
    expect(foreign.status).toBe(400);
    expect(await ctx.prisma.pharmacy.count()).toBe(0);

    expect((await register(admin.accessToken, form(o.userId, 'not-a-doc'))).status).toBe(400);
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    expect((await register(customer.accessToken, form(o.userId, ref))).status).toBe(403);
  });
});
