import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  IPharmacyRecipientReadPort,
  PHARMACY_RECIPIENT_READ_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-recipient-read.port';
import { NotificationIntent } from '../support/event-notifications';
import { RecordNotificationCommand, RecordNotificationResult } from './record-notification.command';

export interface RecordPharmacyNotificationInput<TPayload extends { pharmacyId: string }> {
  eventId: string;
  eventType: string;
  payload: TPayload;
  toIntent: (payload: TPayload, ownerUserId: string) => NotificationIntent;
}

export type RecordPharmacyNotificationResult = RecordNotificationResult | { created: false; reason: 'PHARMACY_OWNER_NOT_FOUND' };

/**
 * A Module 04 event about a pharmacy (module-13 Work 07). The recipient is the pharmacy's
 * organization owner, asked of Module 04 through `PHARMACY_RECIPIENT_READ_PORT`; the rest is
 * `RecordNotificationCommand` unchanged. One recipient by design — there is no repository rule for
 * notifying a pharmacy's staff. Unknown pharmacy or owner: nothing written, warning logged, no
 * recipient invented.
 */
@Injectable()
export class RecordPharmacyNotificationCommand {
  constructor(
    @Inject(PHARMACY_RECIPIENT_READ_PORT) private readonly pharmacies: IPharmacyRecipientReadPort,
    private readonly record: RecordNotificationCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RecordPharmacyNotificationCommand.name);
  }

  async execute<TPayload extends { pharmacyId: string }>(
    input: RecordPharmacyNotificationInput<TPayload>,
  ): Promise<RecordPharmacyNotificationResult> {
    const ownerUserId = await this.pharmacies.ownerUserIdOfPharmacy(input.payload.pharmacyId);
    if (!ownerUserId) {
      this.logger.warn(
        `${input.eventType} ${input.eventId}: owner of pharmacy ${input.payload.pharmacyId} not found, no notification recorded`,
      );
      return { created: false, reason: 'PHARMACY_OWNER_NOT_FOUND' };
    }
    return this.record.execute({
      eventId: input.eventId,
      eventType: input.eventType,
      intent: input.toIntent(input.payload, ownerUserId),
    });
  }
}
