import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { CatalogAnalyticsView, ICatalogAnalyticsReadPort, ProductStatus } from '../../catalog/application/ports/inbound/catalog-analytics-read.port';
import {
  IPharmacyAnalyticsReadPort,
  LicenseStatus,
  PharmacyAnalyticsView,
  TransactingStatus,
} from '../../pharmacy-inventory/application/ports/inbound/pharmacy-analytics-read.port';
import {
  IPharmacyStockAvailabilityReadPort,
  ListingPurchasabilityView,
} from '../../pharmacy-inventory/application/ports/inbound/pharmacy-stock-availability-read.port';
import { SellableStockCalculator } from '../../pharmacy-inventory/domain/services/sellable-stock.calculator';
import { TransactingEligibilityPolicy } from '../../pharmacy-inventory/domain/services/transacting-eligibility.policy';
import { availableListingWhere, unexpiredSellablePositive } from '../../pharmacy-inventory/infrastructure/persistence/listing-availability.sql';
import { PrismaPharmacyStockAvailabilityReadAdapter } from '../../pharmacy-inventory/infrastructure/persistence/prisma-pharmacy-stock-availability-read.adapter';
import { AdminOperationsController } from '../interface/controllers/admin-operations.controller';
import { toInventoryOperationsOverviewResponse } from '../interface/dtos/inventory-operations.response';
import { GetInventoryOperationsOverviewQuery } from './queries/get-inventory-operations-overview.query';

const listings = { total: 12, enabled: 10, disabled: 2, inStock: 7, outOfStock: 3 };
const providers = (): PharmacyAnalyticsView => ({
  pharmacies: {
    total: 0,
    eligible: 0,
    byTransactingStatus: Object.values(TransactingStatus).map((status) => ({ status, count: 0 })),
    byLicenseStatus: Object.values(LicenseStatus).map((status) => ({ status, count: 0 })),
  },
  branches: { total: 0, active: 0, inactive: 0 },
  listings: { ...listings },
});
const catalog = (): CatalogAnalyticsView => ({ products: { total: 0, byStatus: Object.values(ProductStatus).map((status) => ({ status, count: 0 })) } });

/** The SQL text of a fragment, whitespace-collapsed, with its bound values. */
const sqlOf = (s: Prisma.Sql) => ({ text: s.text.replace(/\s+/g, ' ').trim(), values: s.values });

