import type { AnalyticsOverview, CategoryDatum } from '@/types';
import { authService, type SessionRequest } from './auth.service';

/** A persisted enum value as a chart label: `PENDING_PAYMENT` → `Pending payment`. */
export const humanizeStatus = (status: string) => {
  const words = status.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A breakdown as chart data, in the server's order, empty buckets left out. */
export function toChartData(buckets: Array<{ status: string; count: number }>): CategoryDatum[] {
  return buckets.filter((b) => b.count > 0).map((b) => ({ name: humanizeStatus(b.status), value: b.count }));
}

/** The count of one status in a breakdown, 0 when the server reported none. */
export const countOf = (buckets: Array<{ status: string; count: number }>, status: string) =>
  buckets.find((b) => b.status === status)?.count ?? 0;

export function createAdminAnalyticsService(request: SessionRequest) {
  return {
    /**
     * `GET /admin/analytics/overview` (`analytics:read`): one snapshot of counts per area, plus
     * Module 08's COD cash summary in minor units. No time series, rates or revenue.
     */
    overview(): Promise<AnalyticsOverview> {
      return request<AnalyticsOverview>('/admin/analytics/overview', { method: 'GET' });
    },
  };
}

export const adminAnalyticsService = createAdminAnalyticsService(authService.request);
