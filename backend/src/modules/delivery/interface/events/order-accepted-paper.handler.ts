import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OrderAcceptedPayload, OrdersEventType } from '../../../orders/domain/events';
import { CreateDeliveryJobCommand } from '../../application/commands/create-delivery-job.command';

/**
 * Work 136: an order whose original paper prescription must reach the pharmacy gets its delivery job
 * when the pharmacy accepts it, not when it is ready — the driver's round trip starts at the
 * customer. Every other order's fulfilment is not deliverable yet, and is left alone quietly.
 */
@Injectable()
export class OrderAcceptedPaperHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly createDeliveryJob: CreateDeliveryJobCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(OrderAcceptedPaperHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<OrderAcceptedPayload>(OrdersEventType.OrderAccepted, (event) => this.handle(event));
  }

  private async handle(event: DomainEvent<OrderAcceptedPayload>): Promise<void> {
    try {
      const result = await this.createDeliveryJob.execute({ fulfillmentId: event.payload.fulfillmentId, actorUserId: null });
      this.logger.log({ message: 'Paper-prescription delivery job created at acceptance', orderId: event.payload.orderId, jobId: result.job.id });
    } catch (err) {
      if ((err as { code?: string }).code === ErrorCode.FULFILLMENT_NOT_DELIVERABLE) return;
      this.logger.error({
        message: 'Failed to create the paper-prescription delivery job from order.accepted',
        orderId: event.payload.orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
