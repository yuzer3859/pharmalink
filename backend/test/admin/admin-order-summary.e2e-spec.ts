import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { OrderStatusPolicy } from '../../src/modules/orders/domain/services/order-status-policy';
import { OrderStatus } from '../../src/modules/orders/application/ports/inbound/order-backlog-summary-read.port';

type User = RegisteredUser & Tokens;
type Summary = {
  generatedAt: string;
  orders: { total: number; byStatus: Record<string, number>; nonTerminalCount: number; oldestNonTerminalPlacedAt: string | null; oldestNonTerminalAgeSeconds: number | null };
};
const PATH = '/admin/operations/orders/summary';
const STATUSES = Object.values(OrderStatus) as string[];
/** Derived from Module 06's policy, never from status labels. */
const NON_TERMINAL = STATUSES.filter((s) => !OrderStatusPolicy.isTerminal(s as OrderStatus));

/**
 * Module 16 Work 41 against real PostgreSQL: the order backlog and aging summary — counts and
 * timestamps over Module 06's `orders`.
 */
describe('Admin order backlog summary (e2e)', () => {
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

  const get = (token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(PATH);
    return token ? r.set(...auth(token)) : r;
  };
  const summary = async (token = admin.accessToken) => body(await get(token).expect(200)) as unknown as Summary;
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  function order(status: string, placedAt: Date | null, createdAt = placedAt ?? new Date()) {
    return ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`, customerUserId: customer.userId, status: status as never, subtotal: 9_000, deliveryFee: 1_000, grandTotal: 10_000,
        currency: 'ETB', idempotencyKey: `checkout-${randomUUID()}`, beneficiarySnapshot: { fullName: 'Abebe Kebede', phone: '+251911555444' },
        addressSnapshot: { line1: 'Bole Road 42', city: 'Addis Ababa' }, cancelReason: status === 'CANCELLED' ? 'Customer called: wrong address' : null, isCod: true, placedAt, createdAt,
      },
    });
  }

  /** One order in every status, oldest first in declaration order; plus a second PAID; plus an ancient terminal one; plus a DRAFT with no placedAt. */
  async function seedSet() {
    const orders: Record<string, { id: string; orderNumber: string; placedAt: Date | null }> = {};
    let minutes = 1_000;
    for (const s of STATUSES.filter((x) => x !== 'DRAFT')) orders[s] = await order(s, t((minutes -= 10)));
    await order('PAID', t(5));
    await order('CANCELLED', t(50_000)); // older than everything, but terminal
    orders.DRAFT = await order('DRAFT', null, t(60_000)); // non-terminal, oldest by createdAt, but never placed
    return orders;
  }

  it('empty dataset: zeros, all 10 statuses zero-filled, oldest timestamp and age null', async () => {
    const s = await summary();
    expect(Date.parse(s.generatedAt)).not.toBeNaN();
    expect(s.orders).toEqual({ total: 0, byStatus: Object.fromEntries(STATUSES.map((k) => [k, 0])), nonTerminalCount: 0, oldestNonTerminalPlacedAt: null, oldestNonTerminalAgeSeconds: null });
  });

  it('mixed terminal and non-terminal orders: expected figures, each cross-checked against the persisted rows', async () => {
    const orders = await seedSet();
    const s = await summary();
    expect(NON_TERMINAL).toEqual(['DRAFT', 'PENDING_PAYMENT', 'PAID', 'ACCEPTED']);
    expect(s.orders.total).toBe(12);
    expect(Object.keys(s.orders.byStatus)).toEqual(STATUSES);
    expect(s.orders.byStatus).toEqual({ ...Object.fromEntries(STATUSES.map((k) => [k, 1])), PAID: 2, CANCELLED: 2 });
    expect(s.orders.nonTerminalCount).toBe(5); // DRAFT, PENDING_PAYMENT, PAID ×2, ACCEPTED — READY is terminal in Module 06 today
    // The DRAFT is older but has no placedAt; the oldest *placed* non-terminal order is PENDING_PAYMENT.
    expect(s.orders.oldestNonTerminalPlacedAt).toBe(orders.PENDING_PAYMENT.placedAt!.toISOString());

    const rows = await ctx.prisma.order.findMany({ select: { status: true, placedAt: true } });
    const open = rows.filter((r) => NON_TERMINAL.includes(r.status));
    expect(s.orders.total).toBe(rows.length);
    for (const st of STATUSES) expect({ st, n: s.orders.byStatus[st] }).toEqual({ st, n: rows.filter((r) => r.status === st).length });
    expect(s.orders.nonTerminalCount).toBe(open.length);
    const placed = open.filter((r) => r.placedAt !== null).map((r) => r.placedAt!.getTime());
    expect(s.orders.oldestNonTerminalPlacedAt).toBe(new Date(Math.min(...placed)).toISOString());
  });

  it('age: whole seconds to generatedAt; 0 for a future placedAt; null when nothing is non-terminal or nothing non-terminal was placed', async () => {
    const orders = await seedSet();
    const s = await summary();
    const expected = Math.floor((Date.parse(s.generatedAt) - orders.PENDING_PAYMENT.placedAt!.getTime()) / 1000);
    expect(Number.isInteger(s.orders.oldestNonTerminalAgeSeconds)).toBe(true);
    expect(Math.abs(s.orders.oldestNonTerminalAgeSeconds! - expected)).toBeLessThanOrEqual(1);

    // Only the unplaced DRAFT left non-terminal: a count, but no qualifying timestamp.
    await ctx.prisma.order.updateMany({ where: { status: { in: ['PENDING_PAYMENT', 'PAID', 'ACCEPTED'] } }, data: { status: 'CANCELLED' } });
    const draftOnly = await summary();
    expect([draftOnly.orders.nonTerminalCount, draftOnly.orders.oldestNonTerminalPlacedAt, draftOnly.orders.oldestNonTerminalAgeSeconds]).toEqual([1, null, null]);

    const future = await order('PAID', t(-10));
    expect((await summary()).orders.oldestNonTerminalAgeSeconds).toBe(0);
    await ctx.prisma.order.update({ where: { id: future.id }, data: { status: 'CANCELLED' } });
    await ctx.prisma.order.update({ where: { id: orders.DRAFT.id }, data: { status: 'CANCELLED' } });
    const none = await summary();
    expect([none.orders.nonTerminalCount, none.orders.oldestNonTerminalPlacedAt, none.orders.oldestNonTerminalAgeSeconds]).toEqual([0, null, null]);
  });

  it('status is the order’s own: fulfillment, payment, delivery and COD state do not move it', async () => {
    const paid = await order('PAID', t(30));
    await ctx.prisma.fulfillment.create({ data: { orderId: paid.id, pharmacyId: randomUUID(), branchId: randomUUID(), status: 'DELIVERED' } });
    await ctx.prisma.payment.create({ data: { orderId: paid.id, customerUserId: customer.userId, method: 'TELEBIRR', status: 'REFUNDED', amount: 10_000, currency: 'ETB', provider: 'telebirr', idempotencyKey: `pay-${randomUUID()}` } });
    await ctx.prisma.deliveryJob.create({ data: { orderId: paid.id, fulfillmentId: randomUUID(), pharmacyId: randomUUID(), branchId: randomUUID(), status: 'COMPLETED' } });
    const s = await summary();
    expect([s.orders.byStatus.PAID, s.orders.byStatus.DELIVERED, s.orders.byStatus.REFUNDED, s.orders.nonTerminalCount]).toEqual([1, 0, 0, 1]);
  });

  it('privacy: counts and timestamps only', async () => {
    await seedSet();
    const rows = await ctx.prisma.order.findMany();
    const raw = JSON.stringify(await summary());
    for (const secret of [...rows.flatMap((r) => [r.id, r.orderNumber, r.idempotencyKey]), customer.userId, customer.phone, 'Abebe', '+251911555444', 'Bole Road', 'wrong address', 'checkout-']) {
      expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
    expect(raw).not.toMatch(/10000|9000|Id"|Number"|Total"|address|beneficiary/);
  });

  it('read-only: orders, lines, fulfillments, payments, delivery jobs, COD, audit and outbox unchanged; other methods do not mutate', async () => {
    const orders = await seedSet();
    const paid = orders.PAID.id;
    await ctx.prisma.orderLine.create({ data: { orderId: paid, catalogProductId: randomUUID(), productSnapshot: { name: 'Item' }, quantity: 1, unitPrice: 1_000, lineTotal: 1_000 } });
    const f = await ctx.prisma.fulfillment.create({ data: { orderId: paid, pharmacyId: randomUUID(), branchId: randomUUID(), status: 'ACCEPTED' } });
    await ctx.prisma.payment.create({ data: { orderId: paid, customerUserId: customer.userId, method: 'COD', status: 'INITIATED', amount: 10_000, currency: 'ETB', provider: 'cod', idempotencyKey: `pay-${randomUUID()}` } });
    const job = await ctx.prisma.deliveryJob.create({ data: { orderId: paid, fulfillmentId: f.id, pharmacyId: f.pharmacyId, branchId: f.branchId, status: 'CREATED', isCod: true } });
    const driverUser = await createUserWithRole(ctx, 'DRIVER');
    const driver = await ctx.prisma.driverProfile.create({ data: { userId: driverUser.userId } });
    await ctx.prisma.codCollection.create({ data: { jobId: job.id, driverId: driver.id, orderId: paid, fulfillmentId: f.id, expectedAmount: 10_000, collectedAmount: 10_000, method: 'CASH' } });
    const state = async () => ({
      orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
      lines: await ctx.prisma.orderLine.findMany({ orderBy: { id: 'asc' } }),
      fulfillments: await ctx.prisma.fulfillment.findMany({ orderBy: { id: 'asc' } }),
      payments: await ctx.prisma.payment.findMany({ orderBy: { id: 'asc' } }),
      jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
      cod: await ctx.prisma.codCollection.findMany({ orderBy: { id: 'asc' } }),
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

  it('summary is not taken for an order id; Work 35 list/detail, Work 39 COD and Work 40 delivery summaries still answer', async () => {
    const orders = await seedSet();
    const authed = (path: string) => request(ctx.server).get(path).set(...auth(admin.accessToken));
    expect(Object.keys(await summary())).toEqual(['generatedAt', 'orders', 'readyHandoff']);
    expect((body(await authed('/admin/operations/orders').query({ size: 100 }).expect(200)) as unknown as { total: number }).total).toBe(12);
    const detail = body(await authed(`/admin/operations/orders/${orders.PAID.id}`).expect(200)) as { orderId: string; status: string };
    expect([detail.orderId, detail.status]).toEqual([orders.PAID.id, 'PAID']);
    await authed('/admin/operations/orders/not-a-uuid').expect(400);
    await authed('/admin/operations/cod/summary').expect(200);
    await authed('/admin/operations/deliveries/summary').expect(200);
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; customer, pharmacy, driver, support, finance and analytics-only roles 403', async () => {
    await seedSet();
    expect((await get((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken)).status).toBe(200);
    expect((await get(null)).status).toBe(401);
    const tokens: Array<[string, string]> = [['CUSTOMER', customer.accessToken]];
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'DRIVER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    const analytics = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'analytics:read' } });
    const r = await ctx.prisma.role.upsert({ where: { key: 'ANALYTICS_VIEWER_TEST' }, update: {}, create: { key: 'ANALYTICS_VIEWER_TEST', name: 'Analytics viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: analytics.id } }, update: {}, create: { roleId: r.id, permissionId: analytics.id } });
    tokens.push(['ANALYTICS_VIEWER_TEST', (await createUserWithRole(ctx, 'ANALYTICS_VIEWER_TEST')).accessToken]);
    for (const [role, token] of tokens) expect({ role, status: (await get(token)).status }).toEqual({ role, status: 403 });
  });
});
