import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const OVERVIEW = '/admin/operations/inventory/overview';
type User = RegisteredUser & Tokens;
type Inventory = {
  totalTrackedItems: number;
  enabledItems: number;
  disabledItems: number;
  inStockItems: number;
  outOfStockItems: number;
  customerPurchasableListings: number;
  customerUnpurchasableListings: number;
};

/**
 * Module 16 Work 27 against real PostgreSQL: `totalTrackedItems` and the customer-purchasability
 * split come from one Module 04 snapshot, so they agree even while listings are created and
 * soft-deleted concurrently.
 */
describe('Admin inventory metrics snapshot consistency (e2e)', () => {
  let ctx: TestContext;
  let admin: User;
  let shop: { pharmacyId: string; branchId: string };

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const get = (token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(OVERVIEW);
    return token ? r.set(...auth(token)) : r;
  };
  const inventory = async () => (body(await get().expect(200)) as unknown as { inventory: Inventory }).inventory;

  /** A live listing on the eligible pharmacy; `stocked` gives it an unexpired batch (purchasable). */
  async function addListing(stocked: boolean) {
    const l = await ctx.prisma.inventoryListing.create({
      data: { pharmacyId: shop.pharmacyId, branchId: shop.branchId, catalogProductId: randomUUID(), price: 500, sellable: stocked ? 4 : 0, onHand: stocked ? 4 : 0 },
    });
    if (stocked) await ctx.prisma.stockBatch.create({ data: { listingId: l.id, batchNumber: `B-${randomUUID().slice(0, 6)}`, quantity: 4, expiryDate: new Date(Date.now() + 30 * 86_400_000) } });
    return l.id;
  }

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    const p = await ctx.prisma.pharmacy.create({
      data: { organizationId: randomUUID(), displayName: 'Consistency Pharmacy', transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: new Date(Date.now() + 365 * 86_400_000) },
    });
    const b = await ctx.prisma.branch.create({ data: { pharmacyId: p.id, name: 'Main', isActive: true } });
    shop = { pharmacyId: p.id, branchId: b.id };
  });

  it('empty, all purchasable, all unpurchasable, mixed: the three values agree and match the database', async () => {
    const check = async (expected: Partial<Inventory>) => {
      const inv = await inventory();
      expect(inv).toMatchObject(expected);
      expect(inv.customerPurchasableListings + inv.customerUnpurchasableListings).toBe(inv.totalTrackedItems);
      expect(inv.totalTrackedItems).toBe(await ctx.prisma.inventoryListing.count({ where: { deletedAt: null } }));
    };
    await check({ totalTrackedItems: 0, customerPurchasableListings: 0, customerUnpurchasableListings: 0 });
    for (let i = 0; i < 3; i++) await addListing(true);
    await check({ totalTrackedItems: 3, customerPurchasableListings: 3, customerUnpurchasableListings: 0 });
    await ctx.prisma.inventoryListing.updateMany({ data: { isEnabled: false } });
    await check({ totalTrackedItems: 3, customerPurchasableListings: 0, customerUnpurchasableListings: 3 });
    await ctx.prisma.inventoryListing.updateMany({ data: { isEnabled: true } });
    await addListing(false);
    await addListing(false);
    await check({ totalTrackedItems: 5, customerPurchasableListings: 3, customerUnpurchasableListings: 2 });
  });

  it('the invariant holds on every response while listings are created and soft-deleted concurrently', async () => {
    const live: string[] = [];
    for (let i = 0; i < 10; i++) live.push(await addListing(i % 2 === 0));

    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 60; i++) {
        live.push(await addListing(i % 3 !== 0));
        if (i % 2 === 0) {
          const victim = live.splice(Math.floor(live.length / 2), 1)[0];
          await ctx.prisma.inventoryListing.update({ where: { id: victim }, data: { deletedAt: new Date() } });
        }
      }
      writing = false;
    })();
    const seen: Inventory[] = [];
    const readers = (async () => {
      while (writing) {
        seen.push(...(await Promise.all([inventory(), inventory(), inventory()])));
      }
    })();
    await Promise.all([writer, readers]);

    expect(seen.length).toBeGreaterThan(3);
    // The totals moved while we read — the reads genuinely overlapped the writes …
    expect(new Set(seen.map((s) => s.totalTrackedItems)).size).toBeGreaterThan(1);
    // … and every single response was internally consistent.
    for (const s of seen) {
      expect({ total: s.totalTrackedItems, sum: s.customerPurchasableListings + s.customerUnpurchasableListings }).toEqual({ total: s.totalTrackedItems, sum: s.totalTrackedItems });
    }
  });

  it('at rest, totalTrackedItems still equals Work 08’s listings.total; /admin/analytics/overview is unchanged', async () => {
    for (let i = 0; i < 4; i++) await addListing(i < 2);
    await ctx.prisma.inventoryListing.create({ data: { pharmacyId: shop.pharmacyId, branchId: shop.branchId, catalogProductId: randomUUID(), price: 1, sellable: 3, isEnabled: false } });
    await ctx.prisma.inventoryListing.create({ data: { pharmacyId: shop.pharmacyId, branchId: shop.branchId, catalogProductId: randomUUID(), price: 1, sellable: 3, deletedAt: new Date() } });
    const inv = await inventory();
    const a = body(await request(ctx.server).get('/admin/analytics/overview').set(...auth(admin.accessToken)).expect(200)) as unknown as { providers: { listings: Record<string, number> } };
    expect(a.providers.listings).toEqual({ total: 5, enabled: 4, disabled: 1, inStock: 2, outOfStock: 2 });
    expect({ total: inv.totalTrackedItems, enabled: inv.enabledItems, disabled: inv.disabledItems, inStock: inv.inStockItems, outOfStock: inv.outOfStockItems }).toEqual(a.providers.listings);
    expect(inv).toMatchObject({ customerPurchasableListings: 2, customerUnpurchasableListings: 3 });
  });

  it('read-only, aggregate-only, audit unchanged; RBAC unchanged', async () => {
    for (let i = 0; i < 3; i++) await addListing(i === 0);
    const state = async () => ({
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
    });
    const before = await state();
    const raw = JSON.stringify((await get().expect(200)).body).toLowerCase();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect({ method, status: (await request(ctx.server)[method](OVERVIEW).set(...auth(admin.accessToken)).send({})).status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
    for (const secret of [shop.pharmacyId, shop.branchId, 'consistency pharmacy', ...before.listings.flatMap((l) => [l.id, l.catalogProductId]), ...before.batches.map((b) => b.batchNumber.toLowerCase())]) {
      expect({ secret: secret.slice(0, 16), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 16), found: false });
    }
    expect((await get(null)).status).toBe(401);
    expect((await get((await createUserWithRole(ctx, 'PHARMACY_OWNER')).accessToken)).status).toBe(403);
    await get((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
  });
});
