import type { AnalyticsOverview, CategoryDatum, TimeSeriesPoint } from '@/types';
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

export interface AnalyticsTimeseries {
  from: string;
  to: string;
  series: Array<{ metric: string; points: Array<{ date: string; value: number | null }> }>;
}

/** `YYYY-MM-DD` (UTC) `days - 1` days before `today`, so the range covers `days` days. */
export function rangeStart(days: number, today = new Date()): string {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - (days - 1) * 86_400_000);
  return start.toISOString().slice(0, 10);
}

/**
 * Series as chart rows: `{ period, s0, s1, … }` per day, in the order `metrics` were asked for.
 * Positional keys because a dotted metric key would be read by the chart as a nested path.
 * `scale` converts a value (e.g. santim to birr); `null` stays `null`.
 */
export function toTrendData(view: AnalyticsTimeseries, metrics: string[], scale: (v: number) => number = (v) => v): TimeSeriesPoint[] {
  const byMetric = new Map(view.series.map((s) => [s.metric, s.points]));
  const dates = view.series[0]?.points.map((p) => p.date) ?? [];
  return dates.map((date, i) => {
    const row: TimeSeriesPoint = { period: date.slice(5) };
    metrics.forEach((m, k) => {
      const v = byMetric.get(m)?.[i]?.value ?? null;
      row[`s${k}`] = v === null ? null : scale(v);
    });
    return row;
  });
}

/** Whether any point in the view holds a value. */
export const hasAnyPoint = (view: AnalyticsTimeseries) => view.series.some((s) => s.points.some((p) => p.value !== null));

export function createAdminAnalyticsService(request: SessionRequest) {
  return {
    /**
     * `GET /admin/analytics/overview` (`analytics:read`): one snapshot of counts per area, plus
     * Module 08's COD cash summary in minor units. Trends come from `timeseries` (Work 87).
     */
    overview(): Promise<AnalyticsOverview> {
      return request<AnalyticsOverview>('/admin/analytics/overview', { method: 'GET' });
    },

    /** `GET /admin/analytics/timeseries` (Work 87): one point per UTC day, `null` where no snapshot exists. */
    timeseries(metrics: string[], range: { from?: string; to?: string } = {}): Promise<AnalyticsTimeseries> {
      const qs = new URLSearchParams({ metrics: metrics.join(',') });
      if (range.from) qs.set('from', range.from);
      if (range.to) qs.set('to', range.to);
      return request<AnalyticsTimeseries>(`/admin/analytics/timeseries?${qs.toString()}`, { method: 'GET' });
    },

    /** `POST /admin/analytics/snapshots`: take today's snapshot now (replaces today's values). */
    snapshotNow(): Promise<{ day: string; metrics: number; takenAt: string }> {
      return request('/admin/analytics/snapshots', { method: 'POST', body: {} });
    },
  };
}

export const adminAnalyticsService = createAdminAnalyticsService(authService.request);
