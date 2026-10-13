import { randomUUID } from 'crypto';
import request from 'supertest';
import { OrderStatusPolicy } from '../../src/modules/orders/domain/services/order-status-policy';
import { OrderStatus } from '../../src/modules/orders/application/ports/inbound/order-backlog-summary-read.port';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder } from '../orders/support';

type User = RegisteredUser & Tokens;
type Summary = {
  generatedAt: string;
  orders: { total: number; byStatus: Record<string, number>; nonTerminalCount: number; oldestNonTerminalPlacedAt: string | null; oldestNonTerminalAgeSeconds: number | null };
  readyHandoff: { readyOrderCount: number; readyOrdersWithDeliveryJob: number; readyOrdersWithoutDeliveryJob: number };
};
const PATH = '/admin/operations/orders/summary';
const NON_TERMINAL = (Object.values(OrderStatus) as string[]).filter((s) => !OrderStatusPolicy.isTerminal(s as OrderStatus));

/**
 * Module 16 Work 42 against real PostgreSQL: the READY-order delivery handoff split on
 * `GET /admin/operations/orders/summary`, from Module 06's `fulfillments.deliveryJobId`.
 */
describe('Admin order delivery handoff (e2e)', () => {
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

  const summary = async () => body(await request(ctx.server).get(PATH).set(...auth(admin.accessToken)).expect(200)) as unknown as Summary;
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  /** An order in `status` with one fulfillment per entry of `refs` (`true` = a delivery-job reference). */
  async function order(status: string, refs: boolean[], minutesAgo = 10) {
    const o = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`, customerUserId: customer.userId, status: status as never, grandTotal: 10_000, currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`, beneficiarySnapshot: { fullName: 'Abebe Kebede' }, addressSnapshot: { line1: 'Bole Road 42' }, placedAt: t(minutesAgo),
      },
    });
    for (const ref of refs) {
      await ctx.prisma.fulfillment.create({ data: { orderId: o.id, pharmacyId: randomUUID(), branchId: randomUUID(), status: status === 'READY' ? 'READY' : 'ACCEPTED', deliveryJobId: ref ? randomUUID() : null } });
    }
    return o;
  }

  async function seedSet() {
    await order('READY', [true]); // one fulfillment, referenced
    await order('READY', [true, true]); // two fulfillments, both referenced — one order
    await order('READY', [true, false]); // partially referenced — at least one, so "with"
    await order('READY', [false]); // none referenced
    await order('READY', []); // no fulfillment at all
    await order('PAID', [true], 30); // referenced, but not READY
    await order('CANCELLED', [true]); // referenced, but not READY
    await order('ACCEPTED', [false], 40);
  }

  it('no READY orders: three zeros', async () => {
    await order('PAID', [true]);
    expect((await summary()).readyHandoff).toEqual({ readyOrderCount: 0, readyOrdersWithDeliveryJob: 0, readyOrdersWithoutDeliveryJob: 0 });
  });

  it('mixed fulfillments: counted per distinct READY order, other statuses excluded, the invariant holds — cross-checked against the rows', async () => {
    await seedSet();
    const s = await summary();
    expect(s.readyHandoff).toEqual({ readyOrderCount: 5, readyOrdersWithDeliveryJob: 3, readyOrdersWithoutDeliveryJob: 2 });
    expect(s.readyHandoff.readyOrdersWithDeliveryJob + s.readyHandoff.readyOrdersWithoutDeliveryJob).toBe(s.readyHandoff.readyOrderCount);
    expect(s.readyHandoff.readyOrderCount).toBe(s.orders.byStatus.READY);

    const ready = await ctx.prisma.order.findMany({ where: { status: 'READY' }, include: { fulfillments: { select: { deliveryJobId: true } } } });
    const withJob = ready.filter((o) => o.fulfillments.some((f) => f.deliveryJobId !== null));
    expect(s.readyHandoff.readyOrderCount).toBe(ready.length);
    expect(s.readyHandoff.readyOrdersWithDeliveryJob).toBe(withJob.length);
    expect(s.readyHandoff.readyOrdersWithoutDeliveryJob).toBe(ready.length - withJob.length);
    // Fulfillment rows are not orders: 6 fulfillments under 5 READY orders, 4 of them referenced.
    expect(await ctx.prisma.fulfillment.count({ where: { order: { status: 'READY' } } })).toBe(6);
  });

  it('Work 41’s metrics keep their meaning: READY stays terminal and visible only in byStatus', async () => {
    await seedSet();
    const s = await summary();
    const rows = await ctx.prisma.order.findMany({ select: { status: true, placedAt: true } });
    const open = rows.filter((r) => NON_TERMINAL.includes(r.status));
    expect(NON_TERMINAL).not.toContain('READY');
    expect(s.orders.total).toBe(rows.length);
    expect(s.orders.byStatus.READY).toBe(5);
    expect(s.orders.nonTerminalCount).toBe(open.length); // PAID and ACCEPTED only
    expect(s.orders.oldestNonTerminalPlacedAt).toBe(new Date(Math.min(...open.map((r) => r.placedAt!.getTime()))).toISOString());
  });

  it('the real workflow: a READY order whose Module 08 job was cut counts as "with", and Work 35 shows the same reference', async () => {
    const placed = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${placed.fulfillmentId}/${action}`).set(...auth(placed.pharmacy.accessToken)).expect(200);
    }
    expect((await summary()).readyHandoff).toEqual({ readyOrderCount: 1, readyOrdersWithDeliveryJob: 0, readyOrdersWithoutDeliveryJob: 1 });
    await ctx.drainOutbox(); // order.ready -> job cut -> delivery.job.created -> reference recorded (Work 42A)
    expect((await summary()).readyHandoff).toEqual({ readyOrderCount: 1, readyOrdersWithDeliveryJob: 1, readyOrdersWithoutDeliveryJob: 0 });
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { fulfillmentId: placed.fulfillmentId } });
    const detail = body(await request(ctx.server).get(`/admin/operations/orders/${placed.orderId}`).set(...auth(admin.accessToken)).expect(200)) as { status: string; fulfillments: Array<{ deliveryJobId: string | null }> };
    expect([detail.status, detail.fulfillments.map((f) => f.deliveryJobId)]).toEqual(['READY', [job.id]]);
  });

  it('privacy: counts only — no order, fulfillment or delivery-job identifier', async () => {
    await seedSet();
    const raw = JSON.stringify(await summary());
    const fulfillments = await ctx.prisma.fulfillment.findMany();
    const orders = await ctx.prisma.order.findMany();
    for (const secret of [...orders.flatMap((o) => [o.id, o.orderNumber]), ...fulfillments.flatMap((f) => [f.id, f.deliveryJobId ?? 'none', f.pharmacyId]), customer.userId, 'Abebe', 'Bole']) {
      expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
    expect(raw).not.toMatch(/Id"|deliveryStatus|EN_ROUTE|ASSIGNED/);
  });

  it('read-only: orders, fulfillments, audit and outbox unchanged; other methods do not mutate; Work 35 and Work 41 still answer', async () => {
    await seedSet();
    const state = async () => ({
      orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
      fulfillments: await ctx.prisma.fulfillment.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await summary();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const status = (await request(ctx.server)[method](PATH).set(...auth(admin.accessToken)).send({ deliveryJobId: randomUUID() })).status;
      expect({ method, status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
    const anyReady = await ctx.prisma.order.findFirstOrThrow({ where: { status: 'READY' } });
    await request(ctx.server).get(`/admin/operations/orders/${anyReady.id}`).set(...auth(admin.accessToken)).expect(200);
    expect(Object.keys(await summary())).toEqual(['generatedAt', 'orders', 'readyHandoff']);
  });

  it('RBAC unchanged: order:read:any — ADMIN and SUPER_ADMIN 200, anonymous 401, others 403', async () => {
    expect((await request(ctx.server).get(PATH).set(...auth((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken))).status).toBe(200);
    expect((await request(ctx.server).get(PATH)).status).toBe(401);
    for (const role of ['CUSTOMER', 'DRIVER', 'FINANCE_OFFICER', 'CUSTOMER_SUPPORT']) {
      const token = (await createUserWithRole(ctx, role)).accessToken;
      expect({ role, status: (await request(ctx.server).get(PATH).set(...auth(token))).status }).toEqual({ role, status: 403 });
    }
  });
});
