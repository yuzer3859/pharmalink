import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OrdersEventType, OrderCancelledPayload } from '../../../orders/domain/events';
import { CancelDeliveryJobCommand } from '../../application/commands/cancel-delivery-job.command';

/**
 * Cancels a job when its order is cancelled upstream (§9.3's "order cancelled upstream").
 *
 * ## It consumes the existing contract
 *
 * `OrdersEventType.OrderCancelled` is Module 06's, already written to the outbox and already
 * catalogued with Module 08 as a consumer (`00-domain-event-catalog.md`: "`OrderCancelled` |
 * orderId, reason | 04 (release), 07 (refund), **08 (cancel job)**, 13"). Importing the event
 * *shape* is the one cross-module import ADR-002 intends, and is exactly what `OrderReadyHandler`
 * already does for `order.ready`.
 *
 * The payload carries an `orderId` and nothing else, which is why the command resolves *every*
 * job the order produced: a split order has one job per pharmacy (§5.3), and cancelling only the
 * first would leave the second driver on the road.
 *
 * ## A job past the pickup boundary is not cancelled, and that is the point
 *
 * `CancelDeliveryJobCommand.forOrder` reports those jobs instead of forcing them. A driver already
 * holding the medicines cannot have them un-hold; the goods exist and have to end up somewhere,
 * and that path is `FAILED` with its return obligation, decided by Module 06 and Module 07 rather
 * than here. This handler logs the refusal at `warn` so the condition is visible — an order
 * cancelled while a bag is in transit is exactly the situation an operator needs to know about.
 *
 * Failures are logged and swallowed, as `OrderReadyHandler` and `JobCreatedHandler` both do:
 * `EventBusService` isolates a throwing handler rather than retrying it, so rethrowing would lose
 * the context and buy nothing.
 */
@Injectable()
export class OrderCancelledHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly cancelJobs: CancelDeliveryJobCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(OrderCancelledHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<OrderCancelledPayload>(OrdersEventType.OrderCancelled, (event) =>
      this.handle(event),
    );
  }

  private async handle(event: DomainEvent<OrderCancelledPayload>): Promise<void> {
    const { orderId, reason } = event.payload;
    try {
      const result = await this.cancelJobs.forOrder({
        orderId,
        reason: reason || 'Order cancelled',
        // An event-driven cancellation has no human actor — the same `null` every other
        // event-driven command in this module records.
        actorUserId: null,
      });

      if (result.refused.length > 0) {
        this.logger.warn({
          message: 'Order cancelled after pickup — delivery job left in transit',
          orderId,
          refused: result.refused,
        });
      }

      this.logger.log({
        message: 'Delivery jobs cancelled for cancelled order',
        orderId,
        cancelled: result.cancelled.length,
        alreadyCancelled: result.unchanged.length,
        refused: result.refused.length,
      });
    } catch (err) {
      this.logger.error({
        message: 'Failed to cancel delivery jobs for cancelled order',
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
