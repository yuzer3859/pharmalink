import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Row = { orderId: string; orderNumber: string; status: string; hasDeliveryJobReference: boolean } & Record<string, unknown>;
type Page = { items: Row[]; total: number; page: number; size: number };
const BASE = '/admin/operations/orders';

/**
 * Module 16 Work 43 against real PostgreSQL: `GET /admin/operations/orders?hasDeliveryJobReference=`
 * and the per-row `hasDeliveryJobReference` flag, from Module 06's `fulfillments.deliveryJobId`.
 */
describe('Admin order handoff exception filtering (e2e)', () => {
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

  async function order(status: string, refs: boolean[], minutesAgo: number, isCod = true) {
    const o = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`, customerUserId: customer.userId, status: status as never, grandTotal: 10_000, currency: 'ETB', isCod,
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
    const linked = await order('READY', [true], 80);
    const mixed = await order('READY', [true, false], 70); // one referenced, one not → true
    const both = await order('READY', [true, true], 60); // two references → still one order
    const unlinked = await order('READY', [false], 50);
    const empty = await order('READY', [], 40); // no fulfillment at all → false
    // Module 08 *has* a job for this fulfillment, but the reference was never recorded (a missed event,
    // before the repair runs): the filter reports the missing reference, not the job's absence.
    const unrecorded = await order('READY', [false], 30, false);
    await ctx.prisma.deliveryJob.create({ data: { orderId: unrecorded.id, fulfillmentId: unrecorded.fulfillments[0].id, pharmacyId: randomUUID(), branchId: randomUUID() } });
    const paidLinked = await order('PAID', [true], 20);
    const cancelled = await order('CANCELLED', [false], 10);
    return { linked, mixed, both, unlinked, empty, unrecorded, paidLinked, cancelled };
  }

  it('no filter: every order once, as before, each row flagged exactly as its persisted fulfillments say', async () => {
    const s = await seedSet();
    const res = await list();
    expect(res.total).toBe(8);
    expect(new Set(ids(res)).size).toBe(8);
    const fulfillments = await ctx.prisma.fulfillment.findMany({ select: { orderId: true, deliveryJobId: true } });
    for (const item of res.items) {
      expect({ id: item.orderId, flag: item.hasDeliveryJobReference }).toEqual({ id: item.orderId, flag: fulfillments.some((f) => f.orderId === item.orderId && f.deliveryJobId !== null) });
    }
    expect(res.items.find((i) => i.orderId === s.mixed.id)!.hasDeliveryJobReference).toBe(true);
    expect(res.items.find((i) => i.orderId === s.empty.id)!.hasDeliveryJobReference).toBe(false);
  });

  it('true: orders with at least one referenced fulfillment, each once; false: the rest, including the order with no fulfillment', async () => {
    const s = await seedSet();
    const yes = await list({ hasDeliveryJobReference: 'true' });
    expect(new Set(ids(yes))).toEqual(new Set([s.linked.id, s.mixed.id, s.both.id, s.paidLinked.id]));
    expect([yes.total, yes.items.length]).toEqual([4, 4]);
    expect(yes.items.every((i) => i.hasDeliveryJobReference)).toBe(true);
    const no = await list({ hasDeliveryJobReference: 'false' });
    expect(new Set(ids(no))).toEqual(new Set([s.unlinked.id, s.empty.id, s.unrecorded.id, s.cancelled.id]));
    expect([no.total, no.items.length]).toEqual([4, 4]);
    expect(no.items.every((i) => !i.hasDeliveryJobReference)).toBe(true);
  });

  it('the exception query status=READY&hasDeliveryJobReference=false agrees with Work 42’s summary and with the rows', async () => {
    const s = await seedSet();
    const exceptions = await list({ status: 'READY', hasDeliveryJobReference: 'false' });
    expect(new Set(ids(exceptions))).toEqual(new Set([s.unlinked.id, s.empty.id, s.unrecorded.id]));
    const readyWith = await list({ status: 'READY', hasDeliveryJobReference: 'true' });
    const summary = body(await request(ctx.server).get(`${BASE}/summary`).set(...auth(admin.accessToken)).expect(200)) as { readyHandoff: Record<string, number> };
    expect(summary.readyHandoff).toEqual({ readyOrderCount: 6, readyOrdersWithDeliveryJob: readyWith.total, readyOrdersWithoutDeliveryJob: exceptions.total });
    // From the persisted rows, independently.
    const ready = await ctx.prisma.order.findMany({ where: { status: 'READY' }, include: { fulfillments: { select: { deliveryJobId: true } } } });
    expect(ready.filter((o) => !o.fulfillments.some((f) => f.deliveryJobId !== null)).map((o) => o.id).sort()).toEqual(ids(exceptions).sort());
  });

  it('a missing reference is not proof that no job exists: the unrecorded order is an exception although Module 08 has its job', async () => {
    const s = await seedSet();
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { fulfillmentId: s.unrecorded.fulfillments[0].id } });
    const row = (await list({ status: 'READY', hasDeliveryJobReference: 'false' })).items.find((i) => i.orderId === s.unrecorded.id)!;
    expect(row.hasDeliveryJobReference).toBe(false);
    // Module 08's own record of that job is intact and readable; the list did not consult it.
    const delivery = body(await request(ctx.server).get(`/admin/operations/deliveries/${job.id}`).set(...auth(admin.accessToken)).expect(200)) as { fulfillmentId: string };
    expect(delivery.fulfillmentId).toBe(s.unrecorded.fulfillments[0].id);
  });

  it('composes with isCod, orderNumber, created window and pagination; page and total agree', async () => {
    const s = await seedSet();
    expect(ids(await list({ hasDeliveryJobReference: 'false', isCod: 'false' }))).toEqual([s.unrecorded.id]);
    expect(ids(await list({ hasDeliveryJobReference: 'true', orderNumber: s.mixed.orderNumber }))).toEqual([s.mixed.id]);
    expect(ids(await list({ hasDeliveryJobReference: 'true', orderNumber: s.unlinked.orderNumber }))).toEqual([]);
    expect(ids(await list({ hasDeliveryJobReference: 'false', createdFrom: t(45).toISOString(), createdTo: t(25).toISOString() }))).toEqual([s.unrecorded.id, s.empty.id]);
    const pages = [1, 2, 3].map((page) => list({ hasDeliveryJobReference: 'true', size: 2, page }));
    const [p1, p2, p3] = await Promise.all(pages);
    expect([p1.total, p2.total, p3.total]).toEqual([4, 4, 4]);
    expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(ids(await list({ hasDeliveryJobReference: 'true' })));
    expect(ids(p3)).toEqual([]);
  });

  it('invalid values and unknown parameters are 400; detail is unchanged; RBAC unchanged', async () => {
    const s = await seedSet();
    for (const bad of <Array<Record<string, string>>>[{ hasDeliveryJobReference: 'yes' }, { hasDeliveryJobReference: '1' }, { hasDeliveryJobReference: 'TRUE' }, { hasDeliveryJobReference: '' }, { hasDeliveryJob: 'true' }, { deliveryJobId: randomUUID() }]) {
      expect({ bad, status: (await get(bad)).status }).toEqual({ bad, status: 400 });
    }
    const detail = body(await request(ctx.server).get(`${BASE}/${s.mixed.id}`).set(...auth(admin.accessToken)).expect(200)) as Record<string, unknown>;
    expect(detail).not.toHaveProperty('hasDeliveryJobReference');
    expect((detail.fulfillments as unknown[]).length).toBe(2);
    expect((await request(ctx.server).get(BASE).query({ hasDeliveryJobReference: 'false' })).status).toBe(401);
    const driver = await createUserWithRole(ctx, 'DRIVER');
    expect((await request(ctx.server).get(BASE).query({ hasDeliveryJobReference: 'false' }).set(...auth(driver.accessToken))).status).toBe(403);
  });

  it('privacy: the list adds one boolean — no fulfillment or delivery-job identifier', async () => {
    await seedSet();
    const raw = JSON.stringify(await list({ hasDeliveryJobReference: 'true' }));
    const fulfillments = await ctx.prisma.fulfillment.findMany();
    const jobs = await ctx.prisma.deliveryJob.findMany();
    for (const secret of [...fulfillments.flatMap((f) => [f.id, f.deliveryJobId ?? 'none']), ...jobs.map((j) => j.id), customer.userId, 'Abebe', 'Bole']) {
      expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
  });

  it('read-only: orders, fulfillments, delivery jobs, audit and outbox unchanged — no reference is repaired by reading', async () => {
    await seedSet();
    const state = async () => ({
      orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
      fulfillments: await ctx.prisma.fulfillment.findMany({ orderBy: { id: 'asc' } }),
      jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    for (const q of <Array<Record<string, string>>>[{}, { hasDeliveryJobReference: 'true' }, { hasDeliveryJobReference: 'false' }, { status: 'READY', hasDeliveryJobReference: 'false' }]) await list(q);
    expect(await state()).toEqual(before);
  });
});
