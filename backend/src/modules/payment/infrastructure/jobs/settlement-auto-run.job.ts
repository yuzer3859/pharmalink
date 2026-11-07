import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { SettlementAutoRunService } from '../../application/services/settlement-auto-run.service';

export const SETTLEMENT_AUTO_RUN_CRON = 'payment.settlement-auto-run';

/**
 * Work 97: checks the settlement triggers hourly (`SettlementAutoRunService`). Off in tests and in
 * CLI processes, like every background job; tests drive the service directly.
 */
@Injectable()
export class SettlementAutoRunJob {
  private readonly logger = new AppLogger();
  private running = false;

  constructor(
    private readonly service: SettlementAutoRunService,
    private readonly appConfig: AppConfigService,
  ) {
    this.logger.setContext(SettlementAutoRunJob.name);
  }

  @Cron(CronExpression.EVERY_HOUR, { name: SETTLEMENT_AUTO_RUN_CRON })
  async tick(): Promise<void> {
    if (!this.appConfig.runsBackgroundJobs || this.running) return;
    this.running = true;
    try {
      const report = await this.service.run();
      if (report.generated.length > 0 || report.failures > 0) {
        this.logger.log({ message: 'Automatic settlement run', generated: report.generated.length, failures: report.failures });
      }
    } catch (err) {
      this.logger.error({ message: 'Automatic settlement run failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }
}
