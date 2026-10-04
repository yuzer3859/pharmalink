import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OrdersEventType, OrderReadyPayload } from '../../../orders/domain/events';
import { CreateDeliveryJobCommand } from '../../application/commands/create-delivery-job.command';

/**
 * Reacts to Module 06's `order.ready` by cutting the delivery job (§11.1, F-JOB-01, BRULE-27).
 *
 * ## It consumes the existing contract, it does not define a new one
 *
 * `OrdersEventType.OrderReady` and `OrderReadyPayload` are Module 06's, already written to the
 * outbox by `MarkReadyCommand` and already catalogued with Module 08 as the consumer
 * (`00-domain-event-catalog.md`: "`OrderReady` | orderId, fulfillmentId | 08 (create delivery
 * job), 13"). Importing the event *shape* is the one cross-module import ADR-002 intends — an
 * event contract is a published interface, and duplicating it would mean two definitions of one
 * message drifting apart. Every other Module 06 fact is read through `IOrdersPort`.
 *
 * ## Why the handler carries almost no logic
 *
 * It resolves nothing and validates nothing: the payload's `fulfillmentId` is the command's whole
 * input, and eligibility, snapshotting and idempotency all live in the command. A handler that
 * decided anything would be a second place where BRULE-27 was interpreted, reachable only through
 * an event — the hardest kind of rule to find and the easiest to let drift.
 *
 * ## Delivery guarantees
 *
 * The outbox is at-least-once (ADR-010), so this handler **will** sometimes run twice for one
 * fulfillment, and `EventBusService` isolates a throwing handler rather than retrying it.
 * `CreateDeliveryJobCommand` is idempotent on `fulfillmentId` behind a unique index, which is what
 * makes a redelivery harmless rather than a second driver sent to the same pharmacy.
 *
 * A failure is logged and swallowed here, deliberately: rethrowing would only be logged by the bus
 * anyway, and an order whose job was not cut is a visible operational condition — a `READY`
 * fulfillment with no job — which the dispatch work's stuck-job sweeper is the right place to
 * resolve. Failing loudly into a bus that cannot retry would buy nothing and lose the context.
 */
@Injectable()
export class OrderReadyHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly createDeliveryJob: CreateDeliveryJobCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(OrderReadyHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<OrderReadyPayload>(OrdersEventType.OrderReady, (event) =>
      this.handle(event),
    );
  }

  private async handle(event: DomainEvent<OrderReadyPayload>): Promise<void> {
    try {
      const result = await this.createDeliveryJob.execute({
        fulfillmentId: event.payload.fulfillmentId,
        // An event-driven creation has no human actor. `null` is the honest value, and the same
        // one `RunSettlementCommand` records for a scheduled run.
        actorUserId: null,
      });
      this.logger.log({
        message: result.replay ? 'Delivery job already existed' : 'Delivery job created',
        orderId: event.payload.orderId,
        fulfillmentId: event.payload.fulfillmentId,
        jobId: result.job.id,
      });
    } catch (err) {
      this.logger.error({
        message: 'Failed to create delivery job from order.ready',
        orderId: event.payload.orderId,
        fulfillmentId: event.payload.fulfillmentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
