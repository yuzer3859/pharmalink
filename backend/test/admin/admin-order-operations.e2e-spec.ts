import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Summary = { orderId: string; orderNumber: string; status: string; isCod: boolean; grandTotal: number; currency: string; lineCount: number; fulfillmentCount: number; placedAt: string | null; createdAt: string; updatedAt: string };
type Page = { items: Summary[]; total: number; page: number; size: number };
const BASE = '/admin/operations/orders';

/**
 * Module 16 Work 35 against real PostgreSQL: read-only order operations — orders, their fulfillments
 * (Module 06) and, for one order, its payment's status (Module 07's finance oversight port).
 */
describe('Admin order operations (e2e)', () => {
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

  const get = (path: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(path);
    return token ? r.set(...auth(token)) : r;
  };
  const list = async (query: Record<string, string | number> = {}) => body(await get(BASE).query(query).expect(200)) as unknown as Page;

  /** An order with `lines` lines, one fulfillment per entry of `fulfillments`, created at `createdAt`. */
  async function seedOrder(o: { status: string; isCod?: boolean; createdAt: Date; lines?: number; fulfillments?: string[]; total?: number }) {
    const order = await ctx.prisma.order.create({
      data: {
        orderNumber: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerUserId: customer.userId,
        status: o.status as never,
        isCod: o.isCod ?? false,
        subtotal: (o.total ?? 10_000) - 1_000,
        deliveryFee: 1_000,
        grandTotal: o.total ?? 10_000,
        currency: 'ETB',
        idempotencyKey: `checkout-${randomUUID()}`,
        beneficiarySnapshot: { fullName: 'Abebe Kebede', phone: '+251911555444' },
        addressSnapshot: { line1: 'Bole Road 42', city: 'Addis Ababa' },
        cancelReason: o.status === 'CANCELLED' ? 'Customer called: wrong address' : null,
        deliverySlot: 'EVENING',
        placedAt: o.status === 'DRAFT' ? null : o.createdAt,
        createdAt: o.createdAt,
      },
    });
    const fulfillmentIds: string[] = [];
    for (const status of o.fulfillments ?? []) {
      fulfillmentIds.push((await ctx.prisma.fulfillment.create({ data: { orderId: order.id, pharmacyId: `ph-${randomUUID().slice(0, 6)}`, branchId: `br-${randomUUID().slice(0, 6)}`, status: status as never } })).id);
    }
    for (let i = 0; i < (o.lines ?? 1); i++) {
      await ctx.prisma.orderLine.create({
        data: { orderId: order.id, fulfillmentId: fulfillmentIds[0] ?? null, catalogProductId: randomUUID(), productSnapshot: { name: `Item ${i}` }, quantity: 1, unitPrice: 1_000, lineTotal: 1_000 },
      });
    }
    return order;
  }
  async function linkPayment(orderId: string, status: string) {
    const payment = await ctx.prisma.payment.create({
      data: {
        orderId,
        customerUserId: customer.userId,
        method: 'TELEBIRR',
        status: status as never,
        amount: 10_000,
        currency: 'ETB',
        provider: 'telebirr',
        providerRef: 'TB-REF-SECRET-123',
        providerToken: 'tok_live_SECRET',
        failureReason: 'gateway raw text',
        idempotencyKey: `pay-${randomUUID()}`,
      },
    });
    await ctx.prisma.order.update({ where: { id: orderId }, data: { paymentId: payment.id } });
    return payment;
  }

  async function seedSet() {
    const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const paid = await seedOrder({ status: 'PAID', createdAt: t(50), lines: 3, fulfillments: ['ACCEPTED', 'PENDING'] });
    const cod = await seedOrder({ status: 'DISPATCHED', isCod: true, createdAt: t(40), lines: 1, fulfillments: ['DISPATCHED'] });
    const cancelled = await seedOrder({ status: 'CANCELLED', createdAt: t(30), lines: 2 });
    const draft = await seedOrder({ status: 'DRAFT', createdAt: t(20), lines: 0 });
    const done = await seedOrder({ status: 'COMPLETED', createdAt: t(10), lines: 1, fulfillments: ['DELIVERED'] });
    return { paid, cod, cancelled, draft, done };
  }

  it('an empty list', async () => {
    expect(await list()).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('lists newest first with exact fields; counts and money from Module 06’s rows', async () => {
    const s = await seedSet();
    const res = await list();
    expect(res.total).toBe(5);
    expect(res.items.map((i) => i.orderId)).toEqual([s.done.id, s.draft.id, s.cancelled.id, s.cod.id, s.paid.id]);
    const paid = res.items.find((i) => i.orderId === s.paid.id)!;
    expect(paid).toEqual({
      orderId: s.paid.id,
      orderNumber: s.paid.orderNumber,
      status: 'PAID',
      isCod: false,
      grandTotal: 10_000,
      currency: 'ETB',
      lineCount: 3,
      fulfillmentCount: 2,
      placedAt: s.paid.placedAt!.toISOString(),
      createdAt: s.paid.createdAt.toISOString(),
      updatedAt: (await ctx.prisma.order.findUniqueOrThrow({ where: { id: s.paid.id } })).updatedAt.toISOString(),
      // Work 43: neither of its fulfillments records a delivery-job reference.
      hasDeliveryJobReference: false,
      // Work 44: so both are unreferenced.
      unreferencedFulfillmentCount: 2,
    });
    expect(res.items.find((i) => i.orderId === s.draft.id)).toMatchObject({ lineCount: 0, fulfillmentCount: 0, placedAt: null });
  });

  it('filters by status, isCod (including false), order number and created window; pages stably', async () => {
    const s = await seedSet();
    expect((await list({ status: 'CANCELLED' })).items.map((i) => i.orderId)).toEqual([s.cancelled.id]);
    expect((await list({ isCod: 'true' })).items.map((i) => i.orderId)).toEqual([s.cod.id]);
    expect((await list({ isCod: 'false' })).total).toBe(4);
    expect((await list({ orderNumber: s.paid.orderNumber })).items.map((i) => i.orderId)).toEqual([s.paid.id]);
    expect((await list({ createdFrom: new Date(Date.now() - 35 * 60_000).toISOString() })).items.map((i) => i.orderId)).toEqual([s.done.id, s.draft.id, s.cancelled.id]);
    const p1 = await list({ size: 2, page: 1 });
    const p2 = await list({ size: 2, page: 2 });
    const p3 = await list({ size: 2, page: 3 });
    expect([p1.total, p2.total, p3.total]).toEqual([5, 5, 5]);
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.orderId)).toEqual((await list()).items.map((i) => i.orderId));
    for (const bad of [{ status: 'SHIPPED' }, { isCod: 'maybe' }, { page: 0 }, { size: 101 }, { orderNumber: 'ORD 1;' }, { createdFrom: 'yesterday' }, { customerUserId: customer.userId }]) {
      expect({ bad, status: (await get(BASE).query(bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: one order, its fulfillments, and its payment’s status — reduced to four fields', async () => {
    const s = await seedSet();
    const payment = await linkPayment(s.paid.id, 'CAPTURED');
    const d = body(await get(`${BASE}/${s.paid.id}`).expect(200)) as Record<string, unknown>;
    expect(d).toMatchObject({ orderId: s.paid.id, status: 'PAID', subtotal: 9_000, deliveryFee: 1_000, platformFee: 0, discountTotal: 0, grandTotal: 10_000, lineCount: 3, fulfillmentCount: 2, completedAt: null, cancelledAt: null });
    expect(d.payment).toEqual({ paymentId: payment.id, status: 'CAPTURED', method: 'TELEBIRR', updatedAt: payment.updatedAt.toISOString() });
    const f = await ctx.prisma.fulfillment.findMany({ where: { orderId: s.paid.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(d.fulfillments).toEqual(f.map((x) => ({ fulfillmentId: x.id, pharmacyId: x.pharmacyId, branchId: x.branchId, status: x.status, deliveryJobId: x.deliveryJobId, acceptedAt: null, readyAt: null, createdAt: x.createdAt.toISOString() })));
    // An order without a linked payment: null, nothing invented.
    expect((body(await get(`${BASE}/${s.cod.id}`).expect(200)) as Record<string, unknown>).payment).toBeNull();
  });

  it('unknown order → 404; malformed id → 400', async () => {
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/not-a-uuid`).expect(400);
  });

  it('privacy: no customer, beneficiary, address, cancellation note, delivery slot, idempotency key or payment-provider detail', async () => {
    const s = await seedSet();
    await linkPayment(s.paid.id, 'FAILED');
    const raw = JSON.stringify([(await get(BASE).query({ size: 100 })).body, ...(await Promise.all(Object.values(s).map((o) => get(`${BASE}/${o.id}`)))).map((r) => r.body)]);
    for (const secret of [customer.userId, customer.phone, 'Abebe', '+251911555444', 'Bole Road', 'wrong address', 'EVENING', 'checkout-', 'TB-REF-SECRET', 'tok_live', 'gateway raw text']) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/customerUserId|beneficiary|address|cancelReason|idempotencyKey|providerRef|providerToken|failureReason/);
  });

  it('read-only: orders, lines, fulfillments, payments, delivery jobs, COD, audit and outbox are unchanged by reads; other methods are 404', async () => {
    const s = await seedSet();
    await linkPayment(s.paid.id, 'CAPTURED');
    const state = async () => ({
      orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
      lines: await ctx.prisma.orderLine.count(),
      fulfillments: await ctx.prisma.fulfillment.findMany({ orderBy: { id: 'asc' } }),
      payments: await ctx.prisma.payment.findMany({ orderBy: { id: 'asc' } }),
      jobs: await ctx.prisma.deliveryJob.count(),
      cod: await ctx.prisma.codCollection.count(),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await list();
    for (const o of Object.values(s)) await get(`${BASE}/${o.id}`).expect(200);
    for (const [method, path] of [['post', BASE], ['put', `${BASE}/${s.paid.id}`], ['patch', `${BASE}/${s.paid.id}`], ['delete', `${BASE}/${s.paid.id}`], ['post', `${BASE}/${s.paid.id}/cancel`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({})).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('RBAC: 401 anonymous; 403 for customers, pharmacy and other admin-side roles, and for analytics:read alone; SUPER_ADMIN allowed', async () => {
    const s = await seedSet();
    for (const path of [BASE, `${BASE}/${s.paid.id}`]) expect({ path, status: (await get(path, null)).status }).toEqual({ path, status: 401 });
    const tokens: Array<[string, string]> = [['CUSTOMER', customer.accessToken]];
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'DRIVER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    const analytics = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'analytics:read' } });
    const r = await ctx.prisma.role.upsert({ where: { key: 'ANALYTICS_VIEWER_TEST' }, update: {}, create: { key: 'ANALYTICS_VIEWER_TEST', name: 'Analytics viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: analytics.id } }, update: {}, create: { roleId: r.id, permissionId: analytics.id } });
    tokens.push(['ANALYTICS_VIEWER_TEST', (await createUserWithRole(ctx, 'ANALYTICS_VIEWER_TEST')).accessToken]);
    for (const [role, token] of tokens) {
      for (const path of [BASE, `${BASE}/${s.paid.id}`]) expect({ role, path, status: (await get(path, token)).status }).toEqual({ role, path, status: 403 });
    }
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    await get(BASE, superAdmin.accessToken).expect(200);
    await get(`${BASE}/${s.paid.id}`, superAdmin.accessToken).expect(200);
    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'order:read:any' } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
  });

  it('existing Module 16 finance and analytics endpoints still answer', async () => {
    await seedSet();
    await get('/admin/finance/payments').expect(200);
    await get('/admin/analytics/overview').expect(200);
  });
});
