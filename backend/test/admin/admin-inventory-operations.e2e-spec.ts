import { randomUUID } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const OVERVIEW = '/admin/operations/inventory/overview';
type User = RegisteredUser & Tokens;
type Bucket = { status: string; count: number };
type Overview = {
  generatedAt: string;
  pharmacies: { total: number; byTransactingStatus: Bucket[]; eligible: number; eligibleWithAvailableStock: number; eligibleWithoutAvailableStock: number };
  inventory: { totalTrackedItems: number; enabledItems: number; disabledItems: number; inStockItems: number; outOfStockItems: number; customerPurchasableListings: number; customerUnpurchasableListings: number };
  products: { total: number; byStatus: Bucket[] };
};

/**
 * Module 16 Work 25 against real PostgreSQL: the inventory operations snapshot, over Module 04's and
 * Module 03's read ports. Rows are seeded directly, one per edge of each definition.
 */
describe('Admin inventory operations overview (e2e)', () => {
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
  const overview = async () => body(await get().expect(200)) as unknown as Overview;

  async function pharmacy(data: Record<string, unknown>, branch: { isActive?: boolean } | null = { isActive: true }) {
    const p = await ctx.prisma.pharmacy.create({ data: { organizationId: randomUUID(), displayName: `Pharmacy ${randomUUID().slice(0, 8)}`, ...data } });
    const b = branch
      ? await ctx.prisma.branch.create({ data: { pharmacyId: p.id, name: 'Main', addressLine: 'Bole Road 12', phone: '+251911223344', city: 'Addis Ababa', ...branch } })
      : null;
    return { id: p.id, branchId: b?.id ?? null };
  }
  const listing = (pharmacyId: string, branchId: string, data: Record<string, unknown> = {}) =>
    ctx.prisma.inventoryListing.create({ data: { pharmacyId, branchId, catalogProductId: randomUUID(), price: 4_250, ...data } });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  async function seed() {
    const yesterday = new Date(Date.now() - 86_400_000);
    const nextYear = new Date(Date.now() + 365 * 86_400_000);
    // P1 eligible, active branch: in stock, out of stock, disabled (in stock but disabled).
    const p1 = await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: nextYear });
    await listing(p1.id, p1.branchId!, { sellable: 5, onHand: 5 });
    await listing(p1.id, p1.branchId!, { sellable: 0, onHand: 0 });
    await listing(p1.id, p1.branchId!, { sellable: 9, onHand: 9, isEnabled: false });
    // P2 eligible, but its only in-stock listing is on an inactive branch → nothing a customer can buy.
    const p2 = await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID' }, { isActive: false });
    await listing(p2.id, p2.branchId!, { sellable: 7, onHand: 7 });
    // P3 eligible, active branch, only a soft-deleted listing → nothing to buy.
    const p3 = await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID' });
    await listing(p3.id, p3.branchId!, { sellable: 9, onHand: 9, deletedAt: new Date() });
    // P4 ACTIVE but licence lapsed yesterday → not eligible, though stocked.
    const p4 = await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: yesterday });
    await listing(p4.id, p4.branchId!, { sellable: 3, onHand: 3 });
    // P5 SUSPENDED → not eligible, though stocked.
    const p5 = await pharmacy({ transactingStatus: 'SUSPENDED', licenseStatus: 'EXPIRED' });
    await listing(p5.id, p5.branchId!, { sellable: 2, onHand: 2 });
    // P6 PENDING (the model's default), no branch.
    await pharmacy({}, null);
    // P7 soft-deleted, would otherwise be eligible → counted nowhere.
    await pharmacy({ transactingStatus: 'ACTIVE', licenseStatus: 'VALID', deletedAt: new Date() });

    // Products: one of each ProductStatus, a second ACTIVE, and a soft-deleted ACTIVE (not counted).
    await ctx.prisma.product.createMany({
      data: [
        { type: 'MEDICINE', nameEn: 'Amoxiclav Seed', status: 'DRAFT' },
        { type: 'MEDICINE', nameEn: 'Ibuprofen Seed', status: 'PENDING_REVIEW' },
        { type: 'MEDICINE', nameEn: 'Metformin Seed', status: 'ACTIVE' },
        { type: 'MEDICINE', nameEn: 'Omeprazole Seed', status: 'ACTIVE' },
        { type: 'MEDICINE', nameEn: 'Ciprofloxacin Seed', status: 'DEPRECATED' },
        { type: 'MEDICINE', nameEn: 'Ranitidine Seed', status: 'DELISTED' },
        { type: 'MEDICINE', nameEn: 'Atenolol Seed', status: 'ACTIVE', deletedAt: new Date() },
      ],
    });
  }

  it('an empty dataset: zero counts, every status present', async () => {
    const o = await overview();
    expect(o).toEqual({
      generatedAt: expect.any(String),
      pharmacies: {
        total: 0,
        byTransactingStatus: [{ status: 'ACTIVE', count: 0 }, { status: 'SUSPENDED', count: 0 }, { status: 'PENDING', count: 0 }],
        eligible: 0,
        eligibleWithAvailableStock: 0,
        eligibleWithoutAvailableStock: 0,
      },
      // Work 26 added the last two (admin-inventory-purchasability.e2e-spec.ts).
      inventory: { totalTrackedItems: 0, enabledItems: 0, disabledItems: 0, inStockItems: 0, outOfStockItems: 0, customerPurchasableListings: 0, customerUnpurchasableListings: 0 },
      products: { total: 0, byStatus: ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'DEPRECATED', 'DELISTED'].map((status) => ({ status, count: 0 })) },
    });
  });

  it('pharmacy counts: live pharmacies by TransactingStatus; eligibility; availability by the findAvailability predicate', async () => {
    await seed();
    const o = await overview();
    expect(o.pharmacies).toEqual({
      total: 6,
      byTransactingStatus: [{ status: 'ACTIVE', count: 4 }, { status: 'SUSPENDED', count: 1 }, { status: 'PENDING', count: 1 }],
      eligible: 3,
      eligibleWithAvailableStock: 1,
      eligibleWithoutAvailableStock: 2,
    });
  });

  it('inventory counts: live listings; enabled split by sellable > 0; disabled is neither', async () => {
    await seed();
    const o = await overview();
    // Work 26 added the last two (admin-inventory-purchasability.e2e-spec.ts). These listings carry a stored
    // `sellable` but no stock batch, so BRULE-15 stock at now is 0 and none is purchasable.
    expect(o.inventory).toEqual({ totalTrackedItems: 6, enabledItems: 5, disabledItems: 1, inStockItems: 4, outOfStockItems: 1, customerPurchasableListings: 0, customerUnpurchasableListings: 6 });
    expect(await ctx.prisma.inventoryListing.count({ where: { deletedAt: null } })).toBe(6);
  });

  it('product counts: live products by every ProductStatus value', async () => {
    await seed();
    expect((await overview()).products).toEqual({
      total: 6,
      byStatus: [
        { status: 'DRAFT', count: 1 },
        { status: 'PENDING_REVIEW', count: 1 },
        { status: 'ACTIVE', count: 2 },
        { status: 'DEPRECATED', count: 1 },
        { status: 'DELISTED', count: 1 },
      ],
    });
  });

  it('agrees with Work 08’s /admin/analytics/overview wherever they report the same figure', async () => {
    await seed();
    const o = await overview();
    const a = body(await request(ctx.server).get('/admin/analytics/overview').set(...auth(admin.accessToken)).expect(200)) as unknown as {
      catalog: { products: { total: number; byStatus: Bucket[] } };
      providers: { pharmacies: { total: number; eligible: number; byTransactingStatus: Bucket[] }; listings: Record<string, number> };
    };
    expect(o.products).toEqual(a.catalog.products);
    expect(o.pharmacies.total).toBe(a.providers.pharmacies.total);
    expect(o.pharmacies.byTransactingStatus).toEqual(a.providers.pharmacies.byTransactingStatus);
    expect(o.pharmacies.eligible).toBe(a.providers.pharmacies.eligible);
    // Work 26's two fields have no Work 08 counterpart; every shared field still matches exactly.
    const { customerPurchasableListings, customerUnpurchasableListings, ...shared } = o.inventory;
    expect(customerPurchasableListings + customerUnpurchasableListings).toBe(a.providers.listings.total);
    expect(shared).toEqual({
      totalTrackedItems: a.providers.listings.total,
      enabledItems: a.providers.listings.enabled,
      disabledItems: a.providers.listings.disabled,
      inStockItems: a.providers.listings.inStock,
      outOfStockItems: a.providers.listings.outOfStock,
    });
  });

  it('read-only: pharmacies, branches, listings, products and the audit log are unchanged; other methods are 404', async () => {
    await seed();
    const state = async () => ({
      pharmacies: await ctx.prisma.pharmacy.findMany({ orderBy: { id: 'asc' } }),
      branches: await ctx.prisma.branch.findMany({ orderBy: { id: 'asc' } }),
      listings: await ctx.prisma.inventoryListing.findMany({ orderBy: { id: 'asc' } }),
      products: await ctx.prisma.product.findMany({ orderBy: { id: 'asc' } }),
      movements: await ctx.prisma.stockMovement.count(),
      audit: await ctx.prisma.auditLog.count(),
    });
    const before = await state();
    for (let i = 0; i < 3; i++) await overview();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(ctx.server)[method](OVERVIEW).set(...auth(admin.accessToken)).send({});
      expect({ method, status: res.status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('aggregates only: no pharmacy, branch, listing, product, person, address, phone or price in the response', async () => {
    await seed();
    const raw = JSON.stringify((await get().expect(200)).body);
    const pharmacies = await ctx.prisma.pharmacy.findMany();
    const branches = await ctx.prisma.branch.findMany();
    const listings = await ctx.prisma.inventoryListing.findMany();
    const products = await ctx.prisma.product.findMany();
    for (const secret of [
      ...pharmacies.flatMap((p) => [p.id, p.organizationId, p.displayName]),
      ...branches.flatMap((b) => [b.id, b.addressLine!, b.phone!]),
      ...listings.flatMap((l) => [l.id, l.catalogProductId]),
      ...products.flatMap((p) => [p.id, p.nameEn!]),
      admin.userId, admin.phone, '4250', 'ETB', 'license', 'branch',
    ]) {
      expect({ secret: secret.slice(0, 16), found: raw.toLowerCase().includes(secret.toLowerCase()) }).toEqual({ secret: secret.slice(0, 16), found: false });
    }
  });

  it('401 without authentication; 403 without analytics:read (incl. queue:read holders); ADMIN, SUPER_ADMIN and an analytics:read holder allowed', async () => {
    expect((await get(null)).status).toBe(401);
    for (const role of ['CUSTOMER', 'DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      expect({ role, status: (await get((await createUserWithRole(ctx, role)).accessToken)).status }).toEqual({ role, status: 403 });
    }
    const roleWith = async (key: string, permission: string) => {
      const p = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: permission } });
      const r = await ctx.prisma.role.upsert({ where: { key }, update: {}, create: { key, name: key, scope: 'PLATFORM' } });
      await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: p.id } }, update: {}, create: { roleId: r.id, permissionId: p.id } });
      return (await createUserWithRole(ctx, key)).accessToken;
    };
    expect((await get(await roleWith('QUEUE_VIEWER_TEST', 'notification:queue:read'))).status).toBe(403);
    await get(await roleWith('ANALYTICS_VIEWER_TEST', 'analytics:read')).expect(200);
    await get().expect(200);
    await get((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'analytics:read' }, role: { key: { not: 'ANALYTICS_VIEWER_TEST' } } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
  });

  describe('boundaries', () => {
    const root = join(__dirname, '..', '..', 'src', 'modules');
    const rel = (f: string) => f.replace(/\\/g, '/').split('/src/modules/')[1];
    const sources = (dir: string): string[] => {
      const files: string[] = [];
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      };
      walk(dir);
      return files;
    };

    it('the Work 25 query, controller and response reach Modules 03/04 only through their inbound read ports', () => {
      const files = sources(join(root, 'admin')).filter((f) => /inventory-operations|admin-operations/.test(f));
      expect(files.map(rel).sort()).toEqual([
        'admin/application/queries/get-inventory-operations-overview.query.ts',
        'admin/interface/controllers/admin-operations.controller.ts',
        'admin/interface/dtos/inventory-operations.response.ts',
      ]);
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /PrismaService|@prisma\/client|prisma\.|_REPOSITORY|INVENTORY_PORT\b|\/domain\/|\/infrastructure\/|commands\//.test(source) }).toEqual({ file: rel(file), found: false });
        for (const m of source.matchAll(/from '[^']*(catalog|pharmacy-inventory)\/([^']+)'/g)) {
          expect({ file: rel(file), import: m[2] }).toEqual({ file: rel(file), import: expect.stringMatching(/^application\/ports\/inbound\/[a-z-]+-read\.port$/) });
        }
      }
    });
  });
});
