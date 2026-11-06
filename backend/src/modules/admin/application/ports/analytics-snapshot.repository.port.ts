export const ANALYTICS_SNAPSHOT_REPOSITORY = Symbol('ANALYTICS_SNAPSHOT_REPOSITORY');

export interface SnapshotRow {
  metricKey: string;
  windowStart: Date;
  value: number;
}

/** Daily analytics snapshots (Work 87): one value per metric per UTC day. */
export interface IAnalyticsSnapshotRepository {
  /** Writes (or replaces) every metric for the day starting at `day`, in one transaction. */
  upsertDay(day: Date, values: Map<string, number>, computedAt: Date): Promise<void>;
  findRange(metricKeys: string[], from: Date, to: Date): Promise<SnapshotRow[]>;
  listMetricKeys(): Promise<string[]>;
}
