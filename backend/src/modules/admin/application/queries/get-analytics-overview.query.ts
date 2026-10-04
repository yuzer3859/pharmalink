import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_ANALYTICS_READ_PORT,
  CatalogAnalyticsView,
  ICatalogAnalyticsReadPort,
} from '../../../catalog/application/ports/inbound/catalog-analytics-read.port';
import {
  COD_FINANCE_READ_PORT,
  CodCollectionSummary,
  ICodFinanceReadPort,
} from '../../../delivery/application/ports/inbound/cod-finance-read.port';
import {
  DELIVERY_ANALYTICS_READ_PORT,
  DeliveryAnalyticsView,
  IDeliveryAnalyticsReadPort,
} from '../../../delivery/application/ports/inbound/delivery-analytics-read.port';
import {
  AccountAnalyticsView,
  IDENTITY_ANALYTICS_READ_PORT,
  IIdentityAnalyticsReadPort,
} from '../../../identity/application/ports/inbound/identity-analytics-read.port';
import {
  IOrderAnalyticsReadPort,
  ORDER_ANALYTICS_READ_PORT,
  OrderAnalyticsView,
} from '../../../orders/application/ports/inbound/order-analytics-read.port';
import {
  IPharmacyAnalyticsReadPort,
  PHARMACY_ANALYTICS_READ_PORT,
  PharmacyAnalyticsView,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-analytics-read.port';

/**
 * The operational dashboard: six sections, six owners, each answering its own question from its
 * own persisted state, none combined with another.
 *
 * | Section | Owner | Read |
 * | --- | --- | --- |
 * | `accounts` | Module 01 | `users` by status and primary role |
 * | `catalog` | Module 03 | live `products` by status |
 * | `providers` | Module 04 | live `pharmacies` (status, licence, eligibility), `branches`, `inventory_listings` |
 * | `orders` | Module 06 | `orders` and `fulfillments` by current status |
 * | `delivery` | Module 08 | `delivery_jobs` by status, `driver_profiles` by availability |
 * | `cod` | Module 08 | the COD collection summary its finance route serves |
 *
 * Everything is a **snapshot of now** — a count of rows in a state at the moment of the read,
 * not activity over a period (see the query's doc for why). And everything except `cod` is a
 * count: an order is not money, a delivered job is not revenue, and nothing here totals a
 * `grandTotal`. `cod` is money — the cash drivers declared, handed over and still hold, as Module
 * 08 defines each figure — and it is money in transit to PharmaLink, not PharmaLink's income and
 * not any pharmacy's payout. What customers paid and what pharmacies are owed live on
 * `/admin/finance/overview`, deliberately elsewhere.
 */
export interface AnalyticsOverviewView {
  /** When the six reads were taken. They are not one transaction; each is consistent with itself. */
  generatedAt: Date;
  accounts: AccountAnalyticsView;
  catalog: CatalogAnalyticsView;
  providers: PharmacyAnalyticsView;
  orders: OrderAnalyticsView;
  delivery: DeliveryAnalyticsView;
  cod: CodCollectionSummary;
}

/**
 * `GET /admin/analytics/overview` (module-16 §9.7, F-AD-23/24) — the control plane's view of
 * measurable marketplace activity, as it stands.
 *
 * ## It computes nothing
 *
 * Every number is a `COUNT` or `GROUP BY` the owning module's read port performed in PostgreSQL,
 * or — for `cod` — the summary Module 08 already serves. This query runs the six reads together
 * and lays the results side by side; it derives no rate, no ratio, no duration and no total
 * across sections. The design's KPI list (GMV, conversion, fulfilment times, cancellation rate)
 * is deliberately absent: none of those has a definition in Modules 01–08 today, and a control
 * plane that defined them itself would be the "third set of books" every prior work refused to
 * keep.
 *
 * ## Why there is no `from`/`to`
 *
 * Each section counts rows *by the state they are in now*. A period would have to be applied to
 * some timestamp, and there is no one timestamp that means the same thing across the sections:
 * an order has `createdAt`, `placedAt`, `completedAt` and `cancelledAt`; a job has `createdAt`
 * and `deliveredAt`; a listing's or a driver's state has no event date at all. "Orders by status,
 * for orders created in September" and "orders completed in September" are different reports,
 * and a `?from=` that silently chose one of them would be exactly the ambiguity the brief names.
 * Period reporting is deferred until each owner defines its own period read (Module 08's COD
 * summary already has one, over `collectedAt`, on its own route).
 */
@Injectable()
export class GetAnalyticsOverviewQuery {
  constructor(
    @Inject(IDENTITY_ANALYTICS_READ_PORT) private readonly identity: IIdentityAnalyticsReadPort,
    @Inject(CATALOG_ANALYTICS_READ_PORT) private readonly catalog: ICatalogAnalyticsReadPort,
    @Inject(PHARMACY_ANALYTICS_READ_PORT) private readonly providers: IPharmacyAnalyticsReadPort,
    @Inject(ORDER_ANALYTICS_READ_PORT) private readonly orders: IOrderAnalyticsReadPort,
    @Inject(DELIVERY_ANALYTICS_READ_PORT) private readonly delivery: IDeliveryAnalyticsReadPort,
    @Inject(COD_FINANCE_READ_PORT) private readonly cod: ICodFinanceReadPort,
  ) {}

  async execute(): Promise<AnalyticsOverviewView> {
    const generatedAt = new Date();
    const [accounts, catalog, providers, orders, delivery, cod] = await Promise.all([
      this.identity.summarizeAccounts(),
      this.catalog.summarizeCatalog(),
      // The one read that consults a clock (licence expiry); given the stamp so the response
      // is consistent with itself.
      this.providers.summarizeProviders(generatedAt),
      this.orders.summarizeOrders(),
      this.delivery.summarizeDelivery(),
      this.cod.summarizeCollections(),
    ]);
    return { generatedAt, accounts, catalog, providers, orders, delivery, cod };
  }
}
