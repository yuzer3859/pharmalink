import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { ExpireVerificationsCommand } from '../../application/commands/expire-verifications.command';

const POLL_MS = 60 * 60 * 1000;

/**
 * Hourly licence-expiry sweep (module-01 §9.3, BRULE-08). Mirrors the OutboxRelay pattern: a
 * plain interval that is disabled under test so suites can drive ExpireVerificationsCommand
 * deterministically. Replace with a distributed scheduler once the app runs multi-instance —
 * concurrent runs are safe (the transition is idempotent) but wasteful.
 */
@Injectable()
export class LicenseExpiryJob implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly expireVerifications: ExpireVerificationsCommand,
    private readonly logger: AppLogger,
    private readonly config: AppConfigService,
  ) {
    this.logger.setContext(LicenseExpiryJob.name);
  }

  onModuleInit(): void {
    if (this.config.isTest) {
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
      const expired = await this.expireVerifications.execute();
      if (expired > 0) {
        this.logger.warn({ message: 'Licences expired and providers suspended', count: expired });
      }
      return expired;
    } catch (err) {
      this.logger.error(
        {
          message: 'Licence-expiry sweep failed',
          error: err instanceof Error ? err.message : String(err),
        },
        err instanceof Error ? err.stack : undefined,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
