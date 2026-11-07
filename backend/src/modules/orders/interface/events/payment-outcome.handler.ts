import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  PaymentAuthorizedPayload,
  PaymentEventType,
  PaymentFailedPayload,
} from '../../../payment/domain/events';
import { PrepaidPaymentService } from '../../application/services/prepaid-payment.service';

/**
 * Work 95: the asynchronous half of the prepaid checkout saga (module-06 §6 steps 7–8). A
 * redirect-flow payment is decided later, by the gateway's webhook; Module 07 then emits
 * `payment.authorized` or `payment.failed`, and this applies it to the order. The in-request
 * checkout path applies the same outcome first, so this is then a no-op (`PrepaidPaymentService`
 * is idempotent). Errors are logged with the ids, never thrown into the bus.
 */
@Injectable()
export class PaymentOutcomeHandler implements OnModuleInit {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prepaid: PrepaidPaymentService,
  ) {
    this.logger.setContext(PaymentOutcomeHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<PaymentAuthorizedPayload>(PaymentEventType.PaymentAuthorized, (event) => this.authorized(event));
    this.bus.subscribe<PaymentFailedPayload>(PaymentEventType.PaymentFailed, (event) => this.failed(event));
  }

  async authorized(event: DomainEvent<PaymentAuthorizedPayload>): Promise<void> {
    const { orderId, paymentId } = (event?.payload ?? {}) as Partial<PaymentAuthorizedPayload>;
    if (!orderId || !paymentId) {
      this.logger.error({ message: 'Malformed payment.authorized event; order not updated', eventId: event?.id ?? null });
      return;
    }
    try {
      const outcome = await this.prepaid.onAuthorized({ orderId, paymentId });
      this.logger.log({ message: 'Applied payment.authorized to the order', orderId, paymentId, outcome });
    } catch (err) {
      this.logger.error({
        message: 'Could not apply payment.authorized to the order',
        orderId,
        paymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async failed(event: DomainEvent<PaymentFailedPayload>): Promise<void> {
    const { orderId, paymentId } = (event?.payload ?? {}) as Partial<PaymentFailedPayload>;
    if (!orderId) {
      this.logger.error({ message: 'Malformed payment.failed event; order not updated', eventId: event?.id ?? null });
      return;
    }
    try {
      const outcome = await this.prepaid.onFailed({ orderId });
      this.logger.log({ message: 'Applied payment.failed to the order', orderId, paymentId, outcome });
    } catch (err) {
      this.logger.error({
        message: 'Could not apply payment.failed to the order',
        orderId,
        paymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
