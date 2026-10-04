import { Injectable } from '@nestjs/common';
import { AppLogger } from '../logging/app-logger.service';
import { DomainEvent, EventHandler } from './domain-event';

export const EVENT_BUS = Symbol('EVENT_BUS');

export interface IEventBus {
  subscribe<T>(eventType: string, handler: EventHandler<T>): void;
  publish<T>(event: DomainEvent<T>): Promise<void>;
}

/**
 * In-process, typed publish/subscribe bus. Handlers for a type run concurrently; a failing
 * handler is logged and isolated so it cannot break the publisher or sibling handlers
 * (at-least-once, idempotent-consumer model — see ADR-010). The outbox relay publishes onto
 * this bus today; swapping to a real broker later keeps this same interface.
 */
@Injectable()
export class EventBusService implements IEventBus {
  private readonly handlers = new Map<string, EventHandler[]>();

  constructor(private readonly logger: AppLogger) {
    this.logger.setContext(EventBusService.name);
  }

  subscribe<T>(eventType: string, handler: EventHandler<T>): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler as EventHandler);
    this.handlers.set(eventType, existing);
  }

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    await Promise.all(
      handlers.map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          this.logger.error(
            {
              message: 'Event handler failed',
              eventType: event.type,
              eventId: event.id,
              error: err instanceof Error ? err.message : String(err),
            },
            err instanceof Error ? err.stack : undefined,
          );
        }
      }),
    );
  }

  /** Test/introspection helper: number of handlers registered for a type. */
  handlerCount(eventType: string): number {
    return this.handlers.get(eventType)?.length ?? 0;
  }
}
