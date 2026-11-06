import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AdminErrors } from '../../domain/errors';
import { ANALYTICS_SNAPSHOT_REPOSITORY, IAnalyticsSnapshotRepository } from '../ports/analytics-snapshot.repository.port';
import { GetAnalyticsOverviewQuery } from '../queries/get-analytics-overview.query';

/** One metric key per numeric leaf of the overview, dotted (e.g. `orders.orders.byStatus.DELIVERED`). */
export type MetricValues = Map<string, number>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest range one request may chart. */
export const MAX_RANGE_DAYS = 366;
/** How many series one request may ask for. */
export const MAX_METRICS = 8;
/** The window when the caller gives none. */
export const DEFAULT_RANGE_DAYS = 30;

/**
 * Flattens the overview's six sections into metric keys.
 * A number is a metric at its path; an array of `{ <label>: string, count: number }` buckets is
 * one metric per label (`…byStatus.DELIVERED`). `generatedAt` and anything non-numeric is skipped.
 */
export function flattenOverview(node: unknown, prefix = '', out: MetricValues = new Map()): MetricValues {
  if (typeof node === 'number') {
    if (Number.isFinite(node) && prefix) out.set(prefix, node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const bucket of node) {
      if (!bucket || typeof bucket !== 'object') continue;
      const entries = Object.entries(bucket as Record<string, unknown>);
      const label = entries.find(([, v]) => typeof v === 'string')?.[1] as string | undefined;
      const count = (bucket as { count?: unknown }).count;
      if (label && typeof count === 'number') out.set(`${prefix}.${label}`, count);
    }
    return out;
  }
  if (node && typeof node === 'object' && !(node instanceof Date)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flattenOverview(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

/** Midnight UTC of the day `at` falls in: the key of that day's snapshot. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export interface TimeseriesPoint {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  /** `null` for a day without a snapshot (the server was not running), never a guessed zero. */
  value: number | null;
}

export interface TimeseriesView {
  from: string;
  to: string;
  series: Array<{ metric: string; points: TimeseriesPoint[] }>;
}

export interface SnapshotResult {
  day: string;
  metrics: number;
  takenAt: Date;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily analytics snapshots (Work 87, module-16 §8, §9.7; backend/docs/analytics-timeseries.md).
 *
 * The overview counts current state only; a trend needs yesterday's numbers. This service stores
 * one row per metric per UTC day in `dashboard_metrics` (the read-model table the initial schema
 * already provides) and serves ranges of them. Taking a snapshot again the same day replaces that
 * day's values, so the job may run as often as it likes and the last run of the day wins.
 */
@Injectable()
export class AnalyticsSnapshotService {
  constructor(
    private readonly overview: GetAnalyticsOverviewQuery,
    @Inject(ANALYTICS_SNAPSHOT_REPOSITORY) private readonly snapshots: IAnalyticsSnapshotRepository,
    private readonly audit: AuditService,
  ) {}

  /** Takes today's snapshot. `actor` is the administrator for a manual run, absent for the job. */
  async snapshot(actor?: { userId: string; ip?: string | null }): Promise<SnapshotResult> {
    const view = await this.overview.execute();
    const { accounts, catalog, providers, orders, delivery, cod } = view;
    const values = flattenOverview({ accounts, catalog, providers, orders, delivery, cod });
    const day = utcDay(view.generatedAt);
    await this.snapshots.upsertDay(day, values, view.generatedAt);
    if (actor) {
      await this.audit.record({
        actorUserId: actor.userId,
        action: 'ANALYTICS_SNAPSHOT_TAKEN',
        resourceType: 'AnalyticsSnapshot',
        resourceId: isoDay(day),
        context: { metrics: values.size },
        ip: actor.ip ?? null,
      });
    }
    return { day: isoDay(day), metrics: values.size, takenAt: view.generatedAt };
  }

  listMetrics(): Promise<string[]> {
    return this.snapshots.listMetricKeys();
  }

  async timeseries(input: { metrics: string[]; from?: string; to?: string }, now = new Date()): Promise<TimeseriesView> {
    const metrics = [...new Set(input.metrics.map((m) => m.trim()).filter(Boolean))];
    if (metrics.length === 0) throw AdminErrors.validation('Name at least one metric.');
    if (metrics.length > MAX_METRICS) throw AdminErrors.validation(`At most ${MAX_METRICS} metrics per request.`);
    const to = input.to ? parseDay(input.to, 'to') : utcDay(now);
    const from = input.from ? parseDay(input.from, 'from') : new Date(to.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
    if (from > to) throw AdminErrors.validation('`from` must not be after `to`.');
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) throw AdminErrors.validation(`A range covers at most ${MAX_RANGE_DAYS} days.`);

    const rows = await this.snapshots.findRange(metrics, from, to);
    const byKey = new Map(rows.map((r) => [`${r.metricKey}|${isoDay(r.windowStart)}`, r.value]));
    const dates = Array.from({ length: days }, (_, i) => isoDay(new Date(from.getTime() + i * DAY_MS)));
    return {
      from: isoDay(from),
      to: isoDay(to),
      series: metrics.map((metric) => ({
        metric,
        points: dates.map((date) => ({ date, value: byKey.get(`${metric}|${date}`) ?? null })),
      })),
    };
  }
}

function parseDay(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw AdminErrors.validation(`\`${field}\` must be a date (YYYY-MM-DD).`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || isoDay(d) !== value) throw AdminErrors.validation(`\`${field}\` is not a real date.`);
  return d;
}
