import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Summary = { deliveryJobId: string; orderId: string; status: string; isCod: boolean; driverProfileId: string | null } & Record<string, unknown>;
type Page = { items: Summary[]; total: number; page: number; size: number };
const BASE = '/admin/operations/deliveries';

/**
 * Module 16 Work 36 against real PostgreSQL: read-only delivery operations — Module 08 delivery jobs,
 * their timeline and their COD collection state, through Module 08's delivery operations read port.
 */
describe('Admin delivery operations (e2e)', () => {
  let ctx: TestContext;
  let admin: User;
  let driverUser: User;
  let driverProfileId: string;

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
    driverProfileId = (
      await ctx.prisma.driverProfile.create({
        data: { userId: driverUser.userId, vehicleType: 'MOTORBIKE', plateNumber: 'AA-3-PLATE-77', lastLat: 9.0101, lastLng: 38.7613 },
      })
    ).id;
  });

  const get = (path: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(path);
    return token ? r.set(...auth(token)) : r;
  };
  const list = async (query: Record<string, string | number> = {}) => body(await get(BASE).query(query).expect(200)) as unknown as Page;
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  /** A delivery job written as Module 08 stores it, with a status-history row per entry of `path`. */
  async function seedJob(o: { status: string; createdAt: Date; orderId?: string; isCod?: boolean; assigned?: boolean; path?: Array<[string, Date]> }) {
    const job = await ctx.prisma.deliveryJob.create({
      data: {
        orderId: o.orderId ?? randomUUID(),
        fulfillmentId: randomUUID(),
        pharmacyId: randomUUID(),
        branchId: randomUUID(),
        pickupLat: 9.0301,
        pickupLng: 38.7401,
        pickupAddress: 'Piassa Pharmacy, Churchill Ave',
        dropoffLat: 8.9951,
        dropoffLng: 38.7899,
        dropoffAddress: 'Bole Road 42, House 7',
        items: [{ catalogProductId: randomUUID(), name: 'Insulin glargine', quantity: 1 }],
        assignedDriverId: o.assigned ? driverProfileId : null,
        status: o.status as never,
        isCod: o.isCod ?? false,
        codAmount: o.isCod ? 12_500 : null,
        deliveryFee: 1_500,
        createdAt: o.createdAt,
      },
    });
    let from: string | null = null;
    for (const [to, at] of o.path ?? []) {
      await ctx.prisma.deliveryStatusHistory.create({
        data: { jobId: job.id, fromStatus: from, toStatus: to, actorType: 'DRIVER', actorId: driverProfileId, reason: 'Customer not home, gate code 4471', lat: 8.9952, lng: 38.7898, createdAt: at },
      });
      from = to;
    }
    return job;
  }

  async function seedSet() {
    const orderA = randomUUID();
    const created = await seedJob({ status: 'CREATED', createdAt: t(50), orderId: orderA });
    const enRoute = await seedJob({
      status: 'EN_ROUTE', createdAt: t(40), orderId: orderA, isCod: true, assigned: true,
      path: [['OFFERED', t(39)], ['ASSIGNED', t(38)], ['ARRIVED_PICKUP', t(35)], ['PICKED_UP', t(33)], ['EN_ROUTE', t(32)]],
    });
    const failed = await seedJob({ status: 'FAILED', createdAt: t(30), assigned: true, path: [['ASSIGNED', t(29)], ['FAILED', t(25)]] });
    const cancelled = await seedJob({ status: 'CANCELLED', createdAt: t(20), path: [['CANCELLED', t(19)]] });
    const delivered = await seedJob({
      status: 'DELIVERED', createdAt: t(10), isCod: true, assigned: true,
      path: [['ASSIGNED', t(9)], ['PICKED_UP', t(7)], ['DELIVERED', t(2)]],
    });
    await ctx.prisma.deliveryJob.update({ where: { id: delivered.id }, data: { pickedUpAt: t(7), deliveredAt: t(2) } });
    return { orderA, created, enRoute, failed, cancelled, delivered };
  }

  async function seedCod(jobId: string, orderId: string) {
    const collection = await ctx.prisma.codCollection.create({
      data: {
        jobId, driverId: driverProfileId, orderId, fulfillmentId: randomUUID(), expectedAmount: 12_500, collectedAmount: 12_000,
        method: 'ELECTRONIC', providerReference: 'TELEBIRR-TXN-SECRET-9', settlementRef: 'SETTLE-REF-SECRET',
      },
    });
    await ctx.prisma.codDispute.create({ data: { collectionId: collection.id, reason: 'Driver says customer paid less', openedByUserId: admin.userId } });
    return collection;
  }

  it('an empty list', async () => {
    expect(await list()).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('lists newest first with exact fields and Module 08’s stored status', async () => {
    const s = await seedSet();
    const res = await list();
    expect(res.total).toBe(5);
    expect(res.items.map((i) => i.deliveryJobId)).toEqual([s.delivered.id, s.cancelled.id, s.failed.id, s.enRoute.id, s.created.id]);
    const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: s.enRoute.id } });
    expect(res.items.find((i) => i.deliveryJobId === s.enRoute.id)).toEqual({
      deliveryJobId: row.id,
      orderId: row.orderId,
      fulfillmentId: row.fulfillmentId,
      pharmacyId: row.pharmacyId,
      branchId: row.branchId,
      status: 'EN_ROUTE',
      driverProfileId,
      isCod: true,
      isColdChain: false,
      etaAt: null,
      pickedUpAt: null,
      deliveredAt: null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    expect(res.items.find((i) => i.deliveryJobId === s.created.id)!.driverProfileId).toBeNull();
  });

  it('filters by status, order id, isCod (including false) and created window; pages stably; rejects bad input', async () => {
    const s = await seedSet();
    expect((await list({ status: 'FAILED' })).items.map((i) => i.deliveryJobId)).toEqual([s.failed.id]);
    expect((await list({ status: 'COMPLETED' })).total).toBe(0);
    expect((await list({ orderId: s.orderA })).items.map((i) => i.deliveryJobId)).toEqual([s.enRoute.id, s.created.id]);
    expect((await list({ isCod: 'true' })).items.map((i) => i.deliveryJobId)).toEqual([s.delivered.id, s.enRoute.id]);
    expect((await list({ isCod: 'false' })).total).toBe(3);
    expect((await list({ createdFrom: t(35).toISOString(), createdTo: t(15).toISOString() })).items.map((i) => i.deliveryJobId)).toEqual([s.cancelled.id, s.failed.id]);
    const pages = [await list({ size: 2, page: 1 }), await list({ size: 2, page: 2 }), await list({ size: 2, page: 3 })];
    expect(pages.map((p) => p.total)).toEqual([5, 5, 5]);
    expect(pages.flatMap((p) => p.items.map((i) => i.deliveryJobId))).toEqual((await list()).items.map((i) => i.deliveryJobId));
    for (const bad of [{ status: 'DISPATCHED' }, { status: 'READY' }, { orderId: 'ORD-1' }, { isCod: 'maybe' }, { page: 0 }, { size: 101 }, { createdFrom: 'yesterday' }, { driverId: driverProfileId }, { q: 'Bole' }]) {
      expect({ bad, status: (await get(BASE).query(bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: Module 08 timeline (first entries, column timestamps) and COD collection state', async () => {
    const s = await seedSet();
    const cod = await seedCod(s.delivered.id, s.delivered.orderId);
    const d = body(await get(`${BASE}/${s.delivered.id}`).expect(200)) as Record<string, unknown>;
    const row = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: s.delivered.id } });
    expect(d).toMatchObject({ deliveryJobId: s.delivered.id, status: 'DELIVERED', driverProfileId, isCod: true, pickedUpAt: row.pickedUpAt!.toISOString(), deliveredAt: row.deliveredAt!.toISOString() });
    const history = await ctx.prisma.deliveryStatusHistory.findMany({ where: { jobId: s.delivered.id } });
    const at = (to: string) => history.find((h) => h.toStatus === to)!.createdAt.toISOString();
    expect(d.timeline).toEqual({
      assignedAt: at('ASSIGNED'), arrivedPickupAt: null, pickedUpAt: row.pickedUpAt!.toISOString(), enRouteAt: null, arrivedDropoffAt: null,
      deliveredAt: row.deliveredAt!.toISOString(), completedAt: null, failedAt: null, cancelledAt: null,
    });
    expect(d.cod).toEqual({
      collectionId: cod.id, status: 'COLLECTED', method: 'ELECTRONIC', expectedAmount: 12_500, collectedAmount: 12_000, currency: 'ETB',
      collectedAt: cod.collectedAt.toISOString(), remittedAt: null, reconciledAt: null,
    });
    const failed = body(await get(`${BASE}/${s.failed.id}`).expect(200)) as { status: string; timeline: Record<string, string | null>; cod: unknown };
    expect(failed.status).toBe('FAILED');
    expect(failed.timeline.failedAt).toBe((await ctx.prisma.deliveryStatusHistory.findFirstOrThrow({ where: { jobId: s.failed.id, toStatus: 'FAILED' } })).createdAt.toISOString());
    expect(failed.cod).toBeNull();
  });

  it('reports the job’s own status, not the order’s or fulfillment’s', async () => {
    // A Module 06 order and fulfillment that say DELIVERED, and the job that says EN_ROUTE.
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID().slice(0, 8)}`, customerUserId: customer.userId, status: 'DELIVERED', subtotal: 1, grandTotal: 1, currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`, beneficiarySnapshot: {}, addressSnapshot: {},
      },
    });
    const job = await seedJob({ status: 'EN_ROUTE', createdAt: t(5), orderId: order.id, assigned: true });
    await ctx.prisma.fulfillment.create({ data: { orderId: order.id, pharmacyId: job.pharmacyId, branchId: job.branchId, status: 'DELIVERED', deliveryJobId: job.id } });
    expect((body(await get(`${BASE}/${job.id}`).expect(200)) as { status: string }).status).toBe('EN_ROUTE');
    expect((await list({ orderId: order.id })).items.map((i) => i.status)).toEqual(['EN_ROUTE']);
  });

  it('unknown job → 404; malformed id → 400', async () => {
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/not-a-uuid`).expect(400);
  });

  it('privacy: no address, coordinates, manifest, driver person, history reason, proof, provider or settlement reference', async () => {
    const s = await seedSet();
    await seedCod(s.delivered.id, s.delivered.orderId);
    await ctx.prisma.proofOfDelivery.create({
      data: { jobId: s.delivered.id, orderId: s.delivered.orderId, fulfillmentId: s.delivered.fulfillmentId, type: 'PHOTO', recipientName: 'Almaz Tesfaye', capturedByDriverId: driverProfileId, artifactRef: 'pod/secret-photo.jpg' },
    });
    await ctx.prisma.locationSnapshot.create({ data: { jobId: s.enRoute.id, driverId: driverProfileId, lat: 9.0123, lng: 38.7654 } });
    const raw = JSON.stringify([
      (await get(BASE).query({ size: 100 })).body,
      ...(await Promise.all(Object.values(s).filter((j) => typeof j !== 'string').map((j) => get(`${BASE}/${(j as { id: string }).id}`)))).map((r) => r.body),
    ]);
    for (const secret of [
      driverUser.userId, driverUser.phone, 'AA-3-PLATE', 'MOTORBIKE', 'Piassa', 'Churchill', 'Bole Road', 'House 7', 'Insulin', 'gate code',
      'Customer not home', 'Almaz', 'secret-photo', 'TELEBIRR-TXN', 'SETTLE-REF', 'paid less', '9.0101', '38.7613', '8.9951', '38.7899', '8.9952', '9.0123', '38.7654',
    ]) {
      expect({ secret: String(secret).slice(0, 12), found: raw.includes(String(secret)) }).toEqual({ secret: String(secret).slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/address|"lat|"lng|manifest|recipient|artifact|providerReference|settlementRef|reason|plate|vehicle|codAmount|deliveryFee/i);
  });

  it('read-only: jobs, history, tracking, proof, COD, disputes, earnings, offers, audit and outbox unchanged by reads; other methods are 404', async () => {
    const s = await seedSet();
    await seedCod(s.delivered.id, s.delivered.orderId);
    await ctx.prisma.driverEarning.create({ data: { driverId: driverProfileId, jobId: s.delivered.id, orderId: s.delivered.orderId, fulfillmentId: s.delivered.fulfillmentId, base: 3_000, total: 3_000 } });
    await ctx.prisma.locationSnapshot.create({ data: { jobId: s.enRoute.id, driverId: driverProfileId, lat: 9.01, lng: 38.76 } });
    const state = async () => ({
      jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
      history: await ctx.prisma.deliveryStatusHistory.findMany({ orderBy: { id: 'asc' } }),
      locations: await ctx.prisma.locationSnapshot.findMany({ orderBy: { id: 'asc' } }),
      proofs: await ctx.prisma.proofOfDelivery.findMany({ orderBy: { id: 'asc' } }),
      cod: await ctx.prisma.codCollection.findMany({ orderBy: { id: 'asc' } }),
      remittances: await ctx.prisma.codRemittance.count(),
      reconciliations: await ctx.prisma.codReconciliation.count(),
      corrections: await ctx.prisma.codCorrection.count(),
      disputes: await ctx.prisma.codDispute.findMany({ orderBy: { id: 'asc' } }),
      earnings: await ctx.prisma.driverEarning.findMany({ orderBy: { id: 'asc' } }),
      offers: await ctx.prisma.jobOffer.count(),
      drivers: await ctx.prisma.driverProfile.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await list();
    for (const j of [s.created, s.enRoute, s.failed, s.cancelled, s.delivered]) await get(`${BASE}/${j.id}`).expect(200);
    const id = s.enRoute.id;
    for (const [method, path] of [
      ['post', BASE], ['put', `${BASE}/${id}`], ['patch', `${BASE}/${id}`], ['delete', `${BASE}/${id}`],
      ['post', `${BASE}/${id}/reassign`], ['post', `${BASE}/${id}/cancel`],
    ] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ status: 'DELIVERED' })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('RBAC: 401 anonymous; 403 for driver, customer, pharmacy, support, finance and analytics-only roles; SUPER_ADMIN allowed; ADMIN alone holds the grant', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.enRoute.id}`];
    for (const path of paths) expect({ path, status: (await get(path, null)).status }).toEqual({ path, status: 401 });
    const tokens: Array<[string, string]> = [['DRIVER', driverUser.accessToken]];
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
    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'delivery:read:any' } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
  });

  it('Work 35 order operations and Work 06 COD dispute endpoints still answer', async () => {
    const s = await seedSet();
    await seedCod(s.delivered.id, s.delivered.orderId);
    await get('/admin/operations/orders').expect(200);
    const disputes = body(await get('/admin/cod-disputes').expect(200)) as unknown as { items: Array<{ disputeId?: string; id?: string }> };
    expect(disputes.items).toHaveLength(1);
    const disputeId = (await ctx.prisma.codDispute.findFirstOrThrow()).id;
    await get(`/admin/cod-disputes/${disputeId}`).expect(200);
  });
});
