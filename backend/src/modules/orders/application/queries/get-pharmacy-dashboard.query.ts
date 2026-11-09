import { Inject, Injectable } from '@nestjs/common';
import {
  IPharmacyStockHealthReadPort,
  PHARMACY_STOCK_HEALTH_READ_PORT,
  PharmacyStockHealth,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-stock-health-read.port';
import { FulfillmentStatus } from '../../domain/enums';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';

export const PHARMACY_DASHBOARD_READ_PORT = Symbol('PHARMACY_DASHBOARD_READ_PORT');

export interface PharmacyOrderActivity {
  /** Every visible fulfilment by status (the same visibility as `GET /pharmacy/orders`). */
  byStatus: Array<{ status: FulfillmentStatus; count: number }>;
  /** Fulfilments created in the last 24 hours. */
  newLast24h: number;
  /** Line totals of delivered fulfilments whose order was placed in the last 30 days, santim. */
  deliveredRevenue30d: number;
  currency: string;
  /** The last 7 days, oldest first, by UTC date: new fulfilments, and delivered revenue by placement day. */
  last7Days: Array<{ date: string; orders: number; deliveredRevenue: number }>;
}

export interface IPharmacyDashboardReadPort {
  summarize(pharmacyIds: string[], now: Date): Promise<PharmacyOrderActivity>;
}

export interface PharmacyDashboard {
  orders: PharmacyOrderActivity;
  stock: PharmacyStockHealth;
  generatedAt: Date;
}

/**
 * Work 115: `GET /pharmacy/dashboard` (module-04 §9.1, FR-PRV-08): the caller's pharmacies'
 * orders, revenue and stock health. Orders own the order figures; stock health comes from Module 04
 * through its read port. Scoped exactly like `GET /pharmacy/orders`.
 */
@Injectable()
export class GetPharmacyDashboardQuery {
  constructor(
    @Inject(PHARMACY_DASHBOARD_READ_PORT) private readonly orders: IPharmacyDashboardReadPort,
    @Inject(PHARMACY_STOCK_HEALTH_READ_PORT) private readonly stock: IPharmacyStockHealthReadPort,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
  ) {}

  async execute(input: { actorUserId: string; now?: Date }): Promise<PharmacyDashboard> {
    const now = input.now ?? new Date();
    const organizationIds = await this.identity.getUserOrganizationIds(input.actorUserId);
    const pharmacyIds = organizationIds.length ? await this.pharmacies.findPharmacyIdsByOrganizationIds(organizationIds) : [];
    const [orders, stock] = await Promise.all([this.orders.summarize(pharmacyIds, now), this.stock.summarize(pharmacyIds, now)]);
    return { orders, stock, generatedAt: now };
  }
}
