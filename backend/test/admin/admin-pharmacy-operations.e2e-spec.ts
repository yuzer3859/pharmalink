import { randomUUID } from 'crypto';
import request from 'supertest';
import { TransactingEligibilityPolicy } from '../../src/modules/pharmacy-inventory/domain/services/transacting-eligibility.policy';
import { auth, body, createUserWithRole, RegisteredUser, Tokens, uniquePhone } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Listings = { total: number; enabled: number; disabled: number; inStock: number; outOfStock: number; customerPurchasable: number; customerUnpurchasable: number };
type Item = { pharmacyId: string; transactingStatus: string; licenseStatus: string; licenseExpiresAt: string | null; eligible: boolean; createdAt: string; updatedAt: string; branches: { total: number; active: number }; listings: Listings };
type Page = { items: Item[]; total: number; page: number; size: number };
const BASE = '/admin/operations/pharmacies';

/**
 * Module 16 Work 47 against real PostgreSQL: read-only pharmacy operations — eligibility and
 * branch/listing counts per pharmacy, by Module 04's existing rules.
 */
describe('Admin pharmacy operations (e2e)', () => {
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
  const ids = (p: Page) => p.items.map((i) => i.pharmacyId);
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  const days = (n: number) => new Date(Date.now() + n * 86_400_000);

  async function pharmacy(o: { status: string; license?: string; expires?: Date | null; minutesAgo: number; deleted?: boolean }) {
    const owner = await ctx.prisma.user.create({ data: { primaryRole: 'PHARMACY_OWNER', status: 'ACTIVE', phone: uniquePhone() } });
    const org = await ctx.prisma.organization.create({ data: { type: 'PHARMACY', name: `Org ${randomUUID()}`, status: 'ACTIVE', ownerUserId: owner.id, licenseNumber: 'LIC-SECRET-77' } });
    const p = await ctx.prisma.pharmacy.create({
      data: {
        organizationId: org.id, displayName: 'Bole Secret Pharmacy', transactingStatus: o.status as never, licenseStatus: (o.license ?? 'VALID') as never,
        licenseExpiresAt: o.expires ?? null, createdAt: t(o.minutesAgo), deletedAt: o.deleted ? t(1) : null,
      },
    });
    return { ...p, ownerId: owner.id, ownerPhone: owner.phone };
  }
  const branch = (pharmacyId: string, isActive = true, deleted = false) =>
    ctx.prisma.branch.create({ data: { pharmacyId, name: 'Main', addressLine: 'Africa Ave 9', city: 'Addis Ababa', lat: 9.0312, lng: 38.7421, phone: '+251911000111', isActive, deletedAt: deleted ? t(1) : null } });
  async function listing(pharmacyId: string, branchId: string, o: { enabled?: boolean; sellable: number; batch?: 'fresh' | 'expired' | null; deleted?: boolean }) {
    const l = await ctx.prisma.inventoryListing.create({
      data: { pharmacyId, branchId, catalogProductId: randomUUID(), price: 1_000, onHand: o.sellable, sellable: o.sellable, isEnabled: o.enabled ?? true, deletedAt: o.deleted ? t(1) : null },
    });
    if (o.batch) await ctx.prisma.stockBatch.create({ data: { listingId: l.id, batchNumber: `B-${randomUUID().slice(0, 6)}`, quantity: Math.max(o.sellable, 1), expiryDate: o.batch === 'fresh' ? days(30) : days(-1) } });
    return l;
  }

  async function seedSet() {
    // A — eligible; every listing case on one pharmacy.
    const a = await pharmacy({ status: 'ACTIVE', minutesAgo: 50 });
    const aMain = await branch(a.id);
    const aClosed = await branch(a.id, false);
    await branch(a.id, true, true); // deleted branch: not counted
    await listing(a.id, aMain.id, { sellable: 5, batch: 'fresh' }); // purchasable
    await listing(a.id, aMain.id, { sellable: 5, batch: 'expired' }); // stored in stock, but BRULE-15 says 0 → unpurchasable
    await listing(a.id, aClosed.id, { sellable: 5, batch: 'fresh' }); // inactive branch → unpurchasable
    await listing(a.id, aMain.id, { enabled: false, sellable: 5, batch: 'fresh' }); // disabled
    await listing(a.id, aMain.id, { sellable: 0 }); // enabled, out of stock
    await listing(a.id, aMain.id, { sellable: 5, batch: 'fresh', deleted: true }); // deleted: not tracked
    // B — stored ACTIVE but licence expired: ineligible, so nothing purchasable.
    const b = await pharmacy({ status: 'ACTIVE', expires: days(-2), minutesAgo: 40 });
    const bMain = await branch(b.id);
    await listing(b.id, bMain.id, { sellable: 5, batch: 'fresh' });
    const c = await pharmacy({ status: 'SUSPENDED', minutesAgo: 30 }); // no branches, no listings
    const d = await pharmacy({ status: 'PENDING', license: 'EXPIRED', minutesAgo: 20 });
    const e = await pharmacy({ status: 'ACTIVE', minutesAgo: 10, deleted: true }); // soft-deleted: never listed
    const eMain = await branch(e.id);
    await listing(e.id, eMain.id, { sellable: 5, batch: 'fresh' });
    return { a, b, c, d, e };
  }

  /** The same figures, computed here from the persisted rows with Module 04's rules. */
  async function expectedFor(pharmacyId: string) {
    const now = new Date();
    const p = await ctx.prisma.pharmacy.findUniqueOrThrow({ where: { id: pharmacyId } });
    const branches = await ctx.prisma.branch.findMany({ where: { pharmacyId } });
    const listings = await ctx.prisma.inventoryListing.findMany({ where: { pharmacyId }, include: { batches: true, branch: true } });
    const eligible = TransactingEligibilityPolicy.isEligible(p, now);
    const live = listings.filter((l) => l.deletedAt === null);
    const enabled = live.filter((l) => l.isEnabled);
    const inStock = enabled.filter((l) => l.sellable > 0);
    const purchasable = inStock.filter(
      (l) => l.branch.isActive && p.deletedAt === null && eligible && l.batches.filter((x) => x.expiryDate > now).reduce((s, x) => s + x.quantity, 0) - l.reserved > 0,
    );
    return {
      eligible,
      branches: { total: branches.filter((x) => x.deletedAt === null).length, active: branches.filter((x) => x.deletedAt === null && x.isActive).length },
      listings: {
        total: live.length, enabled: enabled.length, disabled: live.length - enabled.length, inStock: inStock.length, outOfStock: enabled.length - inStock.length,
        customerPurchasable: purchasable.length, customerUnpurchasable: live.length - purchasable.length,
      },
    };
  }

  it('an empty list', async () => {
    expect(body(await get(BASE).expect(200))).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('lists live pharmacies newest first; every metric matches the expected figures and is cross-checked against the rows', async () => {
    const s = await seedSet();
    const res = await list();
    expect(res.total).toBe(4);
    expect(ids(res)).toEqual([s.d.id, s.c.id, s.b.id, s.a.id]); // e is soft-deleted
    const a = res.items.find((i) => i.pharmacyId === s.a.id)!;
    expect(a).toMatchObject({
      transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: null, eligible: true, branches: { total: 2, active: 1 },
      listings: { total: 5, enabled: 4, disabled: 1, inStock: 3, outOfStock: 1, customerPurchasable: 1, customerUnpurchasable: 4 },
    });
    const b = res.items.find((i) => i.pharmacyId === s.b.id)!;
    expect(b).toMatchObject({ transactingStatus: 'ACTIVE', eligible: false, listings: { total: 1, inStock: 1, customerPurchasable: 0, customerUnpurchasable: 1 } });
    expect(res.items.find((i) => i.pharmacyId === s.c.id)).toMatchObject({ eligible: false, branches: { total: 0, active: 0 }, listings: { total: 0, customerPurchasable: 0 } });
    for (const item of res.items) {
      const row = await ctx.prisma.pharmacy.findUniqueOrThrow({ where: { id: item.pharmacyId } });
      expect({ id: item.pharmacyId, ...(await expectedFor(item.pharmacyId)) }).toEqual({ id: item.pharmacyId, eligible: item.eligible, branches: item.branches, listings: item.listings });
      expect([item.transactingStatus, item.createdAt, item.updatedAt]).toEqual([row.transactingStatus, row.createdAt.toISOString(), row.updatedAt.toISOString()]);
    }
  });

  it('filters by stored status, eligibility (not the stored status alone), purchasable inventory and created window; pages stably; rejects bad input', async () => {
    const s = await seedSet();
    expect(new Set(ids(await list({ transactingStatus: 'ACTIVE' })))).toEqual(new Set([s.a.id, s.b.id]));
    expect(ids(await list({ eligible: 'true' }))).toEqual([s.a.id]);
    expect(new Set(ids(await list({ eligible: 'false' })))).toEqual(new Set([s.b.id, s.c.id, s.d.id]));
    expect(ids(await list({ transactingStatus: 'ACTIVE', eligible: 'false' }))).toEqual([s.b.id]); // ACTIVE yet ineligible
    expect(ids(await list({ hasPurchasableInventory: 'true' }))).toEqual([s.a.id]);
    expect(new Set(ids(await list({ hasPurchasableInventory: 'false' })))).toEqual(new Set([s.b.id, s.c.id, s.d.id]));
    expect(ids(await list({ createdFrom: t(45).toISOString(), createdTo: t(25).toISOString() }))).toEqual([s.c.id, s.b.id]);
    const [p1, p2] = await Promise.all([1, 2].map((page) => list({ size: 3, page })));
    expect([p1.total, p2.total]).toEqual([4, 4]);
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(await list()));
    for (const bad of <Array<Record<string, string | number>>>[
      { transactingStatus: 'ELIGIBLE' }, { transactingStatus: 'active' }, { eligible: 'yes' }, { eligible: 'TRUE' }, { hasPurchasableInventory: '1' },
      { createdFrom: 'yesterday' }, { page: 0 }, { size: 101 }, { name: 'Bole' }, { licenseNumber: 'LIC' }, { q: 'x' },
    ]) {
      expect({ bad, status: (await get(BASE, bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: same core fields as the list row; unknown, soft-deleted → 404; malformed → 400', async () => {
    const s = await seedSet();
    const d = body(await get(`${BASE}/${s.a.id}`).expect(200)) as unknown as Item;
    expect(d).toEqual((await list()).items.find((i) => i.pharmacyId === s.a.id));
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/${s.e.id}`).expect(404);
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/summary`).expect(400);
  });

  it('Work 25/26/08 keep their definitions: the per-pharmacy figures add up to the overview, plus what sits under a soft-deleted pharmacy', async () => {
    const s = await seedSet();
    const overview = body(await get('/admin/operations/inventory/overview').expect(200)) as { pharmacies: Record<string, number>; inventory: Record<string, number> };
    const rows = (await list()).items;
    const sum = (k: keyof Listings) => rows.reduce((acc, r) => acc + r.listings[k], 0);
    const deleted = (await expectedFor(s.e.id)).listings; // Work 08 counts live listings regardless of their pharmacy's liveness
    expect(overview.inventory).toEqual({
      totalTrackedItems: sum('total') + deleted.total,
      enabledItems: sum('enabled') + deleted.enabled,
      disabledItems: sum('disabled') + deleted.disabled,
      inStockItems: sum('inStock') + deleted.inStock,
      outOfStockItems: sum('outOfStock') + deleted.outOfStock,
      customerPurchasableListings: sum('customerPurchasable'), // a deleted pharmacy is never purchasable
      customerUnpurchasableListings: sum('customerUnpurchasable') + deleted.total,
    });
    expect(overview.pharmacies).toMatchObject({ total: 4, eligible: rows.filter((r) => r.eligible).length, eligibleWithAvailableStock: (await list({ hasPurchasableInventory: 'true', eligible: 'true' })).total });
    await get('/admin/analytics/overview').expect(200);
  });

  it('privacy: no name, owner, contact, address, coordinates or licence number', async () => {
    const s = await seedSet();
    const raw = JSON.stringify([await list(), ...(await Promise.all([s.a, s.b].map((p) => get(`${BASE}/${p.id}`)))).map((r) => r.body)]);
    const orgs = await ctx.prisma.organization.findMany();
    for (const secret of ['Bole Secret', 'LIC-SECRET', 'Africa Ave', '+251911000111', '9.0312', '38.7421', s.a.ownerId, s.a.ownerPhone!, ...orgs.map((o) => o.id)]) {
      expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
    expect(raw).not.toMatch(/displayName|organizationId|owner|licenseNumber|address|phone|lat"|lng"|catalogProductId|price/i);
  });

  it('read-only: pharmacies, branches, listings, batches, reservations, audit and outbox unchanged; other methods are 404', async () => {
    const s = await seedSet();
    const state = async () => ({
      pharmacies: await ctx.prisma.pharmacy.findMany({ orderBy: { id: 'asc' } }),
      branches: await ctx.prisma.branch.findMany({ orderBy: { id: 'asc' } }),
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
      reservations: await ctx.prisma.stockReservation.count(),
      movements: await ctx.prisma.stockMovement.count(),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    for (const q of <Array<Record<string, string>>>[{}, { eligible: 'true' }, { hasPurchasableInventory: 'false' }]) await list(q);
    await get(`${BASE}/${s.a.id}`).expect(200);
    for (const [method, path] of [['post', BASE], ['put', `${BASE}/${s.a.id}`], ['patch', `${BASE}/${s.a.id}`], ['delete', `${BASE}/${s.a.id}`], ['post', `${BASE}/${s.a.id}/suspend`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ transactingStatus: 'SUSPENDED' })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('RBAC: ADMIN and SUPER_ADMIN allowed; anonymous 401; pharmacy owner/manager, driver, customer, support, finance and analytics-only roles 403', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.a.id}`];
    const sup = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
    for (const path of paths) {
      expect((await get(path, {}, null)).status).toBe(401);
      expect((await get(path, {}, sup)).status).toBe(200);
    }
    const tokens: Array<[string, string]> = [];
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'DRIVER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    const analytics = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'analytics:read' } });
    const r = await ctx.prisma.role.upsert({ where: { key: 'ANALYTICS_VIEWER_TEST' }, update: {}, create: { key: 'ANALYTICS_VIEWER_TEST', name: 'Analytics viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: analytics.id } }, update: {}, create: { roleId: r.id, permissionId: analytics.id } });
    tokens.push(['ANALYTICS_VIEWER_TEST', (await createUserWithRole(ctx, 'ANALYTICS_VIEWER_TEST')).accessToken]);
    for (const [role, token] of tokens) {
      for (const path of paths) expect({ role, path, status: (await get(path, {}, token)).status }).toEqual({ role, path, status: 403 });
    }
    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'pharmacy:read:any' } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
  });
});
