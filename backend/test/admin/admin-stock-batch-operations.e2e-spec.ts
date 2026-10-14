import { randomUUID } from 'crypto';
import request from 'supertest';
import { SellableStockCalculator } from '../../src/modules/pharmacy-inventory/domain/services/sellable-stock.calculator';
import { auth, body, createUserWithRole, RegisteredUser, Tokens, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Item = {
  batchId: string; listingId: string; pharmacyId: string; branchId: string; catalogProductId: string;
  quantity: number; expiryDate: string; isExpired: boolean; receivedAt: string | null; createdAt: string;
};
type Page = { generatedAt: string; items: Item[]; total: number; page: number; size: number };
const BASE = '/admin/operations/inventory/batches';

/**
 * Module 16 Work 51 against real PostgreSQL: read-only stock batches and their expiry, classified by
 * Module 04's own rule at one `generatedAt`.
 */
describe('Admin stock batch visibility (e2e)', () => {
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
  const ids = (p: Page) => p.items.map((i) => i.batchId);
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);

  async function listing(o: { deleted?: boolean } = {}) {
    const owner = await ctx.prisma.user.create({ data: { primaryRole: 'PHARMACY_OWNER', status: 'ACTIVE', phone: uniquePhone() } });
    const org = await ctx.prisma.organization.create({ data: { type: 'PHARMACY', name: `Org ${randomUUID()}`, status: 'ACTIVE', ownerUserId: owner.id } });
    const p = await ctx.prisma.pharmacy.create({ data: { organizationId: org.id, displayName: 'Secret Pharmacy', transactingStatus: 'ACTIVE' } });
    const b = await ctx.prisma.branch.create({ data: { pharmacyId: p.id, name: 'Main', addressLine: 'Africa Ave 9', phone: '+251911000444' } });
    return ctx.prisma.inventoryListing.create({ data: { pharmacyId: p.id, branchId: b.id, catalogProductId: randomUUID(), price: 4_200, onHand: 0, sellable: 0, deletedAt: o.deleted ? new Date() : null } });
  }
  const batch = (listingId: string, quantity: number, expiryDate: Date, receivedAt: Date | null = null) =>
    ctx.prisma.stockBatch.create({ data: { listingId, batchNumber: `LOT-SECRET-${randomUUID().slice(0, 4)}`, quantity, expiryDate, supplier: 'SUPPLIER-SECRET Pharma Ltd', receivedAt } });

  async function seedSet() {
    const l1 = await listing();
    const l2 = await listing();
    const gone = await listing({ deleted: true });
    const expired = await batch(l1.id, 4, days(-3));
    const justExpired = await batch(l1.id, 2, new Date(Date.now() - 1_000)); // a second ago
    const soon = await batch(l1.id, 6, days(5), days(-10));
    const later = await batch(l1.id, 0, days(60)); // drawn down to zero, not expired
    const other = await batch(l2.id, 9, days(20));
    const onDeleted = await batch(gone.id, 5, days(30));
    // Several movements on one batch must not repeat it.
    for (const [type, quantityDelta] of [['RECEIPT', 6], ['ADJUST', -1], ['ADJUST', 1]] as const) {
      await ctx.prisma.stockMovement.create({ data: { listingId: l1.id, batchId: soon.id, type, quantityDelta, reason: 'counted by Abebe' } });
    }
    return { l1, l2, gone, expired, justExpired, soon, later, other, onDeleted };
  }

  it('an empty list (still with its generatedAt)', async () => {
    const res = body(await get(BASE).expect(200)) as unknown as Page;
    expect([res.items, res.total, res.page, res.size]).toEqual([[], 0, 1, 20]);
    expect(Date.parse(res.generatedAt)).not.toBeNaN();
  });

  it('batches of live listings once each, soonest expiry first; fields match the rows; isExpired is the calculator’s rule at generatedAt', async () => {
    const s = await seedSet();
    const res = await list();
    expect(ids(res)).toEqual([s.expired.id, s.justExpired.id, s.soon.id, s.other.id, s.later.id]); // onDeleted excluded
    const now = new Date(res.generatedAt);
    for (const item of res.items) {
      const r = await ctx.prisma.stockBatch.findUniqueOrThrow({ where: { id: item.batchId }, include: { listing: true } });
      const countsTowardSellable = SellableStockCalculator.computeSellable([{ quantity: 1, expiryDate: r.expiryDate }], 0, now) === 1;
      expect(item).toEqual({
        batchId: r.id, listingId: r.listingId, pharmacyId: r.listing.pharmacyId, branchId: r.listing.branchId, catalogProductId: r.listing.catalogProductId,
        quantity: r.quantity, expiryDate: r.expiryDate.toISOString(), isExpired: !countsTowardSellable, receivedAt: r.receivedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
      });
    }
    expect(res.items.filter((i) => i.isExpired).map((i) => i.batchId)).toEqual([s.expired.id, s.justExpired.id]);
    expect(res.items.find((i) => i.batchId === s.later.id)).toMatchObject({ quantity: 0, isExpired: false }); // zero quantity is not expiry
  });

  it('batch quantity is not listing stock: it agrees with Work 49’s unexpired-batch diagnostics and Work 50’s movements still list separately', async () => {
    const s = await seedSet();
    const l = body(await get(`/admin/operations/inventory/listings/${s.l1.id}`).expect(200)) as { storedSellable: number; unexpiredBatchCount: number; unexpiredBatchQuantity: number };
    const mine = (await list({ listingId: s.l1.id })).items;
    const live = mine.filter((i) => !i.isExpired);
    expect([l.unexpiredBatchCount, l.unexpiredBatchQuantity]).toEqual([live.length, live.reduce((acc, i) => acc + i.quantity, 0)]);
    expect(l.storedSellable).toBe(0); // the listing's stored column is its own figure, untouched
    const moves = body(await get('/admin/operations/inventory/movements', { batchId: s.soon.id }).expect(200)) as { total: number };
    expect(moves.total).toBe(3);
    expect((await list({ listingId: s.l1.id })).total).toBe(4); // and the batch with three movements is still one row
  });

  it('filters: listing, owner ids, expiry window, expired flag, created window; combinations; stable paging; rejects bad input', async () => {
    const s = await seedSet();
    expect(ids(await list({ listingId: s.l2.id }))).toEqual([s.other.id]);
    expect(ids(await list({ pharmacyId: s.l2.pharmacyId }))).toEqual([s.other.id]);
    expect(ids(await list({ branchId: s.l1.branchId, isExpired: 'false' }))).toEqual([s.soon.id, s.later.id]);
    expect(ids(await list({ catalogProductId: s.l1.catalogProductId, isExpired: 'true' }))).toEqual([s.expired.id, s.justExpired.id]);
    expect(ids(await list({ expiresFrom: days(1).toISOString(), expiresTo: days(30).toISOString() }))).toEqual([s.soon.id, s.other.id]);
    expect(ids(await list({ expiresTo: days(30).toISOString(), isExpired: 'false' }))).toEqual([s.soon.id, s.other.id]);
    expect(ids(await list({ listingId: s.gone.id }))).toEqual([]); // a deleted listing's batches are not listed
    const all = await list();
    const [p1, p2] = await Promise.all([1, 2].map((page) => list({ size: 3, page })));
    expect([p1.total, p2.total]).toEqual([5, 5]);
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(all));
    expect((await list({ createdFrom: all.items[0].createdAt })).total).toBeGreaterThan(0);
    for (const bad of <Array<Record<string, string | number>>>[
      { listingId: 'L-1' }, { pharmacyId: 'x' }, { batchId: randomUUID() }, { expiresFrom: 'next week' }, { isExpired: 'yes' }, { isExpired: 'TRUE' },
      { createdTo: 'soon' }, { page: 0 }, { size: 101 }, { batchNumber: 'LOT' }, { supplier: 'x' }, { expiringWithinDays: 30 },
    ]) {
      expect({ bad, status: (await get(BASE, bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: the same core fields plus generatedAt; batch on a deleted listing, unknown and other ids → 404; malformed → 400', async () => {
    const s = await seedSet();
    const d = body(await get(`${BASE}/${s.soon.id}`).expect(200)) as Item & { generatedAt: string };
    const { generatedAt, ...core } = d;
    expect(Date.parse(generatedAt)).not.toBeNaN();
    expect(core).toEqual((await list()).items.find((i) => i.batchId === s.soon.id));
    await get(`${BASE}/${s.onDeleted.id}`).expect(404);
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/${s.l1.id}`).expect(404); // a listing id is not a batch id
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/summary`).expect(400);
  });

  it('privacy: no batch number, supplier, price, reason text, address or phone', async () => {
    const s = await seedSet();
    const raw = JSON.stringify([await list(), (await get(`${BASE}/${s.soon.id}`)).body]);
    for (const secret of ['LOT-SECRET', 'SUPPLIER-SECRET', 'Abebe', 'Africa Ave', '+251911000444', 'Secret Pharmacy']) {
      expect({ secret, found: raw.includes(secret) }).toEqual({ secret, found: false });
    }
    expect(raw).not.toMatch(/"(batchNumber|supplier|price|reason|movements|reservations|sellable|reserved)"/);
  });

  it('read-only: batches, listings, movements, reservations, pharmacies, branches, audit and outbox unchanged; other methods 404', async () => {
    const s = await seedSet();
    const state = async () => ({
      batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      movements: await ctx.prisma.stockMovement.findMany({ orderBy: { id: 'asc' } }),
      reservations: await ctx.prisma.stockReservation.count(),
      pharmacies: await ctx.prisma.pharmacy.findMany({ orderBy: { id: 'asc' } }),
      branches: await ctx.prisma.branch.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await list();
    await list({ isExpired: 'true' });
    await get(`${BASE}/${s.expired.id}`).expect(200);
    for (const [method, path] of [['post', BASE], ['put', `${BASE}/${s.expired.id}`], ['patch', `${BASE}/${s.expired.id}`], ['delete', `${BASE}/${s.expired.id}`], ['post', `${BASE}/${s.expired.id}/expire`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ quantity: 0 })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; pharmacy owner/manager, inventory staff, driver, customer, support, finance 403', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.soon.id}`];
    const sup = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    for (const path of paths) {
      expect((await get(path, {}, null)).status).toBe(401);
      expect((await get(path, {}, sup)).status).toBe(200);
    }
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'INVENTORY_STAFF', 'DRIVER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      const token = (await createUserWithRole(ctx, role)).accessToken;
      for (const path of paths) expect({ role, path, status: (await get(path, {}, token)).status }).toEqual({ role, path, status: 403 });
    }
  });
});
