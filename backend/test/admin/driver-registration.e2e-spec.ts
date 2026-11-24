import request from 'supertest';
import { randomUUID } from 'crypto';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { auth, body, createUserWithRole, errorOf, login, STRONG_PASSWORD } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from '../pharmacy-inventory/support';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test driving licence\n%%EOF\n');
const pathOf = (url: string) => new URL(url).pathname;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Work 156: the Super Admin registers a driver — an existing customer account becomes a driver
 * with approved documents and a delivery profile, and can go online — and disables them by
 * suspending the account.
 */
describe('Admin — registers and disables drivers (Work 156, e2e)', () => {
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

  async function person() {
    const email = `driver-${randomUUID().slice(0, 8)}@pharmalink.test`;
    const registered = await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
    await ctx.drainOutbox();
    const code = ctx.notifications.lastCodeFor(email, 'otp-register');
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(201);
    return { userId: body(registered).userId as string, email };
  }

  async function document(token: string, userId: string): Promise<string> {
    const issued = body(
      await request(ctx.server).post('/admin/drivers/uploads').set(...auth(token)).send({ userId, contentType: 'application/pdf', bytes: PDF.length }).expect(201),
    ) as { storageRef: string; upload: { url: string } };
    await request(ctx.server).put(pathOf(issued.upload.url)).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    return issued.storageRef;
  }

  const register = (token: string, payload: Record<string, unknown>) => request(ctx.server).post('/admin/drivers').set(...auth(token)).send(payload);
  const form = (userId: string, storageRef: string, over: Record<string, unknown> = {}) => ({
    userId,
    vehicleType: 'MOTORCYCLE',
    plateNumber: 'AA 3-12345',
    documentsExpireOn: day(365),
    documents: [{ kind: 'DRIVING_LICENSE', storageRef }],
    serviceArea: { lat: 9.02, lng: 38.75, radiusMeters: 15000 },
    ...over,
  });

  it('makes a customer a driver with approved documents and a profile; they can go online', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const p = await person();
    const res = await register(admin.accessToken, form(p.userId, await document(admin.accessToken, p.userId)));
    expect(res.status).toBe(201);
    expect(body(res).profile).toEqual(expect.objectContaining({ vehicleType: 'MOTORCYCLE', plateNumber: 'AA 3-12345', availability: 'OFFLINE' }));

    const account = body(await request(ctx.server).get(`/admin/accounts/${p.userId}`).set(...auth(admin.accessToken)).expect(200));
    expect(account.primaryRole).toBe('DRIVER');
    const docs = body(await request(ctx.server).get(`/admin/verifications?userId=${p.userId}&type=DRIVER_DOCS`).set(...auth(admin.accessToken)).expect(200));
    expect((docs.items as Array<{ status: string }>).map((d) => d.status)).toEqual(['APPROVED']);
    const profile = body(await request(ctx.server).get(`/admin/drivers/${p.userId}/profile`).set(...auth(admin.accessToken)).expect(200));
    expect(profile).toEqual(expect.objectContaining({ serviceArea: { lat: 9.02, lng: 38.75, radiusMeters: 15000 } }));
    expect(JSON.stringify(profile)).not.toMatch(/lastLocation/);
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'DRIVER_REGISTERED_BY_ADMIN', resourceId: p.userId } });
    expect(audit?.actorUserId).toBe(admin.userId);

    // The driver signs in and goes online.
    const tokens = await login(ctx, p.email);
    const online = await request(ctx.server).put('/driver/availability').set(...auth(tokens.accessToken)).send({ status: 'ONLINE' });
    expect(online.status).toBe(200);
    expect(body(online).availability).toBe('ONLINE');

    // Disabled: the account is suspended, and the driver can no longer go online.
    await request(ctx.server).post(`/admin/accounts/${p.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Documents under review.' }).expect(200);
    const after = await request(ctx.server).put('/driver/availability').set(...auth(tokens.accessToken)).send({ status: 'ONLINE' });
    expect(after.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses pharmacy staff, expired documents, someone else’s file, and anyone without the permission', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const owner = await createActivatedPharmacy(ctx);
    const ownerRef = await document(admin.accessToken, owner.userId);
    const staff = await register(admin.accessToken, form(owner.userId, ownerRef));
    expect(staff.status).toBe(422);
    expect(errorOf(staff).message).toMatch(/pharmacy/);

    const p = await person();
    const ref = await document(admin.accessToken, p.userId);
    expect((await register(admin.accessToken, form(p.userId, ref, { documentsExpireOn: day(-1) }))).status).toBe(400);
    expect((await register(admin.accessToken, form(p.userId, ownerRef))).status).toBe(400);
    expect((await register(admin.accessToken, form(p.userId, ref, { vehicleType: 'ROCKET' }))).status).toBe(400);
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    expect((await register(customer.accessToken, form(p.userId, ref))).status).toBe(403);
    expect(await ctx.prisma.driverProfile.count()).toBe(0);
  });
});
