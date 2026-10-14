import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder } from '../orders/support';

type User = RegisteredUser & Tokens;
type Item = {
  movementId: string; listingId: string; pharmacyId: string; branchId: string; catalogProductId: string; batchId: string | null;
  type: string; quantityDelta: number; refType: string | null; createdAt: string;
};
type Page = { items: Item[]; total: number; page: number; size: number };
const BASE = '/admin/operations/inventory/movements';
const KEYS = ['movementId', 'listingId', 'pharmacyId', 'branchId', 'catalogProductId', 'batchId', 'type', 'quantityDelta', 'refType', 'createdAt'];

/**
 * Module 16 Work 50 against real PostgreSQL: read-only stock-movement history. Every movement is
 * written by Module 04's production paths — listing creation, add/adjust batch, checkout's reserve,
 * the pharmacy's dispatch and a customer cancellation's release.
 */
describe('Admin stock movement history (e2e)', () => {
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

  const get = (path: string, query: Record<string, string | number> = {}, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(path).query(query);
    return token ? r.set(...auth(token)) : r;
  };
  const list = async (query: Record<string, string | number> = {}) => body(await get(BASE, { size: 100, ...query }).expect(200)) as unknown as Page;

  /**
   * Two real orders. A: checkout (RESERVE), then a second batch (RECEIPT with supplier), an adjustment
   * (ADJUST, with a free-text reason), and accept→prepare→ready (DISPATCH). B: checkout, then the
   * customer cancels (RELEASE). Both listings were created with an initial batch (RECEIPT).
   */
  async function seedSet() {
    const a = await placeOrder(ctx);
    const listingA = await ctx.prisma.inventoryListing.findFirstOrThrow({ where: { catalogProductId: a.catalogProductId, branchId: a.pharmacy.branchId } });
    const pharmacyToken = a.pharmacy.accessToken;
    const added = body(
      await request(ctx.server)
        .post(`/inventory/listings/${listingA.id}/batches`)
        .set(...auth(pharmacyToken))
        .send({ batchNumber: 'B-SECRET-2', quantity: 12, expiryDate: new Date(Date.now() + 200 * 86_400_000).toISOString(), supplier: 'SUPPLIER-SECRET Ltd' })
        .expect(201),
    );
    const batchId = added.batchId as string;
    await request(ctx.server).patch(`/inventory/batches/${batchId}`).set(...auth(pharmacyToken)).send({ quantityDelta: -2, reason: 'Damaged — reported by Abebe +251911777888' }).expect(200);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${a.fulfillmentId}/${action}`).set(...auth(pharmacyToken)).expect(200);
    }
    const b = await placeOrder(ctx);
    const listingB = await ctx.prisma.inventoryListing.findFirstOrThrow({ where: { catalogProductId: b.catalogProductId, branchId: b.pharmacy.branchId } });
    await request(ctx.server).post(`/orders/${b.orderId}/cancel`).set(...auth(b.customer.accessToken)).send({ reason: 'Wrong address on Bole Road' }).expect(200);
    return { a, b, listingA, listingB, batchId };
  }

  it('an empty list', async () => {
    expect(body(await get(BASE).expect(200))).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('every persisted movement, once, newest first, field for field — types and signs as the writers recorded them', async () => {
    const s = await seedSet();
    const res = await list();
    const rows = await ctx.prisma.stockMovement.findMany({ include: { listing: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    expect(res.total).toBe(rows.length);
    expect(res.items.map((i) => i.movementId)).toEqual(rows.map((r) => r.id));
    for (const item of res.items) {
      const r = rows.find((x) => x.id === item.movementId)!;
      expect(Object.keys(item)).toEqual(KEYS);
      expect(item).toEqual({
        movementId: r.id, listingId: r.listingId, pharmacyId: r.listing.pharmacyId, branchId: r.listing.branchId, catalogProductId: r.listing.catalogProductId,
        batchId: r.batchId, type: r.type, quantityDelta: r.quantityDelta, refType: r.refType, createdAt: r.createdAt.toISOString(),
      });
    }
    const types = (listingId: string) => res.items.filter((i) => i.listingId === listingId).map((i) => i.type).sort();
    expect(types(s.listingA.id)).toEqual(expect.arrayContaining(['ADJUST', 'DISPATCH', 'RECEIPT', 'RECEIPT', 'RESERVE']));
    expect(types(s.listingB.id)).toEqual(['RECEIPT', 'RELEASE', 'RESERVE']);

    // Signs and magnitudes against the writers' own records, not this view's SQL.
    const reservationA = await ctx.prisma.stockReservation.findFirstOrThrow({ where: { listingId: s.listingA.id } });
    const reservationB = await ctx.prisma.stockReservation.findFirstOrThrow({ where: { listingId: s.listingB.id } });
    const of = (listingId: string, type: string) => res.items.filter((i) => i.listingId === listingId && i.type === type);
    expect(of(s.listingA.id, 'RESERVE').map((i) => i.quantityDelta)).toEqual([-reservationA.quantity]);
    expect(of(s.listingA.id, 'DISPATCH').reduce((acc, i) => acc + i.quantityDelta, 0)).toBe(-reservationA.quantity);
    expect(of(s.listingB.id, 'RELEASE').map((i) => [i.quantityDelta, i.refType])).toEqual([[reservationB.quantity, 'ORDER']]);
    expect(of(s.listingA.id, 'ADJUST').map((i) => [i.quantityDelta, i.batchId])).toEqual([[-2, s.batchId]]);
    expect(of(s.listingA.id, 'RECEIPT').find((i) => i.batchId === s.batchId)!.quantityDelta).toBe(12);
    expect(reservationB.status).toBe('RELEASED');
  });

  it('no balance is invented: the deltas are reported as written, and the listing’s current figures are not attached to past movements', async () => {
    const s = await seedSet();
    const res = await list({ listingId: s.listingA.id });
    for (const i of res.items) for (const k of ['balance', 'balanceAfter', 'onHand', 'sellable', 'reserved', 'before', 'after']) expect(i).not.toHaveProperty(k);
    const listing = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: s.listingA.id } });
    expect(JSON.stringify(res)).not.toContain(`"onHand":${listing.onHand}`);
  });

  it('filters by listing, pharmacy, branch, batch, type and created window; pages stably; rejects bad input', async () => {
    const s = await seedSet();
    const all = await list();
    expect((await list({ listingId: s.listingB.id })).items.every((i) => i.listingId === s.listingB.id)).toBe(true);
    const byPharmacy = await list({ pharmacyId: s.listingA.pharmacyId });
    expect(byPharmacy.total).toBe(all.items.filter((i) => i.pharmacyId === s.listingA.pharmacyId).length);
    expect((await list({ branchId: s.listingB.branchId })).total).toBe(all.items.filter((i) => i.branchId === s.listingB.branchId).length);
    // The added batch expires first, so dispatch draws from it too (earliest-expiry allocation) — compare with the rows.
    const onBatch = await ctx.prisma.stockMovement.findMany({ where: { batchId: s.batchId } });
    expect((await list({ batchId: s.batchId })).items.map((i) => i.movementId).sort()).toEqual(onBatch.map((m) => m.id).sort());
    expect(onBatch.map((m) => m.type)).toEqual(expect.arrayContaining(['RECEIPT', 'ADJUST']));
    expect((await list({ type: 'RELEASE' })).items.map((i) => i.listingId)).toEqual([s.listingB.id]);
    expect((await list({ type: 'EXPIRE' })).total).toBe(0); // no writer records EXPIRE yet
    const oldest = all.items[all.items.length - 1].createdAt;
    expect((await list({ createdTo: oldest })).total).toBe(0);
    expect((await list({ createdFrom: oldest })).total).toBe(all.total);
    const [p1, p2] = await Promise.all([1, 2].map((page) => list({ size: Math.ceil(all.total / 2), page })));
    expect([...p1.items, ...p2.items].map((i) => i.movementId)).toEqual(all.items.map((i) => i.movementId));
    for (const bad of <Array<Record<string, string | number>>>[
      { type: 'SALE' }, { type: 'reserve' }, { listingId: 'L-1' }, { batchId: 'B-1' }, { pharmacyId: 'x' }, { createdFrom: 'yesterday' }, { page: 0 }, { size: 101 },
      { reason: 'x' }, { orderId: randomUUID() }, { refId: 'x' }, { actorUserId: 'x' }, { q: 'x' },
    ]) {
      expect({ bad, status: (await get(BASE, bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: the same core fields as the list row; unknown → 404; malformed → 400', async () => {
    await seedSet();
    const first = (await list()).items[0];
    expect(body(await get(`${BASE}/${first.movementId}`).expect(200))).toEqual(first);
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/summary`).expect(400);
  });

  it('movements of a since-deleted listing stay in the history (a soft delete does not erase it)', async () => {
    const s = await seedSet();
    const before = (await list({ listingId: s.listingB.id })).total;
    await ctx.prisma.inventoryListing.update({ where: { id: s.listingB.id }, data: { deletedAt: new Date() } });
    expect((await list({ listingId: s.listingB.id })).total).toBe(before);
  });

  it('privacy: no reason text, idempotency key, order or reservation id, actor, supplier, batch number, price or customer detail', async () => {
    const s = await seedSet();
    const raw = JSON.stringify([await list(), ...(await Promise.all((await list()).items.slice(0, 3).map((i) => get(`${BASE}/${i.movementId}`)))).map((r) => r.body)]);
    const rows = await ctx.prisma.stockMovement.findMany();
    const secrets = [
      'SUPPLIER-SECRET', 'B-SECRET-2', 'Abebe', '+251911777888', 'Damaged', 'Bole Road', 'idempotencyKey', 'customer-cancel',
      s.a.orderId, s.b.orderId, s.a.customer.userId, s.a.pharmacy.userId,
      ...rows.flatMap((r) => [r.refId, r.reservationId, r.actorUserId]).filter((v): v is string => !!v),
    ];
    for (const secret of secrets) expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    expect(raw).not.toMatch(/"(reason|refId|reservationId|actorUserId|orderId|price|supplier|batchNumber)"/);
  });

  it('read-only: movements, listings, batches, reservations, pharmacies, branches, audit and outbox unchanged; other methods 404; Works 47–49 still answer', async () => {
    const s = await seedSet();
    const state = async () => ({
      movements: await ctx.prisma.stockMovement.findMany({ orderBy: { id: 'asc' } }),
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
      reservations: await ctx.prisma.stockReservation.findMany({ orderBy: { id: 'asc' } }),
      pharmacies: await ctx.prisma.pharmacy.findMany({ orderBy: { id: 'asc' } }),
      branches: await ctx.prisma.branch.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await list();
    await list({ type: 'DISPATCH' });
    const id = (await list()).items[0].movementId;
    await get(`${BASE}/${id}`).expect(200);
    for (const [method, path] of [['post', BASE], ['put', `${BASE}/${id}`], ['patch', `${BASE}/${id}`], ['delete', `${BASE}/${id}`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ quantityDelta: 5 })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
    await get(`/admin/operations/inventory/listings/${s.listingA.id}`).expect(200);
    await get(`/admin/operations/pharmacies/${s.listingA.pharmacyId}`).expect(200);
    await get(`/admin/operations/branches/${s.listingA.branchId}`).expect(200);
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; the order’s own pharmacy owner and other roles 403', async () => {
    const s = await seedSet();
    const id = (await list()).items[0].movementId;
    const paths = [BASE, `${BASE}/${id}`];
    const sup = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    for (const path of paths) {
      expect((await get(path, {}, null)).status).toBe(401);
      expect((await get(path, {}, sup)).status).toBe(200);
    }
    const tokens: Array<[string, string]> = [['PHARMACY_OWNER (own pharmacy)', s.a.pharmacy.accessToken]];
    for (const role of ['PHARMACY_MANAGER', 'INVENTORY_STAFF', 'DRIVER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    for (const [role, token] of tokens) {
      for (const path of paths) expect({ role, path, status: (await get(path, {}, token)).status }).toEqual({ role, path, status: 403 });
    }
  });
});
