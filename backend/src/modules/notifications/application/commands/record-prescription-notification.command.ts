import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  IPrescriptionRecipientReadPort,
  PRESCRIPTION_RECIPIENT_READ_PORT,
} from '../../../prescription-matching/application/ports/inbound/prescription-recipient-read.port';
import { NotificationIntent } from '../support/event-notifications';
import { RecordNotificationCommand, RecordNotificationResult } from './record-notification.command';

/** What a Module 05 event names: a prescription, or a match request. */
export type PrescriptionSubject = { kind: 'prescription'; id: string } | { kind: 'matchRequest'; id: string };

export interface RecordPrescriptionNotificationInput<TPayload> {
  eventId: string;
  eventType: string;
  payload: TPayload;
  subject: PrescriptionSubject;
  toIntent: (payload: TPayload, customerUserId: string) => NotificationIntent;
}

export type RecordPrescriptionNotificationResult =
  | RecordNotificationResult
  | { created: false; reason: 'PRESCRIPTION_NOT_FOUND' | 'MATCH_REQUEST_NOT_FOUND' };

/**
 * A Module 05 event addressed to the customer who owns the prescription or match request it names
 * (module-13 Work 06). The customer is asked of Module 05 through
 * `PRESCRIPTION_RECIPIENT_READ_PORT`; the rest is `RecordNotificationCommand` unchanged. Same
 * missing-subject rule as the other recipient commands: unknown → nothing written, warning logged,
 * no recipient invented.
 */
@Injectable()
export class RecordPrescriptionNotificationCommand {
  constructor(
    @Inject(PRESCRIPTION_RECIPIENT_READ_PORT) private readonly prescriptions: IPrescriptionRecipientReadPort,
    private readonly record: RecordNotificationCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RecordPrescriptionNotificationCommand.name);
  }

  async execute<TPayload>(input: RecordPrescriptionNotificationInput<TPayload>): Promise<RecordPrescriptionNotificationResult> {
    const { subject } = input;
    const customerUserId =
      subject.kind === 'prescription'
        ? await this.prescriptions.customerUserIdOfPrescription(subject.id)
        : await this.prescriptions.customerUserIdOfMatchRequest(subject.id);

    if (!customerUserId) {
      const label = subject.kind === 'prescription' ? 'prescription' : 'match request';
      this.logger.warn(`${input.eventType} ${input.eventId}: ${label} ${subject.id} not found, no notification recorded`);
      return { created: false, reason: subject.kind === 'prescription' ? 'PRESCRIPTION_NOT_FOUND' : 'MATCH_REQUEST_NOT_FOUND' };
    }
    return this.record.execute({
      eventId: input.eventId,
      eventType: input.eventType,
      intent: input.toIntent(input.payload, customerUserId),
    });
  }
}
