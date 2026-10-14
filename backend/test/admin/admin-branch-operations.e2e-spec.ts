import { randomUUID } from 'crypto';
import request from 'supertest';
import { TransactingEligibilityPolicy } from '../../src/modules/pharmacy-inventory/domain/services/transacting-eligibility.policy';
import { auth, body, createUserWithRole, RegisteredUser, Tokens, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Listings = { total: number; enabled: number; disabled: number; inStock: number; outOfStock: number; customerPurchasable: number; customerUnpurchasable: number };
type Item = { branchId: string; pharmacyId: string; isActive: boolean; pharmacyEligible: boolean; createdAt: string; updatedAt: string; listings: Listings };
type Page = { items: Item[]; total: number; page: number; size: number };
const BASE = '/admin/operations/branches';

/**
 * Module 16 Work 48 against real PostgreSQL: read-only branch operations — each live branch's own
 * flag, its pharmacy's eligibility, and its listing counts by Module 04's existing rules.
 */
describe('Admin branch operations (e2e)', () => {
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
  const ids = (p: Page) => p.items.map((i) => i.branchId);
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);

  async function pharmacy(o: { expires?: Date; deleted?: boolean } = {}) {
    const owner = await ctx.prisma.user.create({ data: { primaryRole: 'PHARMACY_OWNER', status: 'ACTIVE', phone: uniquePhone() } });
    const org = await ctx.prisma.organization.create({ data: { type: 'PHARMACY', name: `Org ${randomUUID()}`, status: 'ACTIVE', ownerUserId: owner.id } });
    return ctx.prisma.pharmacy.create({
      data: { organizationId: org.id, displayName: 'Secret Pharmacy Name', transactingStatus: 'ACTIVE', licenseExpiresAt: o.expires ?? null, deletedAt: o.deleted ? t(1) : null },
    });
  }
  const branch = (pharmacyId: string, minutesAgo: number, isActive = true, deleted = false) =>
    ctx.prisma.branch.create({
      data: { pharmacyId, name: 'Abebe Family Branch', addressLine: 'Africa Ave 9', city: 'Addis Ababa', lat: 9.0312, lng: 38.7421, phone: '+251911000222', isActive, createdAt: t(minutesAgo), deletedAt: deleted ? t(1) : null },
    });
  async function listing(pharmacyId: string, branchId: string, o: { enabled?: boolean; sellable: number; batch?: 'fresh' | 'expired'; deleted?: boolean }) {
    const l = await ctx.prisma.inventoryListing.create({
      data: { pharmacyId, branchId, catalogProductId: randomUUID(), price: 1_000, onHand: o.sellable, sellable: o.sellable, isEnabled: o.enabled ?? true, deletedAt: o.deleted ? t(1) : null },
    });
    if (o.batch) await ctx.prisma.stockBatch.create({ data: { listingId: l.id, batchNumber: `B-${randomUUID().slice(0, 6)}`, quantity: Math.max(o.sellable, 1), expiryDate: o.batch === 'fresh' ? days(30) : days(-1) } });
    return l;
  }

  async function seedSet() {
    const a = await pharmacy(); // eligible
    const a1 = await branch(a.id, 50); // active, mixed listings
    await listing(a.id, a1.id, { sellable: 5, batch: 'fresh' }); // purchasable
    await listing(a.id, a1.id, { sellable: 5, batch: 'expired' }); // stored in stock, BRULE-15 zero → unpurchasable
    await listing(a.id, a1.id, { enabled: false, sellable: 5, batch: 'fresh' }); // disabled
    await listing(a.id, a1.id, { sellable: 0 }); // out of stock
    await listing(a.id, a1.id, { sellable: 5, batch: 'fresh', deleted: true }); // deleted listing: not tracked
    const a2 = await branch(a.id, 40, false); // inactive branch, fresh stock → unpurchasable
    await listing(a.id, a2.id, { sellable: 5, batch: 'fresh' });
    const a3 = await branch(a.id, 35, true, true); // deleted branch: never listed
    const b = await pharmacy({ expires: days(-3) }); // stored ACTIVE, licence expired → ineligible
    const b1 = await branch(b.id, 30); // active branch of an ineligible pharmacy
    await listing(b.id, b1.id, { sellable: 5, batch: 'fresh' });
    const c = await pharmacy({ deleted: true }); // soft-deleted pharmacy
    const c1 = await branch(c.id, 20);
    await listing(c.id, c1.id, { sellable: 5, batch: 'fresh' });
    return { a, a1, a2, a3, b, b1, c, c1 };
  }

  /** From the persisted rows, with Module 04's policy and BRULE-15 written out here. */
  async function expectedFor(branchId: string) {
    const now = new Date();
    const br = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: branchId }, include: { pharmacy: true } });
    const listings = await ctx.prisma.inventoryListing.findMany({ where: { branchId }, include: { batches: true } });
    const eligible = TransactingEligibilityPolicy.isEligible(br.pharmacy, now);
    const live = listings.filter((l) => l.deletedAt === null);
    const enabled = live.filter((l) => l.isEnabled);
    const inStock = enabled.filter((l) => l.sellable > 0);
    const purchasable = inStock.filter((l) => br.isActive && eligible && br.pharmacy.deletedAt === null && l.batches.filter((x) => x.expiryDate > now).reduce((s, x) => s + x.quantity, 0) - l.reserved > 0);
    return {
      pharmacyId: br.pharmacyId, isActive: br.isActive, pharmacyEligible: eligible,
      listings: { total: live.length, enabled: enabled.length, disabled: live.length - enabled.length, inStock: inStock.length, outOfStock: enabled.length - inStock.length, customerPurchasable: purchasable.length, customerUnpurchasable: live.length - purchasable.length },
    };
  }

  it('an empty list', async () => {
    expect(body(await get(BASE).expect(200))).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('lists live branches of live pharmacies newest first; each counted once; every metric cross-checked against the rows', async () => {
    const s = await seedSet();
    const res = await list();
    expect(ids(res)).toEqual([s.b1.id, s.a2.id, s.a1.id]); // a3 deleted, c1 under a deleted pharmacy
    expect(res.total).toBe(3);
    expect(res.items.find((i) => i.branchId === s.a1.id)).toMatchObject({ isActive: true, pharmacyEligible: true, listings: { total: 4, enabled: 3, disabled: 1, inStock: 2, outOfStock: 1, customerPurchasable: 1, customerUnpurchasable: 3 } });
    expect(res.items.find((i) => i.branchId === s.a2.id)).toMatchObject({ isActive: false, pharmacyEligible: true, listings: { total: 1, inStock: 1, customerPurchasable: 0 } });
    expect(res.items.find((i) => i.branchId === s.b1.id)).toMatchObject({ isActive: true, pharmacyEligible: false, listings: { total: 1, inStock: 1, customerPurchasable: 0, customerUnpurchasable: 1 } });
    for (const item of res.items) {
      const row = await ctx.prisma.branch.findUniqueOrThrow({ where: { id: item.branchId } });
      expect({ id: item.branchId, ...(await expectedFor(item.branchId)) }).toEqual({ id: item.branchId, pharmacyId: item.pharmacyId, isActive: item.isActive, pharmacyEligible: item.pharmacyEligible, listings: item.listings });
      expect([item.createdAt, item.updatedAt]).toEqual([row.createdAt.toISOString(), row.updatedAt.toISOString()]);
    }
  });

  it('branch figures add up to Work 47’s pharmacy figures (same definitions)', async () => {
    const s = await seedSet();
    for (const p of [s.a, s.b]) {
      const pharmacy = body(await request(ctx.server).get(`/admin/operations/pharmacies/${p.id}`).set(...auth(admin.accessToken)).expect(200)) as { branches: { total: number; active: number }; listings: Listings };
      const rows = (await list({ pharmacyId: p.id })).items;
      expect(rows.length).toBe(pharmacy.branches.total);
      expect(rows.filter((r) => r.isActive).length).toBe(pharmacy.branches.active);
      for (const k of Object.keys(pharmacy.listings) as Array<keyof Listings>) {
        expect({ k, sum: rows.reduce((acc, r) => acc + r.listings[k], 0) }).toEqual({ k, sum: pharmacy.listings[k] });
      }
    }
  });

  it('filters by pharmacy, active flag, purchasable inventory and created window; pages stably; rejects bad input', async () => {
    const s = await seedSet();
    expect(new Set(ids(await list({ pharmacyId: s.a.id })))).toEqual(new Set([s.a1.id, s.a2.id]));
    expect(ids(await list({ pharmacyId: s.c.id }))).toEqual([]);
    expect(new Set(ids(await list({ isActive: 'true' })))).toEqual(new Set([s.a1.id, s.b1.id]));
    expect(ids(await list({ isActive: 'false' }))).toEqual([s.a2.id]);
    expect(ids(await list({ hasPurchasableInventory: 'true' }))).toEqual([s.a1.id]);
    expect(new Set(ids(await list({ hasPurchasableInventory: 'false' })))).toEqual(new Set([s.a2.id, s.b1.id]));
    expect(ids(await list({ isActive: 'true', hasPurchasableInventory: 'false' }))).toEqual([s.b1.id]); // active, yet nothing purchasable
    expect(ids(await list({ createdFrom: t(45).toISOString(), createdTo: t(25).toISOString() }))).toEqual([s.b1.id, s.a2.id]);
    const [p1, p2] = await Promise.all([1, 2].map((page) => list({ size: 2, page })));
    expect([p1.total, p2.total]).toEqual([3, 3]);
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(await list()));
    for (const bad of <Array<Record<string, string | number>>>[
      { pharmacyId: 'ph-1' }, { isActive: 'yes' }, { isActive: 'TRUE' }, { hasPurchasableInventory: '1' }, { createdFrom: 'yesterday' }, { page: 0 }, { size: 101 },
      { name: 'Abebe' }, { city: 'Addis' }, { status: 'ACTIVE' }, { q: 'x' },
    ]) {
      expect({ bad, status: (await get(BASE, bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: same core fields as the list row; deleted branch, branch of a deleted pharmacy and unknown id → 404; malformed → 400', async () => {
    const s = await seedSet();
    expect(body(await get(`${BASE}/${s.a1.id}`).expect(200))).toEqual((await list()).items.find((i) => i.branchId === s.a1.id));
    await get(`${BASE}/${s.a3.id}`).expect(404);
    await get(`${BASE}/${s.c1.id}`).expect(404);
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/${s.a.id}`).expect(404); // a pharmacy id is not a branch id
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/summary`).expect(400);
  });

  it('privacy: no branch name, address, city, coordinates, phone or pharmacy name', async () => {
    const s = await seedSet();
    const raw = JSON.stringify([await list(), (await get(`${BASE}/${s.a1.id}`)).body]);
    for (const secret of ['Abebe Family', 'Africa Ave', 'Addis Ababa', '9.0312', '38.7421', '+251911000222', 'Secret Pharmacy']) {
      expect({ secret, found: raw.includes(secret) }).toEqual({ secret, found: false });
    }
    expect(raw).not.toMatch(/"name"|address|city|region|phone|lat"|lng"|displayName|catalogProductId|price|batch|reserv/i);
  });

  it('read-only: branches, pharmacies, listings, batches, reservations, movements, audit and outbox unchanged; other methods 404; Work 25/26 still answer', async () => {
    const s = await seedSet();
    const state = async () => ({
      branches: await ctx.prisma.branch.findMany({ orderBy: { id: 'asc' } }),
      pharmacies: await ctx.prisma.pharmacy.findMany({ orderBy: { id: 'asc' } }),
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
      reservations: await ctx.prisma.stockReservation.count(),
      movements: await ctx.prisma.stockMovement.count(),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    for (const q of <Array<Record<string, string>>>[{}, { isActive: 'false' }, { hasPurchasableInventory: 'true' }]) await list(q);
    await get(`${BASE}/${s.a1.id}`).expect(200);
    for (const [method, path] of [['post', BASE], ['put', `${BASE}/${s.a1.id}`], ['patch', `${BASE}/${s.a1.id}`], ['delete', `${BASE}/${s.a1.id}`], ['post', `${BASE}/${s.a1.id}/deactivate`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ isActive: false })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
    const overview = body(await get('/admin/operations/inventory/overview').expect(200)) as { inventory: Record<string, number> };
    expect(overview.inventory.customerPurchasableListings).toBe((await list()).items.reduce((acc, r) => acc + r.listings.customerPurchasable, 0));
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; pharmacy owner/manager, driver, customer, support, finance 403', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.a1.id}`];
    const sup = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    for (const path of paths) {
      expect((await get(path, {}, null)).status).toBe(401);
      expect((await get(path, {}, sup)).status).toBe(200);
    }
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'DRIVER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      const token = (await createUserWithRole(ctx, role)).accessToken;
      for (const path of paths) expect({ role, path, status: (await get(path, {}, token)).status }).toEqual({ role, path, status: 403 });
    }
  });
});
