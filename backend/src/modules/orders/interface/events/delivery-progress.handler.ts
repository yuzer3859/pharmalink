import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { DeliveryEventType, DeliveryStatusPayload } from '../../../delivery/domain/events';
import { DeliveryMilestone, OrderDeliveryProgressService } from '../../application/services/order-delivery-progress.service';

/** Work 103 (G14): the order follows its delivery (picked up → DISPATCHED, delivered → DELIVERED). */
@Injectable()
export class DeliveryProgressHandler implements OnModuleInit {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly progress: OrderDeliveryProgressService,
  ) {
    this.logger.setContext(DeliveryProgressHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<DeliveryStatusPayload>(DeliveryEventType.OrderPickedUp, (e) => this.handle(e, 'PICKED_UP'));
    this.bus.subscribe<DeliveryStatusPayload>(DeliveryEventType.OrderDelivered, (e) => this.handle(e, 'DELIVERED'));
  }

  async handle(event: DomainEvent<DeliveryStatusPayload>, milestone: DeliveryMilestone): Promise<void> {
    const { orderId, fulfillmentId, jobId } = (event?.payload ?? {}) as Partial<DeliveryStatusPayload>;
    if (!orderId || !fulfillmentId || !jobId) {
      this.logger.error({ message: 'Malformed delivery progress event; order not advanced', eventId: event?.id ?? null, milestone });
      return;
    }
    try {
      const outcome = await this.progress.apply({ orderId, fulfillmentId, jobId, milestone });
      this.logger.log({ message: 'Order followed its delivery', orderId, milestone, outcome });
    } catch (err) {
      this.logger.error({
        message: 'Could not advance the order from its delivery',
        orderId,
        milestone,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
