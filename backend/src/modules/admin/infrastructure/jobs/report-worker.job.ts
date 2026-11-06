import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { ReportService } from '../../application/reports/report.service';

const POLL_MS = 5 * 1000;
/** Jobs built per tick at most, so one tick never runs unbounded. */
const PER_TICK = 5;

/**
 * Builds queued reports (Work 90). Every five seconds, in server processes only
 * (`runsBackgroundJobs`: off under test, where specs call `runOnce`, and in CLIs).
 */
@Injectable()
export class ReportWorkerJob implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly reports: ReportService,
    private readonly logger: AppLogger,
    private readonly config: AppConfigService,
  ) {
    this.logger.setContext(ReportWorkerJob.name);
  }

  onModuleInit(): void {
    if (!this.config.runsBackgroundJobs) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Builds up to `PER_TICK` queued reports; returns how many it took. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let built = 0;
    try {
      while (built < PER_TICK && (await this.reports.runNext())) built++;
      return built;
    } catch (err) {
      this.logger.error({ message: 'Report worker failed', error: err instanceof Error ? err.message : String(err) });
      return built;
    } finally {
      this.running = false;
    }
  }
}
