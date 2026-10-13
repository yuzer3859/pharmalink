import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Driver = {
  driverProfileId: string; availability: string; onShift: boolean; shiftStartedAt: string | null; lastOnlineAt: string | null; lastLocationAt: string | null;
  createdAt: string; updatedAt: string; totalJobs: number; activeJobCount: number; jobsByStatus: Array<{ status: string; count: number }>;
};
type Page = { items: Driver[]; total: number; page: number; size: number };
const BASE = '/admin/operations/drivers';
const STATUSES = ['CREATED', 'OFFERED', 'ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF', 'DELIVERED', 'COMPLETED', 'REASSIGNING', 'CANCELLED', 'FAILED'];

/**
 * Module 16 Work 37 against real PostgreSQL: read-only driver operations — Module 08 driver profiles,
 * their availability and shift, and their delivery jobs counted by stored status.
 */
describe('Admin driver operations (e2e)', () => {
  let ctx: TestContext;
  let admin: User;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  const get = (path: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(path);
    return token ? r.set(...auth(token)) : r;
  };
  const list = async (query: Record<string, string | number> = {}) => body(await get(BASE).query(query).expect(200)) as unknown as Page;
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const counts = (d: Driver) => Object.fromEntries(d.jobsByStatus.filter((b) => b.count).map((b) => [b.status, b.count]));

  async function seedDriver(o: { availability: string; onShift: boolean; createdAt: Date }) {
    const user = await createUserWithRole(ctx, 'DRIVER');
    const profile = await ctx.prisma.driverProfile.create({
      data: {
        userId: user.userId, availability: o.availability as never, shiftStartedAt: o.onShift ? t(120) : null, lastOnlineAt: o.onShift ? t(120) : null,
        vehicleType: 'MOTORBIKE', plateNumber: `AA-3-${randomUUID().slice(0, 5)}`, serviceArea: { lat: 9.0301, lng: 38.7401, radiusMeters: 5000 },
        maxConcurrent: 3, lastLat: 9.0123, lastLng: 38.7654, lastLocationAt: o.onShift ? t(1) : null, createdAt: o.createdAt,
      },
    });
    return { user, profile };
  }
  async function seedJob(status: string, driverId: string | null, isCod = false) {
    return ctx.prisma.deliveryJob.create({
      data: {
        orderId: randomUUID(), fulfillmentId: randomUUID(), pharmacyId: randomUUID(), branchId: randomUUID(), assignedDriverId: driverId, status: status as never,
        dropoffAddress: 'Bole Road 42, House 7', dropoffLat: 8.9951, dropoffLng: 38.7899, isCod,
      },
    });
  }

  async function seedSet() {
    const busy = await seedDriver({ availability: 'BUSY', onShift: true, createdAt: t(50) });
    const online = await seedDriver({ availability: 'ONLINE', onShift: true, createdAt: t(40) });
    const onBreak = await seedDriver({ availability: 'OFFLINE', onShift: true, createdAt: t(30) });
    const off = await seedDriver({ availability: 'OFFLINE', onShift: false, createdAt: t(20) });
    for (const s of ['ASSIGNED', 'EN_ROUTE', 'ARRIVED_DROPOFF', 'DELIVERED', 'COMPLETED', 'COMPLETED', 'FAILED']) await seedJob(s, busy.profile.id);
    await seedJob('PICKED_UP', online.profile.id, true);
    await seedJob('CANCELLED', online.profile.id);
    // Not attributed to anybody: unassigned, offered, and a job released to REASSIGNING (driver cleared).
    await seedJob('CREATED', null);
    await seedJob('OFFERED', null);
    await seedJob('REASSIGNING', null);
    return { busy, online, onBreak, off };
  }

  it('an empty list', async () => {
    expect(await list()).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('lists newest first with exact fields; counts are real jobs by stored status; active = ASSIGNED..ARRIVED_DROPOFF', async () => {
    const s = await seedSet();
    const res = await list();
    expect(res.total).toBe(4);
    expect(res.items.map((i) => i.driverProfileId)).toEqual([s.off.profile.id, s.onBreak.profile.id, s.online.profile.id, s.busy.profile.id]);
    const busy = res.items.find((i) => i.driverProfileId === s.busy.profile.id)!;
    const row = await ctx.prisma.driverProfile.findUniqueOrThrow({ where: { id: s.busy.profile.id } });
    expect(Object.keys(busy)).toEqual(['driverProfileId', 'availability', 'onShift', 'shiftStartedAt', 'lastOnlineAt', 'lastLocationAt', 'createdAt', 'updatedAt', 'totalJobs', 'activeJobCount', 'jobsByStatus']);
    expect(busy).toMatchObject({
      availability: 'BUSY', onShift: true, shiftStartedAt: row.shiftStartedAt!.toISOString(), lastOnlineAt: row.lastOnlineAt!.toISOString(),
      lastLocationAt: row.lastLocationAt!.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), totalJobs: 7, activeJobCount: 3,
    });
    expect(busy.jobsByStatus.map((b) => b.status)).toEqual(STATUSES);
    expect(counts(busy)).toEqual({ ASSIGNED: 1, EN_ROUTE: 1, ARRIVED_DROPOFF: 1, DELIVERED: 1, COMPLETED: 2, FAILED: 1 });
    const online = res.items.find((i) => i.driverProfileId === s.online.profile.id)!;
    expect([online.totalJobs, online.activeJobCount, counts(online)]).toEqual([2, 1, { PICKED_UP: 1, CANCELLED: 1 }]);
    // Drivers with no jobs: zeros, and their availability is the stored one (onBreak is on shift but OFFLINE).
    for (const d of [s.onBreak, s.off]) {
      const item = res.items.find((i) => i.driverProfileId === d.profile.id)!;
      expect([item.totalJobs, item.activeJobCount, counts(item), item.availability]).toEqual([0, 0, {}, 'OFFLINE']);
    }
    // The three unattributed jobs are in no driver's counts.
    expect(res.items.reduce((acc, i) => acc + i.totalJobs, 0)).toBe(9);
  });

  it('filters by availability and onShift (including false); pages stably; rejects bad input', async () => {
    const s = await seedSet();
    expect((await list({ availability: 'BUSY' })).items.map((i) => i.driverProfileId)).toEqual([s.busy.profile.id]);
    expect((await list({ availability: 'OFFLINE' })).items.map((i) => i.driverProfileId)).toEqual([s.off.profile.id, s.onBreak.profile.id]);
    expect((await list({ onShift: 'false' })).items.map((i) => i.driverProfileId)).toEqual([s.off.profile.id]);
    expect((await list({ onShift: 'true' })).total).toBe(3);
    expect((await list({ availability: 'OFFLINE', onShift: 'true' })).items.map((i) => i.driverProfileId)).toEqual([s.onBreak.profile.id]);
    const pages = [await list({ size: 3, page: 1 }), await list({ size: 3, page: 2 })];
    expect(pages.map((p) => p.total)).toEqual([4, 4]);
    expect(pages.flatMap((p) => p.items.map((i) => i.driverProfileId))).toEqual((await list()).items.map((i) => i.driverProfileId));
    for (const bad of [{ availability: 'SUSPENDED' }, { onShift: 'maybe' }, { page: 0 }, { size: 101 }, { userId: s.busy.user.userId }, { phone: s.busy.user.phone }, { q: 'AA-3' }]) {
      expect({ bad, status: (await get(BASE).query(bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: one profile with the same fields and counts as its list row', async () => {
    const s = await seedSet();
    const d = body(await get(`${BASE}/${s.busy.profile.id}`).expect(200)) as unknown as Driver;
    expect(d).toEqual((await list()).items.find((i) => i.driverProfileId === s.busy.profile.id));
    const none = body(await get(`${BASE}/${s.off.profile.id}`).expect(200)) as unknown as Driver;
    expect([none.availability, none.onShift, none.shiftStartedAt, none.totalJobs, none.activeJobCount]).toEqual(['OFFLINE', false, null, 0, 0]);
  });

  it('unknown profile → 404; malformed id → 400; a user id is not a profile id', async () => {
    const s = await seedSet();
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/${s.busy.user.userId}`).expect(404);
  });

  it('privacy: no user id, phone, plate, vehicle, service area, coordinates, override, addresses or ratings', async () => {
    const s = await seedSet();
    await ctx.prisma.locationSnapshot.create({ data: { jobId: (await seedJob('EN_ROUTE', s.online.profile.id)).id, driverId: s.online.profile.id, lat: 9.0444, lng: 38.7555 } });
    const raw = JSON.stringify([(await get(BASE).query({ size: 100 })).body, ...(await Promise.all(Object.values(s).map((d) => get(`${BASE}/${d.profile.id}`)))).map((r) => r.body)]);
    const secrets = [...Object.values(s).flatMap((d) => [d.user.userId, d.user.phone, d.profile.plateNumber!]), 'MOTORBIKE', '9.0301', '38.7401', '9.0123', '38.7654', '9.0444', '38.7555', 'Bole Road', '8.9951'];
    for (const secret of secrets) expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    expect(raw).not.toMatch(/userId|phone|plate|vehicle|serviceArea|radius|"lat|"lng|lastLat|lastLng|maxConcurrent|rating|address|password/i);
  });

  it('read-only: profiles, jobs, offers, history, tracking, proof, COD, disputes, earnings, audit and outbox unchanged; other methods are 404', async () => {
    const s = await seedSet();
    const job = await seedJob('DELIVERED', s.online.profile.id, true);
    await ctx.prisma.jobOffer.create({ data: { jobId: job.id, driverId: s.online.profile.id, status: 'ACCEPTED', expiresAt: t(-5) } });
    await ctx.prisma.deliveryStatusHistory.create({ data: { jobId: job.id, fromStatus: 'EN_ROUTE', toStatus: 'DELIVERED', actorType: 'DRIVER', actorId: s.online.profile.id } });
    const collection = await ctx.prisma.codCollection.create({ data: { jobId: job.id, driverId: s.online.profile.id, orderId: job.orderId, fulfillmentId: job.fulfillmentId, expectedAmount: 100, collectedAmount: 100, method: 'CASH' } });
    await ctx.prisma.codDispute.create({ data: { collectionId: collection.id, reason: 'Short', openedByUserId: admin.userId } });
    await ctx.prisma.driverEarning.create({ data: { driverId: s.online.profile.id, jobId: job.id, orderId: job.orderId, fulfillmentId: job.fulfillmentId, base: 3_000, total: 3_000 } });
    await ctx.prisma.proofOfDelivery.create({ data: { jobId: job.id, orderId: job.orderId, fulfillmentId: job.fulfillmentId, type: 'CONFIRMATION', capturedByDriverId: s.online.profile.id } });
    await ctx.prisma.locationSnapshot.create({ data: { jobId: job.id, driverId: s.online.profile.id, lat: 9.01, lng: 38.76 } });
    const state = async () => ({
      drivers: await ctx.prisma.driverProfile.findMany({ orderBy: { id: 'asc' } }),
      jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
      offers: await ctx.prisma.jobOffer.findMany({ orderBy: { id: 'asc' } }),
      history: await ctx.prisma.deliveryStatusHistory.findMany({ orderBy: { id: 'asc' } }),
      locations: await ctx.prisma.locationSnapshot.findMany({ orderBy: { id: 'asc' } }),
      proofs: await ctx.prisma.proofOfDelivery.findMany({ orderBy: { id: 'asc' } }),
      cod: await ctx.prisma.codCollection.findMany({ orderBy: { id: 'asc' } }),
      disputes: await ctx.prisma.codDispute.findMany({ orderBy: { id: 'asc' } }),
      earnings: await ctx.prisma.driverEarning.findMany({ orderBy: { id: 'asc' } }),
      users: await ctx.prisma.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, updatedAt: true } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await list();
    for (const d of Object.values(s)) await get(`${BASE}/${d.profile.id}`).expect(200);
    const id = s.online.profile.id;
    for (const [method, path] of [
      ['post', BASE], ['put', `${BASE}/${id}`], ['patch', `${BASE}/${id}`], ['delete', `${BASE}/${id}`],
      ['post', `${BASE}/${id}/suspend`], ['post', `${BASE}/${id}/availability`],
    ] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ availability: 'OFFLINE' })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('RBAC: 401 anonymous; 403 for driver, customer, pharmacy, support, finance and analytics-only roles; SUPER_ADMIN allowed; ADMIN alone holds the grant', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.busy.profile.id}`];
    for (const path of paths) expect({ path, status: (await get(path, null)).status }).toEqual({ path, status: 401 });
    const tokens: Array<[string, string]> = [['DRIVER (own profile)', s.busy.user.accessToken]];
    for (const role of ['CUSTOMER', 'PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    const analytics = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'analytics:read' } });
    const r = await ctx.prisma.role.upsert({ where: { key: 'ANALYTICS_VIEWER_TEST' }, update: {}, create: { key: 'ANALYTICS_VIEWER_TEST', name: 'Analytics viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: analytics.id } }, update: {}, create: { roleId: r.id, permissionId: analytics.id } });
    tokens.push(['ANALYTICS_VIEWER_TEST', (await createUserWithRole(ctx, 'ANALYTICS_VIEWER_TEST')).accessToken]);
    for (const [role, token] of tokens) {
      for (const path of paths) expect({ role, path, status: (await get(path, token)).status }).toEqual({ role, path, status: 403 });
    }
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    for (const path of paths) await get(path, superAdmin.accessToken).expect(200);
    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'driver:read:any' } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
  });

  it('Work 36 delivery operations and Work 35 order operations still answer', async () => {
    const s = await seedSet();
    const deliveries = body(await get('/admin/operations/deliveries').query({ size: 100 }).expect(200)) as unknown as { total: number; items: Array<{ driverProfileId: string | null }> };
    expect(deliveries.total).toBe(12);
    expect(deliveries.items.filter((j) => j.driverProfileId === s.busy.profile.id)).toHaveLength(7);
    await get('/admin/operations/orders').expect(200);
  });
});
