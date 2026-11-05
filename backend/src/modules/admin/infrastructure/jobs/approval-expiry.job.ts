import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { ExpireApprovalService } from '../../application/maker-checker/expire-approval.service';

const POLL_MS = 60 * 1000;

/**
 * Expires maker-checker requests nobody decided in time (Work 82). Every minute, in server
 * processes only (`runsBackgroundJobs`: off under test, where specs call `runOnce`, and in CLIs).
 */
@Injectable()
export class ApprovalExpiryJob implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly expiry: ExpireApprovalService,
    private readonly logger: AppLogger,
    private readonly config: AppConfigService,
  ) {
    this.logger.setContext(ApprovalExpiryJob.name);
  }

  onModuleInit(): void {
    if (!this.config.runsBackgroundJobs) {
      return;
    }
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
      const expired = await this.expiry.expireDue();
      if (expired > 0) {
        this.logger.log({ message: 'Maker-checker requests expired', count: expired });
      }
      return expired;
    } catch (err) {
      this.logger.error({
        message: 'Maker-checker expiry sweep failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.running = false;
    }
  }
}
