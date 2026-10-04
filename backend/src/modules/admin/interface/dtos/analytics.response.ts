import { CatalogAnalyticsView } from '../../../catalog/application/ports/inbound/catalog-analytics-read.port';
import { CodCollectionSummary } from '../../../delivery/application/ports/inbound/cod-finance-read.port';
import { DeliveryAnalyticsView } from '../../../delivery/application/ports/inbound/delivery-analytics-read.port';
import { AccountAnalyticsView } from '../../../identity/application/ports/inbound/identity-analytics-read.port';
import { OrderAnalyticsView } from '../../../orders/application/ports/inbound/order-analytics-read.port';
import { PharmacyAnalyticsView } from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-analytics-read.port';
import { AnalyticsOverviewView } from '../../application/queries/get-analytics-overview.query';

/** One bucket of a breakdown: a persisted enum value and how many rows carry it. */
export interface StatusCountResponse {
  status: string;
  count: number;
}

export interface AccountsAnalyticsResponse {
  total: number;
  byStatus: StatusCountResponse[];
  byPrimaryRole: Array<{ primaryRole: string; count: number }>;
}

export interface CatalogAnalyticsResponse {
  products: { total: number; byStatus: StatusCountResponse[] };
}

export interface ProvidersAnalyticsResponse {
  pharmacies: {
    total: number;
    eligible: number;
    byTransactingStatus: StatusCountResponse[];
    byLicenseStatus: StatusCountResponse[];
  };
  branches: { total: number; active: number; inactive: number };
  listings: { total: number; enabled: number; disabled: number; inStock: number; outOfStock: number };
}

export interface OrdersAnalyticsResponse {
  orders: { total: number; byStatus: StatusCountResponse[] };
  fulfillments: { total: number; byStatus: StatusCountResponse[] };
}

export interface DeliveryAnalyticsResponse {
  jobs: { total: number; byStatus: StatusCountResponse[] };
  drivers: {
    total: number;
    dispatchable: number;
    byAvailability: Array<{ availability: string; count: number }>;
  };
}

/** Module 08's own summary, field by field — the same shape its `/summary` route returns. Minor units, ETB. */
export interface CodAnalyticsResponse {
  count: number;
  expectedAmount: number;
  collectedAmount: number;
  remittedAmount: number;
  outstandingCount: number;
  outstandingAmount: number;
  discrepancyCount: number;
}

/**
 * Six sections and a stamp, no total across them, no rate, no ratio. Five sections are counts;
 * `cod` alone is money, and it is the cash Module 08 accounts for — not revenue, not a payout.
 * See `AnalyticsOverviewView`.
 */
export interface AnalyticsOverviewResponse {
  generatedAt: string;
  accounts: AccountsAnalyticsResponse;
  catalog: CatalogAnalyticsResponse;
  providers: ProvidersAnalyticsResponse;
  orders: OrdersAnalyticsResponse;
  delivery: DeliveryAnalyticsResponse;
  cod: CodAnalyticsResponse;
}

// ---------------------------------------------------------------------------------------------
// Mappers — explicit allow-lists, never a spread of a port's view
// ---------------------------------------------------------------------------------------------

const buckets = (rows: { status: string; count: number }[]): StatusCountResponse[] =>
  rows.map((r) => ({ status: r.status, count: r.count }));

function toAccounts(v: AccountAnalyticsView): AccountsAnalyticsResponse {
  return {
    total: v.total,
    byStatus: buckets(v.byStatus),
    byPrimaryRole: v.byPrimaryRole.map((r) => ({ primaryRole: r.primaryRole, count: r.count })),
  };
}

function toCatalog(v: CatalogAnalyticsView): CatalogAnalyticsResponse {
  return { products: { total: v.products.total, byStatus: buckets(v.products.byStatus) } };
}

function toProviders(v: PharmacyAnalyticsView): ProvidersAnalyticsResponse {
  return {
    pharmacies: {
      total: v.pharmacies.total,
      eligible: v.pharmacies.eligible,
      byTransactingStatus: buckets(v.pharmacies.byTransactingStatus),
      byLicenseStatus: buckets(v.pharmacies.byLicenseStatus),
    },
    branches: { total: v.branches.total, active: v.branches.active, inactive: v.branches.inactive },
    listings: {
      total: v.listings.total,
      enabled: v.listings.enabled,
      disabled: v.listings.disabled,
      inStock: v.listings.inStock,
      outOfStock: v.listings.outOfStock,
    },
  };
}

function toOrders(v: OrderAnalyticsView): OrdersAnalyticsResponse {
  return {
    orders: { total: v.orders.total, byStatus: buckets(v.orders.byStatus) },
    fulfillments: { total: v.fulfillments.total, byStatus: buckets(v.fulfillments.byStatus) },
  };
}

function toDelivery(v: DeliveryAnalyticsView): DeliveryAnalyticsResponse {
  return {
    jobs: { total: v.jobs.total, byStatus: buckets(v.jobs.byStatus) },
    drivers: {
      total: v.drivers.total,
      dispatchable: v.drivers.dispatchable,
      byAvailability: v.drivers.byAvailability.map((r) => ({ availability: r.availability, count: r.count })),
    },
  };
}

function toCod(s: CodCollectionSummary): CodAnalyticsResponse {
  return {
    count: s.count,
    expectedAmount: s.expectedAmount,
    collectedAmount: s.collectedAmount,
    remittedAmount: s.remittedAmount,
    outstandingCount: s.outstandingCount,
    outstandingAmount: s.outstandingAmount,
    discrepancyCount: s.discrepancyCount,
  };
}

export function toAnalyticsOverviewResponse(view: AnalyticsOverviewView): AnalyticsOverviewResponse {
  return {
    generatedAt: view.generatedAt.toISOString(),
    accounts: toAccounts(view.accounts),
    catalog: toCatalog(view.catalog),
    providers: toProviders(view.providers),
    orders: toOrders(view.orders),
    delivery: toDelivery(view.delivery),
    cod: toCod(view.cod),
  };
}
