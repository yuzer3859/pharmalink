import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Row = { orderId: string; status: string; fulfillmentCount: number; hasDeliveryJobReference: boolean; unreferencedFulfillmentCount: number } & Record<string, unknown>;
type Page = { items: Row[]; total: number; page: number; size: number };
const BASE = '/admin/operations/orders';

/**
 * Module 16 Work 44 against real PostgreSQL: `unreferencedFulfillmentCount` on every order-list row and
 * the `hasUnreferencedFulfillment` filter, from Module 06's `fulfillments.deliveryJobId`.
 */
describe('Admin partial fulfillment handoff (e2e)', () => {
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

  const get = (query: Record<string, string | number>) => request(ctx.server).get(BASE).query(query).set(...auth(admin.accessToken));
  const list = async (query: Record<string, string | number> = {}) => body(await get({ size: 100, ...query }).expect(200)) as unknown as Page;
  const ids = (p: Page) => p.items.map((i) => i.orderId);
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  async function order(status: string, refs: boolean[], minutesAgo: number) {
    const o = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`, customerUserId: customer.userId, status: status as never, grandTotal: 10_000, currency: 'ETB', isCod: true,
        idempotencyKey: `checkout-${randomUUID()}`, beneficiarySnapshot: { fullName: 'Abebe Kebede' }, addressSnapshot: { line1: 'Bole Road 42' }, placedAt: t(minutesAgo), createdAt: t(minutesAgo),
      },
    });
    const fulfillments = [];
    for (const ref of refs) {
      fulfillments.push(await ctx.prisma.fulfillment.create({ data: { orderId: o.id, pharmacyId: randomUUID(), branchId: randomUUID(), status: 'READY', deliveryJobId: ref ? randomUUID() : null } }));
    }
    return { ...o, fulfillments };
  }

  async function seedSet() {
    const none = await order('READY', [], 90); // no fulfillment
    const all = await order('READY', [true, true], 80); // every fulfillment referenced
    const nil = await order('READY', [false, false], 70); // none referenced
    const mix = await order('READY', [true, false], 60); // partial
    const mix3 = await order('READY', [true, true, false], 50); // partial, three fulfillments
    // Module 08 has a job for mix3's unreferenced fulfillment — the reference just was not recorded.
    const unrecorded = mix3.fulfillments.find((f) => f.deliveryJobId === null)!;
    await ctx.prisma.deliveryJob.create({ data: { orderId: mix3.id, fulfillmentId: unrecorded.id, pharmacyId: unrecorded.pharmacyId, branchId: unrecorded.branchId } });
    const paidMix = await order('PAID', [true, false], 40); // partial, not READY
    const cancelledAll = await order('CANCELLED', [true], 30);
    return { none, all, nil, mix, mix3, paidMix, cancelledAll };
  }

  it('the four shapes, row by row, cross-checked against the persisted fulfillments', async () => {
    const s = await seedSet();
    const res = await list();
    const byId = new Map(res.items.map((i) => [i.orderId, i]));
    expect([s.none, s.all, s.nil, s.mix, s.mix3].map((o) => [byId.get(o.id)!.unreferencedFulfillmentCount, byId.get(o.id)!.hasDeliveryJobReference])).toEqual([
      [0, false], // no fulfillment
      [0, true], // all referenced
      [2, false], // none referenced
      [1, true], // mixed
      [1, true], // mixed, three fulfillments
    ]);
    const fulfillments = await ctx.prisma.fulfillment.findMany({ select: { orderId: true, deliveryJobId: true } });
    for (const item of res.items) {
      const mine = fulfillments.filter((f) => f.orderId === item.orderId);
      expect({ id: item.orderId, n: item.unreferencedFulfillmentCount, has: item.hasDeliveryJobReference, total: item.fulfillmentCount }).toEqual({
        id: item.orderId, n: mine.filter((f) => f.deliveryJobId === null).length, has: mine.some((f) => f.deliveryJobId !== null), total: mine.length,
      });
    }
    expect(new Set(ids(res)).size).toBe(res.items.length);
    expect(res.total).toBe(7);
  });

  it('hasUnreferencedFulfillment=true / false — and an order with no fulfillment is false', async () => {
    const s = await seedSet();
    const yes = await list({ hasUnreferencedFulfillment: 'true' });
    expect(new Set(ids(yes))).toEqual(new Set([s.nil.id, s.mix.id, s.mix3.id, s.paidMix.id]));
    expect(yes.total).toBe(4);
    expect(yes.items.every((i) => i.unreferencedFulfillmentCount > 0)).toBe(true);
    const no = await list({ hasUnreferencedFulfillment: 'false' });
    expect(new Set(ids(no))).toEqual(new Set([s.none.id, s.all.id, s.cancelledAll.id]));
    expect(no.items.every((i) => i.unreferencedFulfillmentCount === 0)).toBe(true);
  });

  it('the partial-handoff query: status=READY & hasDeliveryJobReference=true & hasUnreferencedFulfillment=true — each order once', async () => {
    const s = await seedSet();
    const partial = await list({ status: 'READY', hasDeliveryJobReference: 'true', hasUnreferencedFulfillment: 'true' });
    expect(new Set(ids(partial))).toEqual(new Set([s.mix.id, s.mix3.id]));
    expect([partial.total, partial.items.length]).toEqual([2, 2]);
    // From the persisted rows, independently.
    const ready = await ctx.prisma.order.findMany({ where: { status: 'READY' }, include: { fulfillments: { select: { deliveryJobId: true } } } });
    const expected = ready.filter((o) => o.fulfillments.some((f) => f.deliveryJobId !== null) && o.fulfillments.some((f) => f.deliveryJobId === null));
    expect(ids(partial).sort()).toEqual(expected.map((o) => o.id).sort());
  });

  it('Work 42’s summary still counts a partial order as "with"; its with/without totals match the Work 43 filter, unchanged', async () => {
    await seedSet();
    const summary = body(await request(ctx.server).get(`${BASE}/summary`).set(...auth(admin.accessToken)).expect(200)) as { orders: { byStatus: Record<string, number>; nonTerminalCount: number }; readyHandoff: Record<string, number> };
    const readyWith = await list({ status: 'READY', hasDeliveryJobReference: 'true' });
    const readyWithout = await list({ status: 'READY', hasDeliveryJobReference: 'false' });
    expect(summary.readyHandoff).toEqual({ readyOrderCount: 5, readyOrdersWithDeliveryJob: readyWith.total, readyOrdersWithoutDeliveryJob: readyWithout.total });
    expect([readyWith.total, readyWithout.total]).toEqual([3, 2]); // all, mix, mix3 | none, nil
    expect(summary.orders.byStatus.READY).toBe(5);
    expect(summary.orders.nonTerminalCount).toBe(1); // PAID only — READY stays terminal (Work 41)
  });

  it('an unreferenced fulfillment is not proof of a missing job: mix3 still has its Module 08 job, untouched and unread', async () => {
    const s = await seedSet();
    const fulfillment = s.mix3.fulfillments.find((f) => f.deliveryJobId === null)!;
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { fulfillmentId: fulfillment.id } });
    const row = (await list({ hasUnreferencedFulfillment: 'true' })).items.find((i) => i.orderId === s.mix3.id)!;
    expect(row.unreferencedFulfillmentCount).toBe(1);
    expect((await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } })).updatedAt).toEqual(job.updatedAt);
    expect((await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).deliveryJobId).toBeNull(); // not repaired by reading
  });

  it('composes with isCod, orderNumber, created window and paging; page and total agree; omitted keeps the list as it was', async () => {
    const s = await seedSet();
    expect(ids(await list({ hasUnreferencedFulfillment: 'true', orderNumber: s.mix.orderNumber }))).toEqual([s.mix.id]);
    expect(ids(await list({ hasUnreferencedFulfillment: 'true', orderNumber: s.all.orderNumber }))).toEqual([]);
    expect(ids(await list({ hasUnreferencedFulfillment: 'true', isCod: 'false' }))).toEqual([]);
    expect(ids(await list({ hasUnreferencedFulfillment: 'true', createdFrom: t(65).toISOString(), createdTo: t(45).toISOString() }))).toEqual([s.mix3.id, s.mix.id]);
    const [p1, p2] = await Promise.all([1, 2].map((page) => list({ hasUnreferencedFulfillment: 'true', size: 3, page })));
    expect([p1.total, p2.total]).toEqual([4, 4]);
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(await list({ hasUnreferencedFulfillment: 'true' })));
    expect((await list()).total).toBe(7);
  });

  it('invalid values and unknown parameters are 400; detail unchanged; RBAC unchanged; no identifiers added', async () => {
    const s = await seedSet();
    for (const bad of <Array<Record<string, string>>>[{ hasUnreferencedFulfillment: 'TRUE' }, { hasUnreferencedFulfillment: 'yes' }, { hasUnreferencedFulfillment: '1' }, { hasUnreferencedFulfillment: '' }, { unreferencedFulfillmentCount: '1' }]) {
      expect({ bad, status: (await get(bad)).status }).toEqual({ bad, status: 400 });
    }
    const detail = body(await request(ctx.server).get(`${BASE}/${s.mix3.id}`).set(...auth(admin.accessToken)).expect(200)) as Record<string, unknown>;
    expect(detail).not.toHaveProperty('unreferencedFulfillmentCount');
    expect(detail).not.toHaveProperty('hasDeliveryJobReference');
    expect((await request(ctx.server).get(BASE).query({ hasUnreferencedFulfillment: 'true' })).status).toBe(401);
    expect((await request(ctx.server).get(BASE).query({ hasUnreferencedFulfillment: 'true' }).set(...auth((await createUserWithRole(ctx, 'FINANCE_OFFICER')).accessToken))).status).toBe(403);
    const raw = JSON.stringify(await list({ hasUnreferencedFulfillment: 'true' }));
    const fulfillments = await ctx.prisma.fulfillment.findMany();
    for (const secret of [...fulfillments.flatMap((f) => [f.id, f.deliveryJobId ?? 'none', f.pharmacyId, f.branchId]), customer.userId, 'Abebe', 'Bole']) {
      expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
  });

  it('read-only: orders, fulfillments, delivery jobs, audit and outbox unchanged', async () => {
    await seedSet();
    const state = async () => ({
      orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
      fulfillments: await ctx.prisma.fulfillment.findMany({ orderBy: { id: 'asc' } }),
      jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    for (const q of <Array<Record<string, string>>>[{}, { hasUnreferencedFulfillment: 'true' }, { hasUnreferencedFulfillment: 'false' }, { status: 'READY', hasDeliveryJobReference: 'true', hasUnreferencedFulfillment: 'true' }]) await list(q);
    await request(ctx.server).get(`${BASE}/summary`).set(...auth(admin.accessToken)).expect(200);
    expect(await state()).toEqual(before);
  });
});