describe('Admin customer-purchasable inventory (application)', () => {
  const overview = async (purchasability: ListingPurchasabilityView, p: PharmacyAnalyticsView = providers()) => {
    const pp: IPharmacyAnalyticsReadPort = { summarizeProviders: async () => p };
    const a: IPharmacyStockAvailabilityReadPort = {
      summarizeStockAvailability: async () => ({ eligible: 0, withAvailableStock: 0, withoutAvailableStock: 0 }),
      summarizeListingPurchasability: async () => purchasability,
    };
    const c: ICatalogAnalyticsReadPort = { summarizeCatalog: async () => catalog() };
    return toInventoryOperationsOverviewResponse(await new GetInventoryOperationsOverviewQuery(pp, a, c).execute());
  };

  describe('the view', () => {
    it('empty inventory: both new counts are zero', async () => {
      const empty = providers();
      empty.listings = { total: 0, enabled: 0, disabled: 0, inStock: 0, outOfStock: 0 };
      const o = await overview({ tracked: 0, purchasable: 0, unpurchasable: 0 }, empty);
      expect(o.inventory).toMatchObject({ totalTrackedItems: 0, customerPurchasableListings: 0, customerUnpurchasableListings: 0 });
    });

    it('all purchasable / all unpurchasable / mixed are reported as Module 04 counts them, summing to totalTrackedItems', async () => {
      for (const [purchasable, unpurchasable] of [[12, 0], [0, 12], [5, 7]]) {
        const o = await overview({ tracked: 12, purchasable, unpurchasable });
        expect(o.inventory).toMatchObject({ customerPurchasableListings: purchasable, customerUnpurchasableListings: unpurchasable });
        expect(o.inventory.customerPurchasableListings + o.inventory.customerUnpurchasableListings).toBe(o.inventory.totalTrackedItems);
      }
    });

    it('existing inventory metrics keep their Work 08 / Work 25 definitions, whatever purchasability says', async () => {
      const o = await overview({ tracked: 12, purchasable: 1, unpurchasable: 11 });
      expect(o.inventory).toEqual({
        totalTrackedItems: 12,
        enabledItems: 10,
        disabledItems: 2,
        inStockItems: 7,
        outOfStockItems: 3,
        customerPurchasableListings: 1,
        customerUnpurchasableListings: 11,
      });
    });

    it('aggregate-only shape: the two new fields sit under inventory, nothing per listing', async () => {
      const o = await overview({ tracked: 12, purchasable: 4, unpurchasable: 8 });
      expect(Object.keys(o.inventory)).toEqual(['totalTrackedItems', 'enabledItems', 'disabledItems', 'inStockItems', 'outOfStockItems', 'customerPurchasableListings', 'customerUnpurchasableListings']);
      expect(Object.keys(o)).toEqual(['generatedAt', 'pharmacies', 'inventory', 'products']);
      expect(JSON.stringify(o)).not.toMatch(/"id"|listingId|productId|pharmacyId|branchId|phone|email|address|license|supplier|batch/i);
    });
  });

  describe('Module 04 adapter: one snapshot, tracked − purchasable', () => {
    function adapterWith(tracked: number, purchasable: number) {
      const calls: { options?: unknown; queries: Prisma.Sql[] } = { queries: [] };
      const prisma = {
        inventoryListing: { count: (args: unknown) => ({ kind: 'count', args }) },
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
          calls.queries.push(Prisma.sql(strings, ...values));
          return { kind: 'raw' };
        },
        $transaction: async (ops: unknown[], options: unknown) => {
          calls.options = options;
          expect(ops).toEqual([{ kind: 'count', args: { where: { deletedAt: null } } }, { kind: 'raw' }]);
          return [tracked, [{ count: BigInt(purchasable) }]];
        },
      } as unknown as PrismaService;
      return { adapter: new PrismaPharmacyStockAvailabilityReadAdapter(prisma), calls };
    }

    it('returns purchasable and unpurchasable = tracked − purchasable, from one REPEATABLE READ transaction', async () => {
      for (const [tracked, purchasable] of [[0, 0], [9, 9], [9, 0], [9, 4]]) {
        const { adapter, calls } = adapterWith(tracked, purchasable);
        const v = await adapter.summarizeListingPurchasability(new Date('2026-10-09T10:00:00Z'));
        expect(v).toEqual({ tracked, purchasable, unpurchasable: tracked - purchasable });
        expect(v.purchasable + v.unpurchasable).toBe(v.tracked);
        expect(calls.options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      }
    });

    it('the tracked population is exactly Work 08’s listings.total (deletedAt IS NULL) — soft-deleted listings in neither count', async () => {
      const { adapter, calls } = adapterWith(3, 1);
      await adapter.summarizeListingPurchasability();
      // The count's where is asserted in $transaction above; the purchasable query requires deletedAt IS NULL too.
      expect(sqlOf(calls.queries[0]).text).toContain('il."deletedAt" IS NULL');
      const work08 = readFileSync(join(__dirname, '..', '..', 'pharmacy-inventory', 'infrastructure', 'persistence', 'prisma-pharmacy-analytics-read.adapter.ts'), 'utf8');
      expect(work08).toContain('this.prisma.inventoryListing.count({ where: live })');
      expect(work08).toContain('const live = { deletedAt: null };');
    });
  });

  describe('the rule is Module 04’s existing one — discovery AND reservation stock', () => {
    const now = new Date('2026-10-09T10:00:00Z');
    const discovery = sqlOf(availableListingWhere(now));
    const stock = sqlOf(unexpiredSellablePositive(now));

    it('discovery: enabled, live listing with stored sellable > 0, on an active branch (disabled and inactive excluded)', () => {
      for (const c of ['il."isEnabled" = true', 'il."deletedAt" IS NULL', 'il."sellable" > 0', 'b."isActive" = true']) expect(discovery.text).toContain(c);
    });

    it('eligibility: live pharmacy, ACTIVE, licence VALID, unexpired — TransactingEligibilityPolicy, licence expiring at now excluded', () => {
      for (const c of ['p."deletedAt" IS NULL', `p."transactingStatus" = 'ACTIVE'`, `p."licenseStatus" = 'VALID'`, '(p."licenseExpiresAt" IS NULL OR p."licenseExpiresAt" > $1)']) {
        expect(discovery.text).toContain(c);
      }
      expect(discovery.values).toEqual([now]);
      expect(TransactingEligibilityPolicy.isEligible({ transactingStatus: TransactingStatus.ACTIVE, licenseStatus: LicenseStatus.VALID, licenseExpiresAt: now }, now)).toBe(false);
    });

    it('stock: BRULE-15 at now — unexpired batches (expiryDate > now) minus reserved, above zero; expired stock and reservations count as the calculator counts them', () => {
      expect(stock.text).toBe('(SELECT COALESCE(SUM(sb."quantity"), 0) FROM "stock_batches" sb WHERE sb."listingId" = il."id" AND sb."expiryDate" > $1) - il."reserved" > 0');
      expect(stock.values).toEqual([now]);
      // The calculator agrees on each boundary the SQL encodes.
      expect(SellableStockCalculator.computeSellable([{ quantity: 5, expiryDate: now }], 0, now)).toBe(0); // expiring at now: expired
      expect(SellableStockCalculator.computeSellable([{ quantity: 5, expiryDate: new Date(+now + 1) }], 0, now)).toBe(5);
      expect(SellableStockCalculator.computeSellable([{ quantity: 5, expiryDate: new Date(+now + 1) }], 5, now)).toBe(0); // fully reserved
      expect(SellableStockCalculator.computeSellable([], 0, now)).toBe(0); // no batches: nothing to sell
    });

    it('findAvailability itself uses the same discovery fragment — one definition, not a copy', () => {
      const repo = readFileSync(join(__dirname, '..', '..', 'pharmacy-inventory', 'infrastructure', 'persistence', 'prisma-listing.repository.ts'), 'utf8');
      expect(repo).toContain('${AVAILABLE_LISTING_FROM}');
      expect(repo).toContain('AND ${availableListingWhere(now)}');
      expect(repo).not.toMatch(/il\."sellable" > 0|b\."isActive" = true/);
    });
  });

  describe('authorization', () => {
    it('unchanged: GET only, analytics:read; ADMIN and SUPER_ADMIN allowed, every other role 403', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOperationsController)).toEqual(['analytics:read']);
      expect(Object.getOwnPropertyNames(AdminOperationsController.prototype).filter((m) => m !== 'constructor')).toEqual(['getInventoryOverview']);
      expect(Reflect.getMetadata('method', AdminOperationsController.prototype.getInventoryOverview)).toBe(0);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, read: hasPermission(grants, 'analytics:read') }).toEqual({ role, read: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
    });
  });
});
