import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { DispatchSummary, NotificationDeliveryDispatcher } from '../../application/services/notification-delivery.dispatcher';
import { DELIVERY_QUEUE_POLICY } from '../../domain/delivery-retry-policy';

/** This worker's `SchedulerRegistry` key. */
export const NOTIFICATION_DELIVERY_INTERVAL = 'notifications.delivery-dispatch';

/**
 * Runs the delivery dispatcher every `DELIVERY_QUEUE_POLICY.dispatchIntervalMs` (module-13 Work
 * 13), one bounded batch per tick.
 *
 * - With no provider bound — production today — a tick returns before touching the database.
 * - It reads only `notification_delivery_jobs`: a notification with no job (every notification
 *   recorded before Work 13) is never looked at, and no `IN_APP` delivery is involved.
 * - Ticks never overlap within an instance; across instances the dispatcher's claim keeps them
 *   apart. A tick never throws, and none starts once the application is shutting down.
 */
@Injectable()
export class NotificationDeliveryScheduler implements OnApplicationShutdown {
  private running = false;
  private stopping = false;

  constructor(
    private readonly dispatcher: NotificationDeliveryDispatcher,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(NotificationDeliveryScheduler.name);
  }

  @Interval(NOTIFICATION_DELIVERY_INTERVAL, DELIVERY_QUEUE_POLICY.dispatchIntervalMs)
  async tick(): Promise<DispatchSummary | null> {
    if (this.running || this.stopping) return null;
    this.running = true;
    try {
      const summary = await this.dispatcher.dispatchDue(new Date(), DELIVERY_QUEUE_POLICY.dispatchBatchSize);
      if (summary.claimed > 0) this.logger.log(`delivery tick: ${JSON.stringify(summary)}`);
      return summary;
    } catch {
      this.logger.warn('delivery tick failed; the next tick retries');
      return null;
    } finally {
      this.running = false;
    }
  }

  onApplicationShutdown(): void {
    this.stopping = true;
  }
}
