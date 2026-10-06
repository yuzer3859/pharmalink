import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  DRIVER_RECIPIENT_READ_PORT,
  IDriverRecipientReadPort,
} from '../../../delivery/application/ports/inbound/driver-recipient-read.port';
import { NotificationIntent } from '../support/event-notifications';
import { RecordNotificationCommand, RecordNotificationResult } from './record-notification.command';

export interface RecordDriverNotificationInput<TPayload extends { driverId: string }> {
  eventId: string;
  eventType: string;
  payload: TPayload;
  toIntent: (payload: TPayload, driverUserId: string) => NotificationIntent;
}

export type RecordDriverNotificationResult = RecordNotificationResult | { created: false; reason: 'DRIVER_NOT_FOUND' };

/**
 * A Module 08 event addressed to a driver (module-13 Work 05). Its `driverId` is a
 * `driver_profiles.id`, so the person to notify is the profile's Module 01 user, asked through
 * `DRIVER_RECIPIENT_READ_PORT`; the rest is `RecordNotificationCommand` unchanged. The counterpart
 * of `RecordOrderNotificationCommand` and `RecordPaymentNotificationCommand`, with the same
 * missing-subject rule: an unknown profile writes nothing, is logged as a warning, and invents no
 * recipient.
 */
@Injectable()
export class RecordDriverNotificationCommand {
  constructor(
    @Inject(DRIVER_RECIPIENT_READ_PORT) private readonly drivers: IDriverRecipientReadPort,
    private readonly record: RecordNotificationCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RecordDriverNotificationCommand.name);
  }

  async execute<TPayload extends { driverId: string }>(
    input: RecordDriverNotificationInput<TPayload>,
  ): Promise<RecordDriverNotificationResult> {
    const userId = await this.drivers.userIdOf(input.payload.driverId);
    if (!userId) {
      this.logger.warn(
        `${input.eventType} ${input.eventId}: driver profile ${input.payload.driverId} not found, no notification recorded`,
      );
      return { created: false, reason: 'DRIVER_NOT_FOUND' };
    }
    return this.record.execute({
      eventId: input.eventId,
      eventType: input.eventType,
      intent: input.toIntent(input.payload, userId),
    });
  }
}
