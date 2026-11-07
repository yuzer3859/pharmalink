import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OrderReadyPayload, OrdersEventType } from '../../domain/events';
import { PrepaidCaptureService } from '../../application/services/prepaid-capture.service';

/**
 * Work 96: captures a prepaid order's payment when the order becomes ready (module-07 §11.3).
 * A failure is logged, never thrown into the bus; `PaymentCaptureReconciler` retries it.
 */
@Injectable()
export class OrderReadyCaptureHandler implements OnModuleInit {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly capture: PrepaidCaptureService,
  ) {
    this.logger.setContext(OrderReadyCaptureHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<OrderReadyPayload>(OrdersEventType.OrderReady, (event) => this.handle(event));
  }

  async handle(event: DomainEvent<OrderReadyPayload>): Promise<void> {
    const orderId = (event?.payload as Partial<OrderReadyPayload> | undefined)?.orderId;
    if (!orderId) {
      this.logger.error({ message: 'Malformed order.ready event; no capture attempted', eventId: event?.id ?? null });
      return;
    }
    try {
      await this.capture.capture(orderId);
    } catch (err) {
      this.logger.error({
        message: 'Capture at fulfilment failed; the capture reconciler will retry it',
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
