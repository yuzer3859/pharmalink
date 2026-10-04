import {
  CatalogAnalyticsView,
  ICatalogAnalyticsReadPort,
  ProductStatus,
} from '../../catalog/application/ports/inbound/catalog-analytics-read.port';
import { ICodFinanceReadPort } from '../../delivery/application/ports/inbound/cod-finance-read.port';
import {
  DeliveryAnalyticsView,
  DeliveryJobStatus,
  DriverAvailability,
  IDeliveryAnalyticsReadPort,
} from '../../delivery/application/ports/inbound/delivery-analytics-read.port';
import {
  AccountAnalyticsView,
  AccountStatus,
  IIdentityAnalyticsReadPort,
  PrimaryRole,
} from '../../identity/application/ports/inbound/identity-analytics-read.port';
import {
  FulfillmentStatus,
  IOrderAnalyticsReadPort,
  OrderAnalyticsView,
  OrderStatus,
} from '../../orders/application/ports/inbound/order-analytics-read.port';
import {
  IPharmacyAnalyticsReadPort,
  LicenseStatus,
  PharmacyAnalyticsView,
  TransactingStatus,
} from '../../pharmacy-inventory/application/ports/inbound/pharmacy-analytics-read.port';
import { GetAnalyticsOverviewQuery } from './queries/get-analytics-overview.query';

/**
 * Module 16 Work 08's application layer, with the six owners behind fake ports. The claims here
 * are about composition — every section is its owner's answer, placed and left alone; what the
 * answers are is each owner's claim, made against PostgreSQL in
 * `test/admin/admin-analytics.e2e-spec.ts`.
 */
describe('Admin operational analytics (application)', () => {
  const accounts: AccountAnalyticsView = {
    total: 3,
    byStatus: [{ status: AccountStatus.ACTIVE, count: 3 }],
    byPrimaryRole: [{ primaryRole: PrimaryRole.CUSTOMER, count: 3 }],
  };
  const catalog: CatalogAnalyticsView = {
    products: { total: 2, byStatus: [{ status: ProductStatus.ACTIVE, count: 2 }] },
  };
  const providers: PharmacyAnalyticsView = {
    pharmacies: {
      total: 1,
      eligible: 1,
      byTransactingStatus: [{ status: TransactingStatus.ACTIVE, count: 1 }],
      byLicenseStatus: [{ status: LicenseStatus.VALID, count: 1 }],
    },
    branches: { total: 1, active: 1, inactive: 0 },
    listings: { total: 4, enabled: 3, disabled: 1, inStock: 2, outOfStock: 1 },
  };
  const orders: OrderAnalyticsView = {
    orders: { total: 5, byStatus: [{ status: OrderStatus.PAID, count: 5 }] },
    fulfillments: { total: 5, byStatus: [{ status: FulfillmentStatus.READY, count: 5 }] },
  };
  const delivery: DeliveryAnalyticsView = {
    jobs: { total: 1, byStatus: [{ status: DeliveryJobStatus.CREATED, count: 1 }] },
    drivers: { total: 2, dispatchable: 1, byAvailability: [{ availability: DriverAvailability.ONLINE, count: 1 }] },
  };
  const cod = {
    count: 1,
    expectedAmount: 24_500,
    collectedAmount: 20_000,
    remittedAmount: 0,
    outstandingCount: 1,
    outstandingAmount: 20_000,
    discrepancyCount: 1,
  };

  let identity: jest.Mocked<IIdentityAnalyticsReadPort>;
  let catalogPort: jest.Mocked<ICatalogAnalyticsReadPort>;
  let pharmacy: jest.Mocked<IPharmacyAnalyticsReadPort>;
  let orderPort: jest.Mocked<IOrderAnalyticsReadPort>;
  let deliveryPort: jest.Mocked<IDeliveryAnalyticsReadPort>;
  let codPort: jest.Mocked<ICodFinanceReadPort>;
  let query: GetAnalyticsOverviewQuery;

  beforeEach(() => {
    identity = { summarizeAccounts: jest.fn().mockResolvedValue(accounts) };
    catalogPort = { summarizeCatalog: jest.fn().mockResolvedValue(catalog) };
    pharmacy = { summarizeProviders: jest.fn().mockResolvedValue(providers) };
    orderPort = { summarizeOrders: jest.fn().mockResolvedValue(orders) };
    deliveryPort = { summarizeDelivery: jest.fn().mockResolvedValue(delivery) };
    codPort = { summarizeCollections: jest.fn().mockResolvedValue(cod) };
    query = new GetAnalyticsOverviewQuery(identity, catalogPort, pharmacy, orderPort, deliveryPort, codPort);
  });

  it('places each owner’s answer in its own section, unchanged, and nothing else', async () => {
    const view = await query.execute();
    expect(view.accounts).toBe(accounts);
    expect(view.catalog).toBe(catalog);
    expect(view.providers).toBe(providers);
    expect(view.orders).toBe(orders);
    expect(view.delivery).toBe(delivery);
    expect(view.cod).toBe(cod);
    expect(view.generatedAt).toBeInstanceOf(Date);
    // Six sections and the stamp. No total across sections, no rate, no GMV.
    expect(Object.keys(view).sort()).toEqual(['accounts', 'catalog', 'cod', 'delivery', 'generatedAt', 'orders', 'providers']);
  });

  it('gives the provider read the response stamp as its clock, so eligibility and generatedAt agree', async () => {
    const view = await query.execute();
    expect(pharmacy.summarizeProviders).toHaveBeenCalledWith(view.generatedAt);
  });

  it('asks each owner exactly once and passes no filter to any of them', async () => {
    await query.execute();
    for (const fn of [
      identity.summarizeAccounts,
      catalogPort.summarizeCatalog,
      orderPort.summarizeOrders,
      deliveryPort.summarizeDelivery,
      codPort.summarizeCollections,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith();
    }
  });

  it('fails as a whole when any owner refuses, rather than answering a partial dashboard', async () => {
    orderPort.summarizeOrders.mockRejectedValue(new Error('orders unavailable'));
    await expect(query.execute()).rejects.toThrow('orders unavailable');
  });
});
