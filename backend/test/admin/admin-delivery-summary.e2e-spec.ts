import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Summary = {
  generatedAt: string;
  jobs: { total: number; byStatus: Record<string, number>; nonTerminalCount: number; oldestNonTerminalCreatedAt: string | null; oldestNonTerminalAgeSeconds: number | null };
  assignment: { unassignedCount: number };
};
const PATH = '/admin/operations/deliveries/summary';
const STATUSES = ['CREATED', 'OFFERED', 'ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF', 'DELIVERED', 'COMPLETED', 'REASSIGNING', 'CANCELLED', 'FAILED'];
const TERMINAL = ['COMPLETED', 'CANCELLED', 'FAILED'];
/** The statuses `DeliveryJob` requires a driver on (`DeliveryStatusPolicy.requiresAssignedDriver`). */
const WITH_DRIVER = ['ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF', 'DELIVERED', 'COMPLETED'];

/**
 * Module 16 Work 40 against real PostgreSQL: the delivery backlog and aging summary — counts and
 * timestamps over Module 08's `delivery_jobs`.
 */
describe('Admin delivery backlog summary (e2e)', () => {
  let ctx: TestContext;
  let admin: User;
  let driverUser: User;
  let driverId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    driverUser = await createUserWithRole(ctx, 'DRIVER');
    driverId = (await ctx.prisma.driverProfile.create({ data: { userId: driverUser.userId, plateNumber: 'AA-3-PLATE-88', lastLat: 9.0101, lastLng: 38.7613 } })).id;
  });

  const get = (token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(PATH);
    return token ? r.set(...auth(token)) : r;
  };
  const summary = async (token = admin.accessToken) => body(await get(token).expect(200)) as unknown as Summary;
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  function job(status: string, createdAt: Date, assigned = WITH_DRIVER.includes(status), etaAt: Date | null = null) {
    return ctx.prisma.deliveryJob.create({
      data: {
        orderId: randomUUID(), fulfillmentId: randomUUID(), pharmacyId: randomUUID(), branchId: randomUUID(), status: status as never, createdAt, etaAt,
        assignedDriverId: assigned ? driverId : null, dropoffAddress: 'Bole Road 42, House 7', dropoffLat: 8.9951, dropoffLng: 38.7899, pickupAddress: 'Piassa Pharmacy',
      },
    });
  }

  /** One job in every status (oldest first in declaration order), plus a second CREATED and a long-ago COMPLETED. */
  async function seedSet() {
    const jobs: Record<string, { id: string; createdAt: Date }> = {};
    let minutes = 1_000;
    for (const s of STATUSES) jobs[s] = await job(s, t((minutes -= 10)));
    const extraCreated = await job('CREATED', t(5));
    // Older than everything, but terminal: never the oldest non-terminal.
    await job('COMPLETED', t(10_000));
    return { jobs, extraCreated };
  }

  it('empty dataset: zeros, all 12 statuses zero-filled, oldest timestamp and age null', async () => {
    const s = await summary();
    expect(Date.parse(s.generatedAt)).not.toBeNaN();
    expect(s.jobs).toEqual({ total: 0, byStatus: Object.fromEntries(STATUSES.map((k) => [k, 0])), nonTerminalCount: 0, oldestNonTerminalCreatedAt: null, oldestNonTerminalAgeSeconds: null });
    expect(s.assignment).toEqual({ unassignedCount: 0 });
  });

  it('every status counted; non-terminal, oldest non-terminal and unassigned match the expected figures and the persisted rows', async () => {
    const { jobs } = await seedSet();
    const s = await summary();
    expect(s.jobs.total).toBe(14);
    expect(Object.keys(s.jobs.byStatus)).toEqual(STATUSES);
    expect(s.jobs.byStatus).toEqual({ ...Object.fromEntries(STATUSES.map((k) => [k, 1])), CREATED: 2, COMPLETED: 2 });
    expect(s.jobs.nonTerminalCount).toBe(10); // 9 non-terminal statuses + the extra CREATED; DELIVERED counts, it still moves to COMPLETED
    expect(s.jobs.oldestNonTerminalCreatedAt).toBe(jobs.CREATED.createdAt.toISOString());
    // Unassigned among non-terminal: CREATED ×2, OFFERED, REASSIGNING (each has no driver, as Module 08 leaves them).
    expect(s.assignment.unassignedCount).toBe(4);

    // Independently from the stored rows.
    const rows = await ctx.prisma.deliveryJob.findMany({ select: { status: true, createdAt: true, assignedDriverId: true } });
    const open = rows.filter((r) => !TERMINAL.includes(r.status));
    expect(s.jobs.total).toBe(rows.length);
    for (const st of STATUSES) expect({ st, n: s.jobs.byStatus[st] }).toEqual({ st, n: rows.filter((r) => r.status === st).length });
    expect(s.jobs.nonTerminalCount).toBe(open.length);
    expect(s.jobs.oldestNonTerminalCreatedAt).toBe(new Date(Math.min(...open.map((r) => r.createdAt.getTime()))).toISOString());
    expect(s.assignment.unassignedCount).toBe(open.filter((r) => r.assignedDriverId === null).length);
  });

  it('oldest non-terminal age: whole seconds to generatedAt; 0 for a future createdAt; null when every job is terminal', async () => {
    const { jobs } = await seedSet();
    const s = await summary();
    const expected = Math.floor((Date.parse(s.generatedAt) - jobs.CREATED.createdAt.getTime()) / 1000);
    expect(Number.isInteger(s.jobs.oldestNonTerminalAgeSeconds)).toBe(true);
    expect(Math.abs(s.jobs.oldestNonTerminalAgeSeconds! - expected)).toBeLessThanOrEqual(1);
    // Close every non-terminal job, then leave one with a createdAt in the future: never negative.
    await ctx.prisma.deliveryJob.updateMany({ where: { status: { notIn: TERMINAL as never[] } }, data: { status: 'CANCELLED' } });
    const future = await job('CREATED', t(-10));
    expect((await summary()).jobs.oldestNonTerminalAgeSeconds).toBe(0);
    await ctx.prisma.deliveryJob.update({ where: { id: future.id }, data: { status: 'CANCELLED' } });
    const none = await summary();
    expect([none.jobs.nonTerminalCount, none.jobs.oldestNonTerminalCreatedAt, none.jobs.oldestNonTerminalAgeSeconds, none.assignment.unassignedCount]).toEqual([0, null, null, 0]);
  });

  it('assignment is the driver column, not the status: an ASSIGNED-status row without a driver still counts as unassigned', async () => {
    await job('ASSIGNED', t(30), false);
    await job('ASSIGNED', t(20), true);
    await job('CANCELLED', t(10), false);
    expect((await summary()).assignment.unassignedCount).toBe(1);
  });

  it('no ETA metric is reported, whatever etaAt holds', async () => {
    await job('EN_ROUTE', t(60), true, t(30));
    const s = await summary();
    expect(Object.keys(s)).toEqual(['generatedAt', 'jobs', 'assignment']);
    expect(JSON.stringify(s)).not.toMatch(/eta|overdue/i);
  });

  it('privacy: counts and timestamps only', async () => {
    await seedSet();
    const rows = await ctx.prisma.deliveryJob.findMany();
    const raw = JSON.stringify(await summary());
    for (const secret of [...rows.flatMap((r) => [r.id, r.orderId, r.fulfillmentId, r.pharmacyId, r.branchId]), driverId, driverUser.userId, driverUser.phone, 'Bole', 'Piassa', '8.9951', '38.7899', '9.0101', 'AA-3']) {
      expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
    expect(raw).not.toMatch(/Id"|address|lat"|lng"/i);
  });

  it('read-only: jobs, history, offers, tracking, proof, COD, disputes, earnings, drivers, audit and outbox unchanged; other methods do not mutate', async () => {
    const { jobs } = await seedSet();
    const delivered = jobs.DELIVERED.id;
    const d = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: delivered } });
    await ctx.prisma.deliveryStatusHistory.create({ data: { jobId: delivered, fromStatus: 'ARRIVED_DROPOFF', toStatus: 'DELIVERED', actorType: 'DRIVER', actorId: driverId } });
    await ctx.prisma.jobOffer.create({ data: { jobId: jobs.OFFERED.id, driverId, expiresAt: t(-5) } });
    await ctx.prisma.locationSnapshot.create({ data: { jobId: jobs.EN_ROUTE.id, driverId, lat: 9.02, lng: 38.75 } });
    await ctx.prisma.proofOfDelivery.create({ data: { jobId: delivered, orderId: d.orderId, fulfillmentId: d.fulfillmentId, type: 'CONFIRMATION', capturedByDriverId: driverId } });
    const col = await ctx.prisma.codCollection.create({ data: { jobId: delivered, driverId, orderId: d.orderId, fulfillmentId: d.fulfillmentId, expectedAmount: 100, collectedAmount: 100, method: 'CASH' } });
    await ctx.prisma.codDispute.create({ data: { collectionId: col.id, reason: 'x', openedByUserId: admin.userId } });
    await ctx.prisma.driverEarning.create({ data: { driverId, jobId: delivered, orderId: d.orderId, fulfillmentId: d.fulfillmentId, base: 1_000, total: 1_000 } });
    const state = async () => ({
      jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
      history: await ctx.prisma.deliveryStatusHistory.findMany({ orderBy: { id: 'asc' } }),
      offers: await ctx.prisma.jobOffer.findMany({ orderBy: { id: 'asc' } }),
      locations: await ctx.prisma.locationSnapshot.findMany({ orderBy: { id: 'asc' } }),
      proofs: await ctx.prisma.proofOfDelivery.findMany({ orderBy: { id: 'asc' } }),
      cod: await ctx.prisma.codCollection.findMany({ orderBy: { id: 'asc' } }),
      disputes: await ctx.prisma.codDispute.findMany({ orderBy: { id: 'asc' } }),
      earnings: await ctx.prisma.driverEarning.findMany({ orderBy: { id: 'asc' } }),
      drivers: await ctx.prisma.driverProfile.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await summary();
    await summary();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const status = (await request(ctx.server)[method](PATH).set(...auth(admin.accessToken)).send({ status: 'CANCELLED' })).status;
      expect({ method, status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('summary is not taken for a job id; Work 36 list/detail and Work 37 drivers still answer', async () => {
    const { jobs } = await seedSet();
    expect(Object.keys(await summary())).toEqual(['generatedAt', 'jobs', 'assignment']);
    const authed = (path: string) => request(ctx.server).get(path).set(...auth(admin.accessToken));
    expect((body(await authed('/admin/operations/deliveries').query({ size: 100 }).expect(200)) as unknown as { total: number }).total).toBe(14);
    const detail = body(await authed(`/admin/operations/deliveries/${jobs.EN_ROUTE.id}`).expect(200)) as { deliveryJobId: string; status: string };
    expect([detail.deliveryJobId, detail.status]).toEqual([jobs.EN_ROUTE.id, 'EN_ROUTE']);
    await authed('/admin/operations/deliveries/not-a-uuid').expect(400);
    await authed('/admin/operations/drivers').expect(200);
    await authed(`/admin/operations/drivers/${driverId}`).expect(200);
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; driver, customer, pharmacy, support, finance and analytics-only roles 403', async () => {
    await seedSet();
    expect((await get((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken)).status).toBe(200);
    expect((await get(null)).status).toBe(401);
    const tokens: Array<[string, string]> = [['DRIVER', driverUser.accessToken]];
    for (const role of ['CUSTOMER', 'PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    const analytics = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'analytics:read' } });
    const r = await ctx.prisma.role.upsert({ where: { key: 'ANALYTICS_VIEWER_TEST' }, update: {}, create: { key: 'ANALYTICS_VIEWER_TEST', name: 'Analytics viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: analytics.id } }, update: {}, create: { roleId: r.id, permissionId: analytics.id } });
    tokens.push(['ANALYTICS_VIEWER_TEST', (await createUserWithRole(ctx, 'ANALYTICS_VIEWER_TEST')).accessToken]);
    for (const [role, token] of tokens) expect({ role, status: (await get(token)).status }).toEqual({ role, status: 403 });
  });
});
