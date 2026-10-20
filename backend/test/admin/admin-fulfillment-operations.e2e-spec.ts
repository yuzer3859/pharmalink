import { randomUUID } from 'crypto';
import request from 'supertest';
import { DeliveryJobReferenceReconciler } from '../../src/modules/orders/infrastructure/scheduling/delivery-job-reference.reconciler';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder } from '../orders/support';

type User = RegisteredUser & Tokens;
type Item = { fulfillmentId: string; orderId: string; pharmacyId: string; branchId: string; status: string; deliveryJobId: string | null; hasDeliveryJobReference: boolean } & Record<string, unknown>;
type Page = { items: Item[]; total: number; page: number; size: number };
const BASE = '/admin/operations/fulfillments';

/**
 * Module 16 Work 46 against real PostgreSQL: read-only fulfillment operations over Module 06's
 * `fulfillments`, with the recorded delivery-job reference.
 */
describe('Admin fulfillment operations (e2e)', () => {
  let ctx: TestContext;
  let admin: User;
  let customer: User;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    customer = await createUserWithRole(ctx, 'CUSTOMER');
  });

  const get = (path: string, query: Record<string, string | number> = {}, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(path).query(query);
    return token ? r.set(...auth(token)) : r;
  };
  const list = async (query: Record<string, string | number> = {}) => body(await get(BASE, { size: 100, ...query }).expect(200)) as unknown as Page;
  const ids = (p: Page) => p.items.map((i) => i.fulfillmentId);
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  async function order(specs: Array<{ status: string; ref: boolean; minutesAgo: number; pharmacyId?: string }>, orderStatus = 'READY') {
    const o = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`, customerUserId: customer.userId, status: orderStatus as never, grandTotal: 10_000, currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`, beneficiarySnapshot: { fullName: 'Abebe Kebede', phone: '+251911555444' }, addressSnapshot: { line1: 'Bole Road 42' },
      },
    });
    const fulfillments = [];
    for (const s of specs) {
      fulfillments.push(await ctx.prisma.fulfillment.create({
        data: { orderId: o.id, pharmacyId: s.pharmacyId ?? randomUUID(), branchId: randomUUID(), status: s.status as never, deliveryJobId: s.ref ? randomUUID() : null, createdAt: t(s.minutesAgo), readyAt: s.status === 'READY' ? t(s.minutesAgo - 1) : null },
      }));
    }
    return { ...o, fulfillments };
  }

  async function seedSet() {
    const pharmacy = randomUUID();
    const linked = await order([{ status: 'READY', ref: true, minutesAgo: 90, pharmacyId: pharmacy }]);
    const mixed = await order([{ status: 'READY', ref: true, minutesAgo: 80, pharmacyId: pharmacy }, { status: 'READY', ref: false, minutesAgo: 70 }]);
    const unlinked = await order([{ status: 'READY', ref: false, minutesAgo: 60 }]);
    const early = await order([{ status: 'ACCEPTED', ref: false, minutesAgo: 50 }, { status: 'CANCELLED', ref: false, minutesAgo: 40 }], 'ACCEPTED');
    return { pharmacy, linked, mixed, unlinked, early };
  }

  it('an empty list', async () => {
    expect(body(await get(BASE).expect(200))).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('lists every fulfillment as its own row, newest first, with exact fields cross-checked against the rows', async () => {
    const s = await seedSet();
    const res = await list();
    const rows = await ctx.prisma.fulfillment.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    expect(res.total).toBe(6);
    expect(ids(res)).toEqual(rows.map((r) => r.id));
    for (const item of res.items) {
      const r = rows.find((x) => x.id === item.fulfillmentId)!;
      expect(item).toEqual({
        fulfillmentId: r.id, orderId: r.orderId, pharmacyId: r.pharmacyId, branchId: r.branchId, status: r.status, deliveryJobId: r.deliveryJobId,
        hasDeliveryJobReference: r.deliveryJobId !== null, acceptedAt: r.acceptedAt?.toISOString() ?? null, readyAt: r.readyAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
      });
    }
    // The mixed order is two rows with different flags — fulfillments are never merged into their order.
    const mixedRows = res.items.filter((i) => i.orderId === s.mixed.id);
    expect(mixedRows.map((i) => i.hasDeliveryJobReference).sort()).toEqual([false, true]);
  });

  it('filters by status, order, pharmacy, branch, reference and created/ready windows; pages stably; rejects bad input', async () => {
    const s = await seedSet();
    expect((await list({ status: 'READY' })).total).toBe(4);
    expect(new Set(ids(await list({ status: 'CANCELLED' })))).toEqual(new Set([s.early.fulfillments[1].id]));
    expect(new Set(ids(await list({ orderId: s.mixed.id })))).toEqual(new Set(s.mixed.fulfillments.map((f) => f.id)));
    expect(new Set(ids(await list({ pharmacyId: s.pharmacy })))).toEqual(new Set([s.linked.fulfillments[0].id, s.mixed.fulfillments[0].id]));
    expect(ids(await list({ branchId: s.unlinked.fulfillments[0].branchId }))).toEqual([s.unlinked.fulfillments[0].id]);
    expect(new Set(ids(await list({ hasDeliveryJobReference: 'true' })))).toEqual(new Set([s.linked.fulfillments[0].id, s.mixed.fulfillments[0].id]));
    expect((await list({ hasDeliveryJobReference: 'false' })).total).toBe(4);
    expect(new Set(ids(await list({ status: 'READY', hasDeliveryJobReference: 'false' })))).toEqual(new Set([s.mixed.fulfillments[1].id, s.unlinked.fulfillments[0].id]));
    expect(ids(await list({ createdFrom: t(75).toISOString(), createdTo: t(55).toISOString() }))).toEqual([s.unlinked.fulfillments[0].id, s.mixed.fulfillments[1].id]);
    expect(ids(await list({ readyFrom: t(85).toISOString() }))).toEqual([s.unlinked.fulfillments[0].id, s.mixed.fulfillments[1].id, s.mixed.fulfillments[0].id]);
    const [p1, p2] = await Promise.all([1, 2].map((page) => list({ size: 4, page })));
    expect([p1.total, p2.total]).toEqual([6, 6]);
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(await list()));
    for (const bad of <Array<Record<string, string | number>>>[
      { status: 'EN_ROUTE' }, { status: 'ready' }, { orderId: 'ORD-1' }, { pharmacyId: 'ph-1' }, { branchId: '7' }, { hasDeliveryJobReference: 'TRUE' }, { hasDeliveryJobReference: '' },
      { createdFrom: 'yesterday' }, { readyTo: 'soon' }, { page: 0 }, { size: 101 }, { deliveryJobId: randomUUID() }, { q: 'Abebe' },
    ]) {
      expect({ bad, status: (await get(BASE, bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: one fulfillment with its order id and recorded job id; unknown → 404; malformed → 400', async () => {
    const s = await seedSet();
    const f = s.mixed.fulfillments[0];
    const d = body(await get(`${BASE}/${f.id}`).expect(200)) as unknown as Item;
    expect(d).toMatchObject({ fulfillmentId: f.id, orderId: s.mixed.id, deliveryJobId: f.deliveryJobId, hasDeliveryJobReference: true, status: 'READY' });
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/summary`).expect(400); // a reserved-looking segment is never taken for an id
    await get(`${BASE}/${s.mixed.id}`).expect(404); // an order id is not a fulfillment id
  });

  it('a real Module 08 job with a missing reference: shown as null/false (not "no job"); the GET repairs nothing; Work 45 does, and the view follows', async () => {
    const placed = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${placed.fulfillmentId}/${action}`).set(...auth(placed.pharmacy.accessToken)).expect(200);
    }
    await ctx.drainOutbox();
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { fulfillmentId: placed.fulfillmentId } });
    await ctx.prisma.fulfillment.update({ where: { id: placed.fulfillmentId }, data: { deliveryJobId: null } }); // a missed reference

    const missing = body(await get(`${BASE}/${placed.fulfillmentId}`).expect(200)) as unknown as Item;
    expect([missing.deliveryJobId, missing.hasDeliveryJobReference]).toEqual([null, false]);
    expect(missing).not.toHaveProperty('deliveryStatus');
    await get(`${BASE}/${placed.fulfillmentId}`).expect(200);
    expect((await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id: placed.fulfillmentId } })).deliveryJobId).toBeNull(); // reading did not repair it
    expect((await get(`/admin/operations/deliveries/${job.id}`).expect(200)).body).toBeDefined(); // the job exists all along (Work 36)

    expect(await ctx.app.get(DeliveryJobReferenceReconciler).run()).toMatchObject({ populated: 1 }); // Work 45, run explicitly here
    const repaired = body(await get(`${BASE}/${placed.fulfillmentId}`).expect(200)) as unknown as Item;
    expect([repaired.deliveryJobId, repaired.hasDeliveryJobReference]).toEqual([job.id, true]);
    const delivery = body(await get(`/admin/operations/deliveries/${repaired.deliveryJobId}`).expect(200)) as { fulfillmentId: string };
    expect(delivery.fulfillmentId).toBe(placed.fulfillmentId); // navigation lands on the matching Work 36 record
    const order = body(await get(`/admin/operations/orders/${repaired.orderId}`).expect(200)) as { fulfillments: Array<{ deliveryJobId: string | null }> };
    expect(order.fulfillments.map((f) => f.deliveryJobId)).toEqual([job.id]); // and on Work 35
  });

  it('privacy: fulfillment fields only — no customer, beneficiary, address, payment or driver data', async () => {
    await seedSet();
    const responses: unknown[] = [await list()];
    // Sequential, not Promise.all: each supertest call against the unbound server opens its own ephemeral listener (ECONNRESET on CI).
    for (const f of await ctx.prisma.fulfillment.findMany()) responses.push((await get(`${BASE}/${f.id}`)).body);
    const raw = JSON.stringify(responses);
    for (const secret of [customer.userId, customer.phone, 'Abebe', '+251911555444', 'Bole', 'checkout-']) {
      expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
    expect(raw).not.toMatch(/customerUserId|beneficiary|address|grandTotal|paymentId|driver|lat"|lng"/i);
  });

  it('read-only: orders, fulfillments, delivery jobs, history, tracking, COD, audit and outbox unchanged; other methods are 404', async () => {
    const s = await seedSet();
    const state = async () => ({
      orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
      fulfillments: await ctx.prisma.fulfillment.findMany({ orderBy: { id: 'asc' } }),
      jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
      jobHistory: await ctx.prisma.deliveryStatusHistory.count(),
      locations: await ctx.prisma.locationSnapshot.count(),
      cod: await ctx.prisma.codCollection.count(),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await list();
    await list({ hasDeliveryJobReference: 'false' });
    for (const f of s.mixed.fulfillments) await get(`${BASE}/${f.id}`).expect(200);
    const id = s.unlinked.fulfillments[0].id;
    for (const [method, path] of [['post', BASE], ['put', `${BASE}/${id}`], ['patch', `${BASE}/${id}`], ['delete', `${BASE}/${id}`], ['post', `${BASE}/${id}/reconcile`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ deliveryJobId: randomUUID() })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; pharmacy, driver, customer, support, finance 403; Work 42–44 still answer', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.linked.fulfillments[0].id}`];
    const sup = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    for (const path of paths) {
      expect((await get(path, {}, null)).status).toBe(401);
      expect((await get(path, {}, sup)).status).toBe(200);
    }
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'DRIVER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      const token = (await createUserWithRole(ctx, role)).accessToken;
      for (const path of paths) expect({ role, path, status: (await get(path, {}, token)).status }).toEqual({ role, path, status: 403 });
    }
    const summary = body(await get('/admin/operations/orders/summary').expect(200)) as { readyHandoff: Record<string, number> };
    expect(summary.readyHandoff).toMatchObject({ readyOrdersWithDeliveryJob: 2, readyOrdersWithoutDeliveryJob: 1 });
    const partial = body(await get('/admin/operations/orders', { hasDeliveryJobReference: 'true', hasUnreferencedFulfillment: 'true' }).expect(200)) as { items: Array<{ orderId: string }> };
    expect(partial.items.map((i) => i.orderId)).toEqual([s.mixed.id]);
  });
});
