import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  IOrderRecipientReadPort,
  ORDER_RECIPIENT_READ_PORT,
} from '../../../orders/application/ports/inbound/order-recipient-read.port';
import { NotificationIntent } from '../support/event-notifications';
import { RecordNotificationCommand, RecordNotificationResult } from './record-notification.command';

export interface RecordOrderNotificationInput<TPayload extends { orderId: string }> {
  eventId: string;
  eventType: string;
  payload: TPayload;
  toIntent: (payload: TPayload, customerUserId: string) => NotificationIntent;
}

export type RecordOrderNotificationResult = RecordNotificationResult | { created: false; reason: 'ORDER_NOT_FOUND' };

/**
 * An order lifecycle event whose payload names the order but not the customer (module-13 Work 02):
 * the customer is the one Module 06 records on the order, asked through
 * `ORDER_RECIPIENT_READ_PORT`, and the rest is `RecordNotificationCommand` exactly as for Work
 * 01's events — same language read, same catalogue, same `eventId:recipientUserId` dedupe.
 *
 * An unknown order writes nothing and is logged as a warning rather than thrown — the
 * convention `UserRegisteredHandler` set for an event whose subject has gone: there is no one to
 * notify, and no fallback recipient is invented.
 */
@Injectable()
export class RecordOrderNotificationCommand {
  constructor(
    @Inject(ORDER_RECIPIENT_READ_PORT) private readonly orders: IOrderRecipientReadPort,
    private readonly record: RecordNotificationCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RecordOrderNotificationCommand.name);
  }

  async execute<TPayload extends { orderId: string }>(
    input: RecordOrderNotificationInput<TPayload>,
  ): Promise<RecordOrderNotificationResult> {
    const customerUserId = await this.orders.customerUserIdOf(input.payload.orderId);
    if (!customerUserId) {
      this.logger.warn(
        `${input.eventType} ${input.eventId}: order ${input.payload.orderId} not found, no notification recorded`,
      );
      return { created: false, reason: 'ORDER_NOT_FOUND' };
    }
    return this.record.execute({
      eventId: input.eventId,
      eventType: input.eventType,
      intent: input.toIntent(input.payload, customerUserId),
    });
  }
}
