import { authService, type SessionRequest } from './auth.service';
import type { CategoryDatum, TimeSeriesPoint } from '@/types';

/**
 * Work 116: the pharmacy dashboard and analytics on the real API (Work 115,
 * `GET /pharmacy/dashboard`, `order:read:org`), and the pharmacy's settlement statements
 * (`GET /settlements`, `settlement:read:org`). Money is integer santim on the wire.
 */

export interface PharmacyDashboard {
  orders: {
    byStatus: Array<{ status: string; count: number }>;
    newLast24h: number;
    deliveredRevenue30d: number;
    currency: string;
    last7Days: Array<{ date: string; orders: number; deliveredRevenue: number }>;
  };
  stock: {
    listings: number;
    enabledListings: number;
    outOfStock: number;
    lowStock: number;
    batchesExpiringSoon: number;
    batchesExpired: number;
  };
  generatedAt: string;
}

export interface Statement {
  settlementId: string;
  statementRef: string;
  pharmacyId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  providerPayableGross: number;
  refundClawback: number;
  netPayable: number;
  platformRevenue: number;
  lineCount: number;
  status: string;
  createdAt: string;
}

export interface StatementLine {
  ledgerReference: string;
  transactionType: string;
  orderId: string | null;
  occurredAt: string;
  providerPayableDelta: number;
}

export interface StatementDetail extends Statement {
  lines: StatementLine[];
}

export interface StatementPage {
  items: Statement[];
  total: number;
  page: number;
  size: number;
}

/** How many of the pharmacy's orders are at a status (0 when none). */
export function countAt(dashboard: PharmacyDashboard, status: string): number {
  return dashboard.orders.byStatus.find((s) => s.status === status)?.count ?? 0;
}

/** The 7-day series for the trend chart: birr, not santim. */
export function weekSeries(dashboard: PharmacyDashboard): TimeSeriesPoint[] {
  return dashboard.orders.last7Days.map((d) => ({ period: d.date.slice(5), orders: d.orders, revenue: d.deliveredRevenue / 100 }));
}

/** Order statuses for the distribution chart, lower-case, without empty slices. */
export function statusSlices(dashboard: PharmacyDashboard): CategoryDatum[] {
  return dashboard.orders.byStatus.filter((s) => s.count > 0).map((s) => ({ name: s.status.toLowerCase(), value: s.count }));
}

/** Stock health for the bar chart. */
export function stockBars(dashboard: PharmacyDashboard): CategoryDatum[] {
  const s = dashboard.stock;
  return [
    { name: 'In stock', value: Math.max(0, s.enabledListings - s.outOfStock - s.lowStock) },
    { name: 'Low stock', value: s.lowStock },
    { name: 'Out of stock', value: s.outOfStock },
    { name: 'Not sold', value: Math.max(0, s.listings - s.enabledListings) },
  ];
}

/** Things that need someone's attention today, in plain words; empty when there are none. */
export function attentionItems(dashboard: PharmacyDashboard): string[] {
  const items: string[] = [];
  const pending = countAt(dashboard, 'PENDING');
  if (pending) items.push(`${pending} new order${pending === 1 ? '' : 's'} to accept or decline`);
  const ready = countAt(dashboard, 'READY');
  if (ready) items.push(`${ready} order${ready === 1 ? '' : 's'} ready, waiting for a driver`);
  if (dashboard.stock.outOfStock) items.push(`${dashboard.stock.outOfStock} listing${dashboard.stock.outOfStock === 1 ? '' : 's'} out of stock`);
  if (dashboard.stock.batchesExpired) items.push(`${dashboard.stock.batchesExpired} expired batch${dashboard.stock.batchesExpired === 1 ? '' : 'es'} still in stock`);
  if (dashboard.stock.batchesExpiringSoon) items.push(`${dashboard.stock.batchesExpiringSoon} batch${dashboard.stock.batchesExpiringSoon === 1 ? '' : 'es'} expiring within 30 days`);
  return items;
}

export function statementQuery(filters: { status?: string; page?: number; size?: number }): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(Math.min(filters.size, 50)));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function createPharmacyDashboardService(request: SessionRequest) {
  return {
    dashboard(): Promise<PharmacyDashboard> {
      return request<PharmacyDashboard>('/pharmacy/dashboard', { method: 'GET' });
    },
    statements(filters: { status?: string; page?: number; size?: number } = {}): Promise<StatementPage> {
      return request<StatementPage>(`/settlements${statementQuery(filters)}`, { method: 'GET' });
    },
    statement(id: string): Promise<StatementDetail> {
      return request<StatementDetail>(`/settlements/${encodeURIComponent(id)}`, { method: 'GET' });
    },
  };
}

export const pharmacyDashboardService = createPharmacyDashboardService(authService.request);
