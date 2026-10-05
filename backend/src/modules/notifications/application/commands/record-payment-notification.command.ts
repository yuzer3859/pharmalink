import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  IPaymentRecipientReadPort,
  PAYMENT_RECIPIENT_READ_PORT,
  PaymentRecipientView,
} from '../../../payment/application/ports/inbound/payment-recipient-read.port';
import { NotificationIntent } from '../support/event-notifications';
import { RecordNotificationCommand, RecordNotificationResult } from './record-notification.command';

export interface RecordPaymentNotificationInput<TPayload extends { paymentId: string }> {
  eventId: string;
  eventType: string;
  payload: TPayload;
  toIntent: (payload: TPayload, payment: PaymentRecipientView) => NotificationIntent;
}

export type RecordPaymentNotificationResult = RecordNotificationResult | { created: false; reason: 'PAYMENT_NOT_FOUND' };

/**
 * A payment event whose payload names the payment but neither the order nor the customer
 * (module-13 Work 03: `payment.refunded`). The recipient is the payment's customer as Module 07
 * records it, asked through `PAYMENT_RECIPIENT_READ_PORT`; the rest is `RecordNotificationCommand`
 * unchanged. The counterpart of `RecordOrderNotificationCommand`, with the same missing-subject
 * rule: an unknown payment writes nothing, is logged as a warning, and invents no recipient.
 */
@Injectable()
export class RecordPaymentNotificationCommand {
  constructor(
    @Inject(PAYMENT_RECIPIENT_READ_PORT) private readonly payments: IPaymentRecipientReadPort,
    private readonly record: RecordNotificationCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RecordPaymentNotificationCommand.name);
  }

  async execute<TPayload extends { paymentId: string }>(
    input: RecordPaymentNotificationInput<TPayload>,
  ): Promise<RecordPaymentNotificationResult> {
    const payment = await this.payments.recipientOf(input.payload.paymentId);
    if (!payment) {
      this.logger.warn(
        `${input.eventType} ${input.eventId}: payment ${input.payload.paymentId} not found, no notification recorded`,
      );
      return { created: false, reason: 'PAYMENT_NOT_FOUND' };
    }
    return this.record.execute({
      eventId: input.eventId,
      eventType: input.eventType,
      intent: input.toIntent(input.payload, payment),
    });
  }
}
