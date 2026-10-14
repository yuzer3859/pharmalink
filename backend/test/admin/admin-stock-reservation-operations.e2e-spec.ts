import { randomUUID } from 'crypto';
import request from 'supertest';
import { ReserveStockCommand } from '../../src/modules/pharmacy-inventory/application/commands/reserve-stock.command';
import { ReservationTtlSweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/reservation-ttl.sweeper';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder } from '../orders/support';

type User = RegisteredUser & Tokens;
type Item = {
  reservationId: string; listingId: string; pharmacyId: string; branchId: string; catalogProductId: string;
  quantity: number; status: string; expiresAt: string; heldPastExpiry: boolean; dispatched: boolean; createdAt: string;
};
type Page = { generatedAt: string; items: Item[]; total: number; page: number; size: number };
const BASE = '/admin/operations/inventory/reservations';

/**
 * Module 16 Work 52 against real PostgreSQL: read-only reservation visibility. Every reservation is
 * written by Module 04's production paths — checkout's reserve+confirm, dispatch, a customer
 * cancellation's release, a direct `ReserveStockCommand` hold, and the TTL sweeper's expiry.
 */
describe('Admin inventory reservation visibility (e2e)', () => {
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
  const byId = (p: Page, id: string) => p.items.find((i) => i.reservationId === id)!;

  // Checkout reserves through matching before the order row exists; the order line records the reservation.
  const reservationOf = async (orderId: string) => {
    const line = await ctx.prisma.orderLine.findFirstOrThrow({ where: { orderId } });
    return ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: line.reservationId! } });
  };

  async function seedSet() {
    // A: checkout reserves and confirms; the pharmacy's ready step dispatches it.
    const a = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${a.fulfillmentId}/${action}`).set(...auth(a.pharmacy.accessToken)).expect(200);
    }
    const dispatched = await reservationOf(a.orderId);
    // B: checkout, then the customer cancels — the release.
    const b = await placeOrder(ctx);
    await request(ctx.server).post(`/orders/${b.orderId}/cancel`).set(...auth(b.customer.accessToken)).send({ reason: 'Ordered for Almaz by mistake' }).expect(200);
    const released = await reservationOf(b.orderId);
    // Two holds through Module 04's own reserve command (checkout would confirm them immediately).
    const listingB = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: released.listingId } });
    const reserve = ctx.app.get(ReserveStockCommand);
    const heldOrder = randomUUID();
    const held = await reserve.execute({ listingId: listingB.id, quantity: 2, orderId: heldOrder, idempotencyKey: `idem-SECRET-${randomUUID()}` });
    const lapsedOrder = randomUUID();
    const lapsed = await reserve.execute({ listingId: listingB.id, quantity: 3, orderId: lapsedOrder, idempotencyKey: `idem-SECRET-${randomUUID()}` });
    // The clock moves past the lapsed hold's TTL (only expiresAt changes; the sweeper has not run).
    await ctx.prisma.stockReservation.update({ where: { id: lapsed.reservationId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    return { a, b, dispatched, released, listingB, held: held.reservationId, lapsed: lapsed.reservationId, heldOrder, lapsedOrder };
  }

  it('an empty list (with its generatedAt)', async () => {
    const res = body(await get(BASE).expect(200)) as unknown as Page;
    expect([res.items, res.total, res.page, res.size]).toEqual([[], 0, 1, 20]);
    expect(Date.parse(res.generatedAt)).not.toBeNaN();
  });

  it('every reservation once, newest first, field for field against the rows; states as the writers left them', async () => {
    const s = await seedSet();
    const res = await list();
    const rows = await ctx.prisma.stockReservation.findMany({ include: { listing: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    expect(res.items.map((i) => i.reservationId)).toEqual(rows.map((r) => r.id));
    const now = new Date(res.generatedAt);
    for (const item of res.items) {
      const r = rows.find((x) => x.id === item.reservationId)!;
      const dispatchMovements = await ctx.prisma.stockMovement.count({ where: { type: 'DISPATCH', reservationId: r.id } });
      expect(item).toEqual({
        reservationId: r.id, listingId: r.listingId, pharmacyId: r.listing.pharmacyId, branchId: r.listing.branchId, catalogProductId: r.listing.catalogProductId,
        quantity: r.quantity, status: r.status, expiresAt: r.expiresAt.toISOString(),
        heldPastExpiry: r.status === 'HELD' && r.expiresAt < now, dispatched: dispatchMovements > 0, createdAt: r.createdAt.toISOString(),
      });
    }
    expect(byId(res, s.dispatched.id)).toMatchObject({ status: 'CONFIRMED', dispatched: true, heldPastExpiry: false });
    expect(byId(res, s.released.id)).toMatchObject({ status: 'RELEASED', dispatched: false, heldPastExpiry: false });
    expect(byId(res, s.held)).toMatchObject({ status: 'HELD', quantity: 2, heldPastExpiry: false, dispatched: false });
    expect(byId(res, s.lapsed)).toMatchObject({ status: 'HELD', quantity: 3, heldPastExpiry: true });
  });

  it('a lapsed hold is reported, not expired, by reading; the real TTL sweeper then expires it and the view follows', async () => {
    const s = await seedSet();
    await list();
    await get(`${BASE}/${s.lapsed}`).expect(200);
    expect((await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: s.lapsed } })).status).toBe('HELD');
    await ctx.app.get(ReservationTtlSweeper).run();
    expect(byId(await list(), s.lapsed)).toMatchObject({ status: 'EXPIRED', heldPastExpiry: false });
    expect(byId(await list(), s.held)).toMatchObject({ status: 'HELD', heldPastExpiry: false }); // not yet due
  });

  it('a reservation’s quantity is its own; the listing’s reserved total is Work 49’s separate column', async () => {
    const s = await seedSet();
    const listing = body(await get(`/admin/operations/inventory/listings/${s.listingB.id}`).expect(200)) as { reserved: number };
    const row = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: s.listingB.id } });
    expect(listing.reserved).toBe(row.reserved); // Work 49 unchanged: the column
    const mine = (await list({ listingId: s.listingB.id })).items;
    const rows = await ctx.prisma.stockReservation.findMany({ where: { listingId: s.listingB.id } });
    expect(new Map(mine.map((i) => [i.reservationId, i.quantity]))).toEqual(new Map(rows.map((r) => [r.id, r.quantity])));
    // The column is the sum of live holds (RESERVE adds; RELEASE, EXPIRE and DISPATCH subtract): here the
    // direct hold (2) and the lapsed, not-yet-swept hold (3); the released checkout reservation no longer counts.
    const live = mine.filter((i) => i.status === 'HELD' || (i.status === 'CONFIRMED' && !i.dispatched));
    expect(live.map((i) => i.reservationId).sort()).toEqual([s.held, s.lapsed].sort());
    expect(row.reserved).toBe(live.reduce((n, i) => n + i.quantity, 0));
    expect(row.reserved).toBe(5);
    for (const i of mine) expect(i).not.toHaveProperty('reserved');
    // Work 50: the RESERVE and RELEASE movements for these reservations are still listed there.
    const moves = body(await get('/admin/operations/inventory/movements', { listingId: s.listingB.id }).expect(200)) as { items: Array<{ type: string }> };
    expect(moves.items.map((m) => m.type)).toEqual(expect.arrayContaining(['RESERVE', 'RELEASE']));
  });

  it('filters by listing, pharmacy, branch, status, heldPastExpiry and created window; pages stably; rejects bad input', async () => {
    const s = await seedSet();
    const all = await list();
    expect((await list({ listingId: s.listingB.id })).items.every((i) => i.listingId === s.listingB.id)).toBe(true);
    expect((await list({ pharmacyId: s.listingB.pharmacyId })).total).toBe(all.items.filter((i) => i.pharmacyId === s.listingB.pharmacyId).length);
    expect((await list({ branchId: s.listingB.branchId })).total).toBe(all.items.filter((i) => i.branchId === s.listingB.branchId).length);
    expect((await list({ status: 'RELEASED' })).items.map((i) => i.reservationId)).toEqual([s.released.id]);
    expect(new Set((await list({ status: 'HELD' })).items.map((i) => i.reservationId))).toEqual(new Set([s.held, s.lapsed]));
    expect((await list({ heldPastExpiry: 'true' })).items.map((i) => i.reservationId)).toEqual([s.lapsed]);
    expect((await list({ heldPastExpiry: 'false' })).total).toBe(all.total - 1);
    expect((await list({ status: 'EXPIRED' })).total).toBe(0);
    expect((await list({ createdTo: all.items[all.items.length - 1].createdAt })).total).toBe(0);
    const [p1, p2] = await Promise.all([1, 2].map((page) => list({ size: 2, page })));
    expect([...p1.items, ...p2.items].map((i) => i.reservationId)).toEqual(all.items.map((i) => i.reservationId));
    for (const bad of <Array<Record<string, string | number>>>[
      { status: 'ACTIVE' }, { status: 'held' }, { listingId: 'L-1' }, { pharmacyId: 'x' }, { heldPastExpiry: 'yes' }, { heldPastExpiry: 'TRUE' },
      { createdFrom: 'yesterday' }, { page: 0 }, { size: 101 }, { orderId: s.a.orderId }, { idempotencyKey: 'x' }, { customerUserId: 'x' }, { q: 'x' },
    ]) {
      expect({ bad, status: (await get(BASE, bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: the same core fields plus generatedAt; unknown, other ids → 404; malformed → 400', async () => {
    const s = await seedSet();
    const d = body(await get(`${BASE}/${s.dispatched.id}`).expect(200)) as Item & { generatedAt: string };
    const { generatedAt, ...core } = d;
    expect(Date.parse(generatedAt)).not.toBeNaN();
    expect(core).toEqual(byId(await list(), s.dispatched.id));
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/${s.listingB.id}`).expect(404); // a listing id is not a reservation id
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/summary`).expect(400);
  });

  it('privacy: no order id, idempotency key, customer, cancellation note or owner', async () => {
    const s = await seedSet();
    const raw = JSON.stringify([await list(), (await get(`${BASE}/${s.held}`)).body, (await get(`${BASE}/${s.released.id}`)).body]);
    const keys = (await ctx.prisma.stockReservation.findMany()).flatMap((r) => [r.idempotencyKey, r.orderId]).filter((k): k is string => !!k);
    for (const secret of [s.a.orderId, s.b.orderId, s.heldOrder, s.lapsedOrder, s.a.customer.userId, s.b.customer.userId, s.a.pharmacy.userId, 'idem-SECRET', 'Almaz', ...keys]) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/"(orderId|idempotencyKey|customerUserId|userId|reason|cancelReason)"/);
  });

  it('read-only: reservations, listings, batches, movements, audit and outbox unchanged; other methods 404; Works 49–51 still answer', async () => {
    const s = await seedSet();
    const state = async () => ({
      reservations: await ctx.prisma.stockReservation.findMany({ orderBy: { id: 'asc' } }),
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
      movements: await ctx.prisma.stockMovement.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await list();
    await list({ heldPastExpiry: 'true' });
    await get(`${BASE}/${s.lapsed}`).expect(200);
    for (const [method, path] of [['post', BASE], ['put', `${BASE}/${s.held}`], ['patch', `${BASE}/${s.held}`], ['delete', `${BASE}/${s.held}`], ['post', `${BASE}/${s.held}/release`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ status: 'RELEASED' })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
    await get(`/admin/operations/inventory/listings/${s.listingB.id}`).expect(200);
    await get('/admin/operations/inventory/movements').expect(200);
    await get('/admin/operations/inventory/batches').expect(200);
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; the reserving pharmacy’s owner and other roles 403', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.held}`];
    const sup = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    for (const path of paths) {
      expect((await get(path, {}, null)).status).toBe(401);
      expect((await get(path, {}, sup)).status).toBe(200);
    }
    const tokens: Array<[string, string]> = [['PHARMACY_OWNER (own pharmacy)', s.b.pharmacy.accessToken], ['CUSTOMER (own order)', s.b.customer.accessToken]];
    for (const role of ['PHARMACY_MANAGER', 'INVENTORY_STAFF', 'DRIVER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    for (const [role, token] of tokens) {
      for (const path of paths) expect({ role, path, status: (await get(path, {}, token)).status }).toEqual({ role, path, status: 403 });
    }
  });
});
