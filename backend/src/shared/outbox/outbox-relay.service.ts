import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DomainEvent } from '../events/domain-event';
import { EventBusService } from '../events/event-bus.service';
import { AppLogger } from '../logging/app-logger.service';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_POLL_MS = 2000;
const BATCH_SIZE = 100;

/**
 * Polls the outbox for unpublished events and dispatches them onto the in-process event bus,
 * marking each as published on success (see ADR-010). At-least-once: a crash between publish
 * and mark re-delivers, so consumers must be idempotent. Disabled automatically in tests.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBusService,
    private readonly logger: AppLogger,
    private readonly config: AppConfigService,
  ) {
    this.logger.setContext(OutboxRelay.name);
  }

  onModuleInit(): void {
    if (this.config.isTest) {
      return; // deterministic tests drive relayOnce() manually
    }
    this.timer = setInterval(() => {
      void this.relayOnce();
    }, DEFAULT_POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Publishes one batch of pending events. Returns the number successfully published. */
  async relayOnce(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    let published = 0;
    try {
      const pending = await this.prisma.outbox.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const row of pending) {
        const event = row.payload as unknown as DomainEvent;
        try {
          await this.bus.publish(event);
          await this.prisma.outbox.update({
            where: { id: row.id },
            data: { publishedAt: new Date() },
          });
          published += 1;
        } catch (err) {
          this.logger.error(
            {
              message: 'Outbox relay failed to publish event',
              outboxId: row.id,
              eventType: row.eventType,
              error: err instanceof Error ? err.message : String(err),
            },
            err instanceof Error ? err.stack : undefined,
          );
        }
      }
    } finally {
      this.running = false;
    }
    return published;
  }
}
