import { randomUUID } from 'crypto';
import request from 'supertest';
import { SellableStockCalculator } from '../../src/modules/pharmacy-inventory/domain/services/sellable-stock.calculator';
import { TransactingEligibilityPolicy } from '../../src/modules/pharmacy-inventory/domain/services/transacting-eligibility.policy';
import { auth, body, createUserWithRole, RegisteredUser, Tokens, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Item = {
  listingId: string; pharmacyId: string; branchId: string; catalogProductId: string; isEnabled: boolean;
  storedSellable: number; computedSellable: number; customerPurchasable: boolean; createdAt: string; updatedAt: string;
};
type Detail = Item & { reserved: number; unexpiredBatchCount: number; unexpiredBatchQuantity: number; storedMatchesComputed: boolean };
type Page = { items: Item[]; total: number; page: number; size: number };
const BASE = '/admin/operations/inventory/listings';

/**
 * Module 16 Work 49 against real PostgreSQL: read-only listing visibility — stored versus computed
 * sellable stock (`SellableStockCalculator`) and Work 26's customer-purchasability, per listing.
 */
describe('Admin inventory listing operations (e2e)', () => {
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
  const ids = (p: Page) => p.items.map((i) => i.listingId);
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  async function pharmacy(expires: Date | null = null) {
    const owner = await ctx.prisma.user.create({ data: { primaryRole: 'PHARMACY_OWNER', status: 'ACTIVE', phone: uniquePhone() } });
    const org = await ctx.prisma.organization.create({ data: { type: 'PHARMACY', name: `Org ${randomUUID()}`, status: 'ACTIVE', ownerUserId: owner.id } });
    return ctx.prisma.pharmacy.create({ data: { organizationId: org.id, displayName: 'Secret Pharmacy', transactingStatus: 'ACTIVE', licenseExpiresAt: expires } });
  }
  const branch = (pharmacyId: string, isActive = true) =>
    ctx.prisma.branch.create({ data: { pharmacyId, name: 'Main', addressLine: 'Africa Ave 9', lat: 9.0312, lng: 38.7421, phone: '+251911000333', isActive } });
  let minutes = 1_000;
  async function listing(pharmacyId: string, branchId: string, o: { sellable: number; reserved?: number; batches?: Array<[number, number]>; enabled?: boolean; deleted?: boolean }) {
    const l = await ctx.prisma.inventoryListing.create({
      data: {
        pharmacyId, branchId, catalogProductId: randomUUID(), price: 4_200, onHand: o.sellable + (o.reserved ?? 0), sellable: o.sellable, reserved: o.reserved ?? 0,
        isEnabled: o.enabled ?? true, deletedAt: o.deleted ? t(1) : null, createdAt: t((minutes -= 10)),
      },
    });
    for (const [quantity, inDays] of o.batches ?? []) {
      await ctx.prisma.stockBatch.create({ data: { listingId: l.id, batchNumber: `B-${randomUUID().slice(0, 6)}`, quantity, expiryDate: days(inDays), supplier: 'SUPPLIER-SECRET' } });
    }
    // The reserved column is backed by real reservation rows; they must not duplicate the listing or reach the response.
    if (o.reserved) {
      await ctx.prisma.stockReservation.create({ data: { listingId: l.id, orderId: randomUUID(), quantity: 1, expiresAt: days(1) } });
      await ctx.prisma.stockReservation.create({ data: { listingId: l.id, orderId: randomUUID(), quantity: o.reserved - 1, expiresAt: days(1) } });
    }
    return l;
  }

  async function seedSet() {
    minutes = 1_000;
    const a = await pharmacy();
    const a1 = await branch(a.id);
    const a2 = await branch(a.id, false);
    const b = await pharmacy(days(-1)); // licence expired → ineligible
    const b1 = await branch(b.id);
    return {
      a, a1, a2, b, b1,
      reservedOk: await listing(a.id, a1.id, { sellable: 7, reserved: 3, batches: [[10, 30]] }), // computed 7, purchasable
      expired: await listing(a.id, a1.id, { sellable: 5, batches: [[5, -1]] }), // stored 5, computed 0
      mixed: await listing(a.id, a1.id, { sellable: 10, batches: [[4, 30], [6, -1]] }), // stored 10, computed 4, purchasable
      disabled: await listing(a.id, a1.id, { sellable: 5, batches: [[5, 30]], enabled: false }),
      empty: await listing(a.id, a1.id, { sellable: 0 }),
      overReserved: await listing(a.id, a1.id, { sellable: 0, reserved: 5, batches: [[2, 30]] }), // computed max(0, 2-5) = 0
      deleted: await listing(a.id, a1.id, { sellable: 5, batches: [[5, 30]], deleted: true }),
      inactiveBranch: await listing(a.id, a2.id, { sellable: 5, batches: [[5, 30]] }), // computed 5, not purchasable
      ineligible: await listing(b.id, b1.id, { sellable: 5, batches: [[5, 30]] }), // computed 5, not purchasable
    };
  }

  /** From the persisted rows, with Module 04's own calculator and policy. */
  async function expectedFor(listingId: string) {
    const now = new Date();
    const l = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId }, include: { batches: true, branch: true, pharmacy: true } });
    const computed = SellableStockCalculator.computeSellable(l.batches, l.reserved, now);
    const purchasable = l.isEnabled && l.deletedAt === null && l.sellable > 0 && l.branch.isActive && l.pharmacy.deletedAt === null && TransactingEligibilityPolicy.isEligible(l.pharmacy, now) && computed > 0;
    const unexpired = l.batches.filter((x) => x.expiryDate > now);
    return { storedSellable: l.sellable, computedSellable: computed, customerPurchasable: purchasable, reserved: l.reserved, unexpiredBatchCount: unexpired.length, unexpiredBatchQuantity: unexpired.reduce((s, x) => s + x.quantity, 0) };
  }

  it('an empty list', async () => {
    expect(body(await get(BASE).expect(200))).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('lists every live listing once, newest first; stored and computed stock and purchasability cross-checked with the calculator and rows', async () => {
    const s = await seedSet();
    const res = await list();
    expect(res.total).toBe(8); // the deleted listing is not tracked
    expect(new Set(ids(res)).size).toBe(8);
    const byId = new Map(res.items.map((i) => [i.listingId, i]));
    const pick = (l: { id: string }) => { const i = byId.get(l.id)!; return [i.storedSellable, i.computedSellable, i.customerPurchasable]; };
    expect(pick(s.reservedOk)).toEqual([7, 7, true]);
    expect(pick(s.expired)).toEqual([5, 0, false]); // stored positive, computed zero — reported separately
    expect(pick(s.mixed)).toEqual([10, 4, true]);
    expect(pick(s.disabled)).toEqual([5, 5, false]);
    expect(pick(s.empty)).toEqual([0, 0, false]);
    expect(pick(s.overReserved)).toEqual([0, 0, false]); // never negative
    expect(pick(s.inactiveBranch)).toEqual([5, 5, false]);
    expect(pick(s.ineligible)).toEqual([5, 5, false]);
    for (const item of res.items) {
      const e = await expectedFor(item.listingId);
      expect({ id: item.listingId, stored: item.storedSellable, computed: item.computedSellable, purchasable: item.customerPurchasable }).toEqual({ id: item.listingId, stored: e.storedSellable, computed: e.computedSellable, purchasable: e.customerPurchasable });
    }
  });

  it('detail: the list fields plus reserved, unexpired batch count/quantity and storedMatchesComputed — from the calculator and rows', async () => {
    const s = await seedSet();
    for (const l of [s.reservedOk, s.expired, s.mixed, s.overReserved]) {
      const d = body(await get(`${BASE}/${l.id}`).expect(200)) as unknown as Detail;
      const e = await expectedFor(l.id);
      expect(d).toMatchObject({ ...e, storedMatchesComputed: e.storedSellable === e.computedSellable });
      const { reserved, unexpiredBatchCount, unexpiredBatchQuantity, storedMatchesComputed, ...core } = d;
      expect(core).toEqual((await list()).items.find((i) => i.listingId === l.id));
      expect([reserved, unexpiredBatchCount, unexpiredBatchQuantity, storedMatchesComputed].every((v) => v !== undefined)).toBe(true);
    }
    expect((body(await get(`${BASE}/${s.expired.id}`).expect(200)) as unknown as Detail).storedMatchesComputed).toBe(false);
    await get(`${BASE}/${s.deleted.id}`).expect(404);
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/${s.a1.id}`).expect(404); // a branch id is not a listing id
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/summary`).expect(400);
    await get('/admin/operations/inventory/overview').expect(200); // the sibling route is unaffected
  });

  it('filters by ids, enabled flag, stored sellable, purchasability and created window; pages stably; rejects bad input', async () => {
    const s = await seedSet();
    expect(new Set(ids(await list({ pharmacyId: s.b.id })))).toEqual(new Set([s.ineligible.id]));
    expect(new Set(ids(await list({ branchId: s.a2.id })))).toEqual(new Set([s.inactiveBranch.id]));
    expect(ids(await list({ catalogProductId: s.mixed.catalogProductId }))).toEqual([s.mixed.id]);
    expect(ids(await list({ isEnabled: 'false' }))).toEqual([s.disabled.id]);
    expect(new Set(ids(await list({ hasStoredSellableStock: 'false' })))).toEqual(new Set([s.empty.id, s.overReserved.id]));
    expect(new Set(ids(await list({ customerPurchasable: 'true' })))).toEqual(new Set([s.reservedOk.id, s.mixed.id]));
    expect((await list({ customerPurchasable: 'false' })).total).toBe(6);
    expect(new Set(ids(await list({ hasStoredSellableStock: 'true', customerPurchasable: 'false' })))).toEqual(new Set([s.expired.id, s.disabled.id, s.inactiveBranch.id, s.ineligible.id]));
    const all = await list();
    const created = (l: { id: string }) => all.items.find((i) => i.listingId === l.id)!.createdAt;
    expect(ids(await list({ createdFrom: created(s.mixed), createdTo: created(s.empty) }))).toEqual([s.disabled.id, s.mixed.id]);
    const [p1, p2, p3] = await Promise.all([1, 2, 3].map((page) => list({ size: 3, page })));
    expect([p1.total, p2.total, p3.total]).toEqual([8, 8, 8]);
    expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(ids(all));
    for (const bad of <Array<Record<string, string | number>>>[
      { pharmacyId: 'ph' }, { branchId: '7' }, { catalogProductId: 'AMOX' }, { isEnabled: 'yes' }, { hasStoredSellableStock: 'TRUE' }, { customerPurchasable: '1' },
      { createdFrom: 'yesterday' }, { page: 0 }, { size: 101 }, { lowStock: 'true' }, { productName: 'Amox' }, { q: 'x' },
    ]) {
      expect({ bad, status: (await get(BASE, bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('Work 25–27 and 47–48 keep their definitions: the list agrees with the overview and with the pharmacy and branch figures', async () => {
    const s = await seedSet();
    const rows = (await list()).items;
    const overview = body(await get('/admin/operations/inventory/overview').expect(200)) as { inventory: Record<string, number> };
    expect(overview.inventory.totalTrackedItems).toBe(rows.length);
    expect(overview.inventory.customerPurchasableListings).toBe(rows.filter((r) => r.customerPurchasable).length);
    expect(overview.inventory.enabledItems).toBe(rows.filter((r) => r.isEnabled).length);
    expect(overview.inventory.inStockItems).toBe(rows.filter((r) => r.isEnabled && r.storedSellable > 0).length);
    const pharmacy = body(await get(`/admin/operations/pharmacies/${s.a.id}`).expect(200)) as { listings: { total: number; customerPurchasable: number } };
    const mine = rows.filter((r) => r.pharmacyId === s.a.id);
    expect([pharmacy.listings.total, pharmacy.listings.customerPurchasable]).toEqual([mine.length, mine.filter((r) => r.customerPurchasable).length]);
    const branch = body(await get(`/admin/operations/branches/${s.a2.id}`).expect(200)) as { listings: { total: number; customerPurchasable: number } };
    expect([branch.listings.total, branch.listings.customerPurchasable]).toEqual([1, 0]);
  });

  it('privacy: ids and stock figures only — no product name, price, batch, supplier, reservation, order, address or phone', async () => {
    const s = await seedSet();
    const raw = JSON.stringify([await list(), (await get(`${BASE}/${s.reservedOk.id}`)).body]);
    const reservations = await ctx.prisma.stockReservation.findMany();
    const batches = await ctx.prisma.stockBatch.findMany();
    for (const secret of ['SUPPLIER-SECRET', 'Africa Ave', '+251911000333', '9.0312', 'Secret Pharmacy', ...reservations.flatMap((r) => [r.id, r.orderId!]), ...batches.flatMap((b) => [b.id, b.batchNumber])]) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/"(price|batchNumber|supplier|expiryDate|orderId|reservations|batches|customerUserId|name|displayName)"/i);
  });

  it('read-only: listings, batches, reservations, movements, branches, pharmacies, audit and outbox unchanged; other methods 404', async () => {
    const s = await seedSet();
    const state = async () => ({
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
      reservations: await ctx.prisma.stockReservation.findMany({ orderBy: { id: 'asc' } }),
      movements: await ctx.prisma.stockMovement.count(),
      branches: await ctx.prisma.branch.findMany({ orderBy: { id: 'asc' } }),
      pharmacies: await ctx.prisma.pharmacy.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    for (const q of <Array<Record<string, string>>>[{}, { customerPurchasable: 'false' }, { hasStoredSellableStock: 'true' }]) await list(q);
    await get(`${BASE}/${s.expired.id}`).expect(200); // the lagging stored sellable is reported, not reconciled
    for (const [method, path] of [['post', BASE], ['put', `${BASE}/${s.expired.id}`], ['patch', `${BASE}/${s.expired.id}`], ['delete', `${BASE}/${s.expired.id}`], ['post', `${BASE}/${s.expired.id}/recompute`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ sellable: 0 })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
    expect((await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: s.expired.id } })).sellable).toBe(5);
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; pharmacy owner/manager, inventory staff, driver, customer, support, finance 403', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.mixed.id}`];
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
