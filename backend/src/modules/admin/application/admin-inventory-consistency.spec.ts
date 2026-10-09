import 'reflect-metadata';
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
import { PrismaPharmacyStockAvailabilityReadAdapter } from '../../pharmacy-inventory/infrastructure/persistence/prisma-pharmacy-stock-availability-read.adapter';
import { AdminOperationsController } from '../interface/controllers/admin-operations.controller';
import { toInventoryOperationsOverviewResponse } from '../interface/dtos/inventory-operations.response';
import { GetInventoryOperationsOverviewQuery } from './queries/get-inventory-operations-overview.query';

const work08 = (listings: PharmacyAnalyticsView['listings']): PharmacyAnalyticsView => ({
  pharmacies: {
    total: 0,
    eligible: 0,
    byTransactingStatus: Object.values(TransactingStatus).map((status) => ({ status, count: 0 })),
    byLicenseStatus: Object.values(LicenseStatus).map((status) => ({ status, count: 0 })),
  },
  branches: { total: 0, active: 0, inactive: 0 },
  listings,
});
const catalog = (): CatalogAnalyticsView => ({ products: { total: 0, byStatus: Object.values(ProductStatus).map((status) => ({ status, count: 0 })) } });

describe('Admin inventory metrics: one snapshot for the total and the purchasability split (application)', () => {
  const overview = async (listings: PharmacyAnalyticsView['listings'], snapshot: ListingPurchasabilityView) => {
    const p: IPharmacyAnalyticsReadPort = { summarizeProviders: async () => work08(listings) };
    const a: IPharmacyStockAvailabilityReadPort = {
      summarizeStockAvailability: async () => ({ eligible: 0, withAvailableStock: 0, withoutAvailableStock: 0 }),
      summarizeListingPurchasability: async () => snapshot,
    };
    const c: ICatalogAnalyticsReadPort = { summarizeCatalog: async () => catalog() };
    return toInventoryOperationsOverviewResponse(await new GetInventoryOperationsOverviewQuery(p, a, c).execute());
  };
  const quiet = (total: number) => ({ total, enabled: total, disabled: 0, inStock: total, outOfStock: 0 });

  it('regression: when Work 08’s total and the snapshot’s differ, totalTrackedItems is the snapshot’s — the split still sums to it', async () => {
    // A listing was created between the two reads: Work 08 saw 99, the snapshot 12.
    const o = await overview({ total: 99, enabled: 90, disabled: 9, inStock: 80, outOfStock: 10 }, { tracked: 12, purchasable: 5, unpurchasable: 7 });
    expect(o.inventory.totalTrackedItems).toBe(12);
    expect(o.inventory.customerPurchasableListings + o.inventory.customerUnpurchasableListings).toBe(o.inventory.totalTrackedItems);
    // Work 08's split is reported exactly as Work 08 reads it — nothing reconciled in application code.
    expect(o.inventory).toEqual({
      totalTrackedItems: 12,
      enabledItems: 90,
      disabledItems: 9,
      inStockItems: 80,
      outOfStockItems: 10,
      customerPurchasableListings: 5,
      customerUnpurchasableListings: 7,
    });
  });

  it('empty, all purchasable, all unpurchasable, mixed: the invariant holds in every case', async () => {
    const cases: Array<[number, number]> = [[0, 0], [8, 8], [8, 0], [8, 3]];
    for (const [tracked, purchasable] of cases) {
      const o = await overview(quiet(tracked), { tracked, purchasable, unpurchasable: tracked - purchasable });
      expect({ tracked, purchasable, inv: o.inventory }).toEqual({
        tracked,
        purchasable,
        inv: expect.objectContaining({ totalTrackedItems: tracked, customerPurchasableListings: purchasable, customerUnpurchasableListings: tracked - purchasable }),
      });
      expect(o.inventory.customerPurchasableListings + o.inventory.customerUnpurchasableListings).toBe(o.inventory.totalTrackedItems);
    }
  });

  it('existing inventory fields keep their names, order and Work 08 values', async () => {
    const o = await overview({ total: 10, enabled: 8, disabled: 2, inStock: 6, outOfStock: 2 }, { tracked: 10, purchasable: 4, unpurchasable: 6 });
    expect(Object.keys(o.inventory)).toEqual(['totalTrackedItems', 'enabledItems', 'disabledItems', 'inStockItems', 'outOfStockItems', 'customerPurchasableListings', 'customerUnpurchasableListings']);
    expect(o.inventory).toMatchObject({ enabledItems: 8, disabledItems: 2, inStockItems: 6, outOfStockItems: 2 });
    expect(Object.keys(o)).toEqual(['generatedAt', 'pharmacies', 'inventory', 'products']);
  });

  describe('Module 04 adapter: the three values come from one REPEATABLE READ transaction', () => {
    it('one $transaction holding both counts, nothing read outside it; unpurchasable derived from that snapshot alone', async () => {
      const log: string[] = [];
      let options: unknown;
      let ops: unknown[] = [];
      const prisma = {
        inventoryListing: { count: (args: unknown) => (log.push('count built'), { op: 'tracked', args }) },
        $queryRaw: () => (log.push('raw built'), { op: 'purchasable' }),
        $transaction: async (batch: unknown[], o: unknown) => {
          log.push('transaction');
          ops = batch;
          options = o;
          return [10, [{ count: BigInt(4) }]];
        },
      } as unknown as PrismaService;
      const v = await new PrismaPharmacyStockAvailabilityReadAdapter(prisma).summarizeListingPurchasability(new Date());
      expect(v).toEqual({ tracked: 10, purchasable: 4, unpurchasable: 6 });
      // Both statements are built, then sent together — one transaction, executed once.
      expect(log).toEqual(['count built', 'raw built', 'transaction']);
      expect(ops).toEqual([{ op: 'tracked', args: { where: { deletedAt: null } } }, { op: 'purchasable' }]);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });
  });

  describe('authorization and shape (unchanged)', () => {
    it('GET only, analytics:read; ADMIN and SUPER_ADMIN allowed, every other role 403; aggregates only', async () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOperationsController)).toEqual(['analytics:read']);
      expect(Object.getOwnPropertyNames(AdminOperationsController.prototype).filter((m) => m !== 'constructor')).toEqual(['getInventoryOverview']);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, read: hasPermission(grants, 'analytics:read') }).toEqual({ role, read: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      const o = await overview(quiet(3), { tracked: 3, purchasable: 1, unpurchasable: 2 });
      expect(JSON.stringify(o)).not.toMatch(/"id"|listingId|productId|pharmacyId|branchId|phone|email|address|license|supplier|batch/i);
    });
  });
});
