import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
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
  PharmacyStockAvailabilityView,
} from '../../pharmacy-inventory/application/ports/inbound/pharmacy-stock-availability-read.port';
import { AdminOperationsController } from '../interface/controllers/admin-operations.controller';
import { toInventoryOperationsOverviewResponse } from '../interface/dtos/inventory-operations.response';
import { GetInventoryOperationsOverviewQuery } from './queries/get-inventory-operations-overview.query';

const zeroProviders = (): PharmacyAnalyticsView => ({
  pharmacies: {
    total: 0,
    eligible: 0,
    byTransactingStatus: Object.values(TransactingStatus).map((status) => ({ status, count: 0 })),
    byLicenseStatus: Object.values(LicenseStatus).map((status) => ({ status, count: 0 })),
  },
  branches: { total: 0, active: 0, inactive: 0 },
  listings: { total: 0, enabled: 0, disabled: 0, inStock: 0, outOfStock: 0 },
});
const zeroCatalog = (): CatalogAnalyticsView => ({ products: { total: 0, byStatus: Object.values(ProductStatus).map((status) => ({ status, count: 0 })) } });

describe('Admin inventory operations overview (application)', () => {
  let providers: PharmacyAnalyticsView;
  let availability: PharmacyStockAvailabilityView;
  let catalog: CatalogAnalyticsView;
  let nows: Array<Date | undefined>;
  const overview = async () => {
    nows = [];
    const p: IPharmacyAnalyticsReadPort = { summarizeProviders: async (now) => (nows.push(now), providers) };
    const a: IPharmacyStockAvailabilityReadPort = { summarizeStockAvailability: async (now) => (nows.push(now), availability) };
    const c: ICatalogAnalyticsReadPort = { summarizeCatalog: async () => catalog };
    return toInventoryOperationsOverviewResponse(await new GetInventoryOperationsOverviewQuery(p, a, c).execute());
  };

  beforeEach(() => {
    providers = zeroProviders();
    availability = { eligible: 0, withAvailableStock: 0, withoutAvailableStock: 0 };
    catalog = zeroCatalog();
  });

  it('an empty dataset: zero everywhere, every Module 04 / Module 03 status present', async () => {
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
      inventory: { totalTrackedItems: 0, enabledItems: 0, disabledItems: 0, inStockItems: 0, outOfStockItems: 0 },
      products: {
        total: 0,
        byStatus: ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'DEPRECATED', 'DELISTED'].map((status) => ({ status, count: 0 })),
      },
    });
    // Both clock-dependent reads (licence expiry) are given the response's own stamp.
    expect(nows.map((d) => d!.toISOString())).toEqual([o.generatedAt, o.generatedAt]);
  });

  it('pharmacy counts: Module 04 TransactingStatus exactly, plus eligibility and availability from one snapshot', async () => {
    providers.pharmacies.total = 9;
    providers.pharmacies.byTransactingStatus = [
      { status: TransactingStatus.ACTIVE, count: 5 },
      { status: TransactingStatus.SUSPENDED, count: 3 },
      { status: TransactingStatus.PENDING, count: 1 },
    ];
    providers.pharmacies.eligible = 999; // Work 08's own read — not the figure this view reports
    availability = { eligible: 4, withAvailableStock: 3, withoutAvailableStock: 1 };
    const o = await overview();
    expect(o.pharmacies).toEqual({
      total: 9,
      byTransactingStatus: [{ status: 'ACTIVE', count: 5 }, { status: 'SUSPENDED', count: 3 }, { status: 'PENDING', count: 1 }],
      eligible: 4,
      eligibleWithAvailableStock: 3,
      eligibleWithoutAvailableStock: 1,
    });
    expect(o.pharmacies.eligibleWithAvailableStock + o.pharmacies.eligibleWithoutAvailableStock).toBe(o.pharmacies.eligible);
    expect(Object.values(TransactingStatus)).toEqual(['ACTIVE', 'SUSPENDED', 'PENDING']);
  });

  it('inventory counts follow Module 04’s listing semantics: enabled split by sellable > 0; disabled is neither', async () => {
    providers.listings = { total: 12, enabled: 10, disabled: 2, inStock: 7, outOfStock: 3 };
    const o = await overview();
    expect(o.inventory).toEqual({ totalTrackedItems: 12, enabledItems: 10, disabledItems: 2, inStockItems: 7, outOfStockItems: 3 });
    expect(o.inventory.enabledItems + o.inventory.disabledItems).toBe(o.inventory.totalTrackedItems);
    expect(o.inventory.inStockItems + o.inventory.outOfStockItems).toBe(o.inventory.enabledItems);
  });

  it('product counts are Module 03’s ProductStatus exactly — no invented active/inactive split', async () => {
    catalog = { products: { total: 11, byStatus: [
      { status: ProductStatus.DRAFT, count: 1 },
      { status: ProductStatus.PENDING_REVIEW, count: 2 },
      { status: ProductStatus.ACTIVE, count: 5 },
      { status: ProductStatus.DEPRECATED, count: 1 },
      { status: ProductStatus.DELISTED, count: 2 },
    ] } };
    const o = await overview();
    expect(o.products).toEqual({
      total: 11,
      byStatus: [
        { status: 'DRAFT', count: 1 },
        { status: 'PENDING_REVIEW', count: 2 },
        { status: 'ACTIVE', count: 5 },
        { status: 'DEPRECATED', count: 1 },
        { status: 'DELISTED', count: 2 },
      ],
    });
    expect(Object.values(ProductStatus)).toEqual(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'DEPRECATED', 'DELISTED']);
    expect(o.products).not.toHaveProperty('active');
    expect(o.products).not.toHaveProperty('inactive');
  });

  it('no low-stock figure: the inventory schema carries no threshold, so none is reported or invented', async () => {
    const o = await overview();
    expect(JSON.stringify(o)).not.toMatch(/low/i);
    const schema = readFileSync(join(__dirname, '..', '..', '..', '..', 'prisma', 'schema', '04-pharmacy.prisma'), 'utf8');
    const listing = schema.slice(schema.indexOf('model InventoryListing'), schema.indexOf('}', schema.indexOf('model InventoryListing')));
    expect(listing).not.toMatch(/reorder|threshold|minStock|minimum|lowStock|parLevel/i);
  });

  it('the response carries exactly the approved aggregate fields', async () => {
    const o = await overview();
    expect(Object.keys(o)).toEqual(['generatedAt', 'pharmacies', 'inventory', 'products']);
    expect(Object.keys(o.pharmacies)).toEqual(['total', 'byTransactingStatus', 'eligible', 'eligibleWithAvailableStock', 'eligibleWithoutAvailableStock']);
    expect(Object.keys(o.inventory)).toEqual(['totalTrackedItems', 'enabledItems', 'disabledItems', 'inStockItems', 'outOfStockItems']);
    expect(Object.keys(o.products)).toEqual(['total', 'byStatus']);
    // Work 08's other sections (licence breakdown, branches) are not repeated here.
    expect(JSON.stringify(o)).not.toMatch(/license|branch|"id"|name|phone|email|address|price|onHand|reserved/i);
  });

  describe('authorization', () => {
    it('GET inventory/overview under admin/operations; analytics:read at the class level; GET only', () => {
      expect(Reflect.getMetadata('path', AdminOperationsController)).toBe('admin/operations');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOperationsController)).toEqual(['analytics:read']);
      const methods = Object.getOwnPropertyNames(AdminOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['getInventoryOverview']);
      const handler = AdminOperationsController.prototype.getInventoryOverview;
      expect(Reflect.getMetadata('path', handler)).toBe('inventory/overview');
      expect(Reflect.getMetadata('method', handler)).toBe(0); // RequestMethod.GET
    });

    it('ADMIN allowed; SUPER_ADMIN by wildcard; every other role denied (403); no new permission', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, read: hasPermission(grants, 'analytics:read') }).toEqual({ role, read: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      // No new key: analytics:read is still the only analytics key, and none exists for "operations".
      expect(PERMISSIONS.filter((p) => p.resource === 'analytics').map((p) => p.key)).toEqual(['analytics:read']);
      expect(PERMISSIONS.filter((p) => p.resource === 'operations' || p.key.startsWith('operations:'))).toEqual([]);
    });
  });
});
