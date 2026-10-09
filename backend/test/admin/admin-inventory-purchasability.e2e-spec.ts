import { randomUUID } from 'crypto';
import request from 'supertest';
import { GetAvailabilityQuery } from '../../src/modules/pharmacy-inventory/application/queries/get-availability.query';
import { SellableStockCalculator } from '../../src/modules/pharmacy-inventory/domain/services/sellable-stock.calculator';
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
 * Module 16 Work 26 against real PostgreSQL: tracked listings split by whether a customer can buy
 * from them now — Module 04's discovery rule (`findAvailability`) and its reservation stock rule
 * (BRULE-15 at now). Listings and stock batches are seeded directly, one per edge of the rule.
 */
describe('Admin customer-purchasable inventory (e2e)', () => {
  let ctx: TestContext;
  let admin: User;

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

  const DAY = 86_400_000;
  const future = () => new Date(Date.now() + 30 * DAY);
  const past = () => new Date(Date.now() - DAY);

  async function pharmacy(data: Record<string, unknown>) {
    const p = await ctx.prisma.pharmacy.create({ data: { organizationId: randomUUID(), displayName: `Pharmacy ${randomUUID().slice(0, 8)}`, ...data } });
    const active = await ctx.prisma.branch.create({ data: { pharmacyId: p.id, name: 'Main', isActive: true, phone: '+251911000111', addressLine: 'Bole Road 7' } });
    const inactive = await ctx.prisma.branch.create({ data: { pharmacyId: p.id, name: 'Closed', isActive: false } });
    return { id: p.id, active: active.id, inactive: inactive.id };
  }
  /** A listing with its stored figures and its batches, as Module 04 would hold them. */
  async function listing(
    ph: { id: string },
    branchId: string,
    o: { sellable: number; reserved?: number; batches?: Array<[number, Date]>; isEnabled?: boolean; deletedAt?: Date },
  ) {
    const batches = o.batches ?? [];
    const l = await ctx.prisma.inventoryListing.create({
      data: {
        pharmacyId: ph.id,
        branchId,
        catalogProductId: randomUUID(),
        price: 1_999,
        onHand: batches.reduce((n, [q]) => n + q, 0),
        reserved: o.reserved ?? 0,
        sellable: o.sellable,
        isEnabled: o.isEnabled ?? true,
        deletedAt: o.deletedAt ?? null,
      },
    });
    for (const [quantity, expiryDate] of batches) {
      await ctx.prisma.stockBatch.create({ data: { listingId: l.id, batchNumber: `B-${randomUUID().slice(0, 6)}`, quantity, expiryDate, supplier: 'Secret Supplier PLC' } });
    }
    return l.id;
  }

  async function seed() {
    const nextYear = new Date(Date.now() + 365 * DAY);
    const e = await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: nextYear });
    const ids = {
      // Purchasable.
      plain: await listing(e, e.active, { sellable: 5, batches: [[5, future()]] }),
      partlyReserved: await listing(e, e.active, { sellable: 3, reserved: 7, batches: [[10, future()]] }),
      oneBatchExpired: await listing(e, e.active, { sellable: 5, batches: [[3, past()], [2, future()]] }),
      // Not purchasable.
      disabled: await listing(e, e.active, { sellable: 5, batches: [[5, future()]], isEnabled: false }),
      noStock: await listing(e, e.active, { sellable: 0 }),
      fullyReserved: await listing(e, e.active, { sellable: 0, reserved: 5, batches: [[5, future()]] }),
      // Stored sellable is stale: the only batch expired after the last stock write. Offered by
      // discovery, refused by a reservation — not purchasable.
      expiredSinceLastWrite: await listing(e, e.active, { sellable: 4, batches: [[4, past()]] }),
      inactiveBranch: await listing(e, e.inactive, { sellable: 5, batches: [[5, future()]] }),
    };
    // Soft-deleted listing: in neither count, nor in totalTrackedItems.
    await listing(e, e.active, { sellable: 5, batches: [[5, future()]], deletedAt: new Date() });
    // Ineligible pharmacies, each with a stocked listing on an active branch.
    const suspended = await pharmacy({ transactingStatus: 'SUSPENDED', licenseStatus: 'VALID' });
    const lapsed = await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: past() });
    const expiredLicence = await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'EXPIRED' });
    const pending = await pharmacy({});
    const deletedPharmacy = await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID', deletedAt: new Date() });
    for (const ph of [suspended, lapsed, expiredLicence, pending, deletedPharmacy]) await listing(ph, ph.active, { sellable: 5, batches: [[5, future()]] });
    return ids;
  }

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  it('an empty inventory: both counts zero', async () => {
    expect(await inventory()).toEqual({ totalTrackedItems: 0, enabledItems: 0, disabledItems: 0, inStockItems: 0, outOfStockItems: 0, customerPurchasableListings: 0, customerUnpurchasableListings: 0 });
  });

  it('expected metrics from seeded data; the two counts add up to totalTrackedItems and to the live listing rows', async () => {
    await seed();
    const inv = await inventory();
    // 8 on the eligible pharmacy + 5 on ineligible ones; the soft-deleted listing is not tracked.
    expect(inv).toEqual({
      totalTrackedItems: 13,
      enabledItems: 12,
      disabledItems: 1,
      inStockItems: 10, // stored sellable > 0 on an enabled listing — Work 08's figure, unchanged
      outOfStockItems: 2,
      customerPurchasableListings: 3, // plain, partlyReserved, oneBatchExpired
      customerUnpurchasableListings: 10,
    });
    expect(inv.customerPurchasableListings + inv.customerUnpurchasableListings).toBe(inv.totalTrackedItems);
    expect(await ctx.prisma.inventoryListing.count({ where: { deletedAt: null } })).toBe(inv.totalTrackedItems);
  });

  it('the count is Module 04’s own rule: listings GetAvailabilityQuery offers whose BRULE-15 stock at now is positive', async () => {
    const ids = await seed();
    const now = new Date();
    const live = await ctx.prisma.inventoryListing.findMany({ where: { deletedAt: null }, include: { batches: true } });
    const availability = ctx.app.get(GetAvailabilityQuery);
    const purchasable: string[] = [];
    for (const l of live) {
      const offered = (await availability.execute(l.catalogProductId, {})).some((a) => a.listingId === l.id);
      const stock = SellableStockCalculator.computeSellable(l.batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate })), l.reserved, now);
      if (offered && stock > 0) purchasable.push(l.id);
    }
    expect(purchasable.sort()).toEqual([ids.plain, ids.partlyReserved, ids.oneBatchExpired].sort());
    expect((await inventory()).customerPurchasableListings).toBe(purchasable.length);
    // Discovery alone would also offer the stale listing — the gap the reservation rule closes.
    const stale = live.find((l) => l.id === ids.expiredSinceLastWrite)!;
    expect((await availability.execute(stale.catalogProductId, {})).map((a) => a.listingId)).toEqual([ids.expiredSinceLastWrite]);
  });

  it('existing fields and shared figures are unchanged: they still equal Work 08’s analytics overview', async () => {
    await seed();
    const inv = await inventory();
    const a = body(await request(ctx.server).get('/admin/analytics/overview').set(...auth(admin.accessToken)).expect(200)) as unknown as { providers: { listings: Record<string, number> } };
    expect({ total: inv.totalTrackedItems, enabled: inv.enabledItems, disabled: inv.disabledItems, inStock: inv.inStockItems, outOfStock: inv.outOfStockItems }).toEqual(a.providers.listings);
  });

  it('read-only: listings, batches, reservations, movements and the audit log unchanged; other methods 404', async () => {
    await seed();
    const state = async () => ({
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      batches: await ctx.prisma.stockBatch.findMany({ orderBy: { id: 'asc' } }),
      reservations: await ctx.prisma.stockReservation.count(),
      movements: await ctx.prisma.stockMovement.count(),
      audit: await ctx.prisma.auditLog.count(),
    });
    const before = await state();
    for (let i = 0; i < 3; i++) await inventory();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect({ method, status: (await request(ctx.server)[method](OVERVIEW).set(...auth(admin.accessToken)).send({})).status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('aggregates only: no listing, product, pharmacy, branch, batch, supplier, phone or address in the response', async () => {
    await seed();
    const raw = JSON.stringify((await get().expect(200)).body).toLowerCase();
    const listings = await ctx.prisma.inventoryListing.findMany();
    const batches = await ctx.prisma.stockBatch.findMany();
    const pharmacies = await ctx.prisma.pharmacy.findMany();
    const branches = await ctx.prisma.branch.findMany();
    for (const secret of [
      ...listings.flatMap((l) => [l.id, l.catalogProductId]),
      ...batches.flatMap((b) => [b.id, b.batchNumber]),
      ...pharmacies.flatMap((p) => [p.id, p.displayName]),
      ...branches.flatMap((b) => [b.id, b.phone, b.addressLine]).filter((v): v is string => !!v),
      'Secret Supplier', '1999', admin.userId, admin.phone,
    ]) {
      expect({ secret: secret.slice(0, 16), found: raw.includes(secret.toLowerCase()) }).toEqual({ secret: secret.slice(0, 16), found: false });
    }
  });

  it('permission unchanged: 401 anonymous, 403 without analytics:read, ADMIN and SUPER_ADMIN allowed', async () => {
    expect((await get(null)).status).toBe(401);
    for (const role of ['CUSTOMER', 'PHARMACY_OWNER', 'FINANCE_OFFICER']) {
      expect({ role, status: (await get((await createUserWithRole(ctx, role)).accessToken)).status }).toEqual({ role, status: 403 });
    }
    await get().expect(200);
    await get((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
  });
});
