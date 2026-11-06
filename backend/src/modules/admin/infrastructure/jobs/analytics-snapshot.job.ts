import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { AnalyticsSnapshotService } from '../../application/analytics/analytics-snapshot.service';

const POLL_MS = 60 * 60 * 1000;

/**
 * Takes the day's analytics snapshot (Work 87): once at start-up and then every hour, in server
 * processes only (`runsBackgroundJobs`: off under test, where specs call `runOnce`, and in CLIs).
 * Each run replaces the current UTC day's values, so the last run before midnight is the day's
 * figure and a restart never loses more than the hour since the last run.
 */
@Injectable()
export class AnalyticsSnapshotJob implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly snapshots: AnalyticsSnapshotService,
    private readonly logger: AppLogger,
    private readonly config: AppConfigService,
  ) {
    this.logger.setContext(AnalyticsSnapshotJob.name);
  }

  onApplicationBootstrap(): void {
    if (!this.config.runsBackgroundJobs) {
      return;
    }
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async runOnce(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const result = await this.snapshots.snapshot();
      return result.metrics;
    } catch (err) {
      this.logger.error({
        message: 'Analytics snapshot failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.running = false;
    }
  }
}
