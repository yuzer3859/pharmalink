import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IAnalyticsSnapshotRepository, SnapshotRow } from '../../application/ports/analytics-snapshot.repository.port';

/**
 * The `dimension` every Work 87 row carries. The unique key is (metricKey, dimension, windowStart)
 * and Postgres treats NULLs as distinct, so a NULL dimension would let the same day be written
 * twice; the dimension is folded into the metric key instead and this constant fills the column.
 */
export const SNAPSHOT_DIMENSION = 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `dashboard_metrics` (initial schema, Admin's read model), one row per metric per UTC day. */
@Injectable()
export class PrismaAnalyticsSnapshotRepository implements IAnalyticsSnapshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertDay(day: Date, values: Map<string, number>, computedAt: Date): Promise<void> {
    const windowEnd = new Date(day.getTime() + DAY_MS);
    await this.prisma.$transaction(
      [...values].map(([metricKey, value]) =>
        this.prisma.dashboardMetric.upsert({
          where: { metricKey_dimension_windowStart: { metricKey, dimension: SNAPSHOT_DIMENSION, windowStart: day } },
          create: { metricKey, dimension: SNAPSHOT_DIMENSION, value, windowStart: day, windowEnd, computedAt },
          update: { value, windowEnd, computedAt },
        }),
      ),
    );
  }

  async findRange(metricKeys: string[], from: Date, to: Date): Promise<SnapshotRow[]> {
    return this.prisma.dashboardMetric.findMany({
      where: { metricKey: { in: metricKeys }, dimension: SNAPSHOT_DIMENSION, windowStart: { gte: from, lte: to } },
      select: { metricKey: true, windowStart: true, value: true },
      orderBy: { windowStart: 'asc' },
    });
  }

  async listMetricKeys(): Promise<string[]> {
    const rows = await this.prisma.dashboardMetric.findMany({
      where: { dimension: SNAPSHOT_DIMENSION },
      distinct: ['metricKey'],
      select: { metricKey: true },
      orderBy: { metricKey: 'asc' },
    });
    return rows.map((r) => r.metricKey);
  }
}
