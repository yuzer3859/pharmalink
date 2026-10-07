import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_CONTACT_READ_PORT,
  IIdentityContactReadPort,
} from '../../../identity/application/ports/inbound/identity-contact-read.port';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  INotificationChannelProvider,
} from '../../application/ports/outbound/notification-channel-provider.port';
import { ISmsTransport, SMS_TRANSPORT, SmsSendResult } from '../../application/ports/outbound/sms-transport.port';
import { PROVIDER_ERROR_CODE } from '../../domain/delivery-policy';
import { SMS_DELIVERY_POLICY } from '../../domain/delivery-retry-policy';
import { NotificationChannel } from '../../domain/enums';
import { smsTextOf } from '../../domain/sms-content';
import { withDeadline } from './with-deadline';

/**
 * The SMS channel provider (module-13 Work 15). One SMS per notification — one job, one attempt
 * per try — to the recipient's own verified phone, resolved through Module 01's
 * `IDENTITY_CONTACT_READ_PORT` at send time and held only for the call: never stored, logged or
 * returned.
 *
 *     gateway not configured                → NOT_CONFIGURED (job waits, no attempt)
 *     no usable phone (Module 01 says why)  → FAILED `SMS_RECIPIENT_<REASON>`, not retryable
 *     gateway SENT                          → SENT
 *     invalid recipient / rejected request  → FAILED, not retryable
 *     unavailable / rate-limited / network / timeout / throw → FAILED, retryable (Work 13 backoff)
 *     credentials refused                   → NOT_CONFIGURED
 *     anything else                         → FAILED `SMS_INVALID_RESULT`, retryable
 */
@Injectable()
export class SmsNotificationProvider implements INotificationChannelProvider {
  readonly channel = NotificationChannel.SMS;

  constructor(
    @Inject(IDENTITY_CONTACT_READ_PORT) private readonly contacts: IIdentityContactReadPort,
    @Inject(SMS_TRANSPORT) private readonly transport: ISmsTransport,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(SmsNotificationProvider.name);
  }

  get name(): string {
    return this.transport.name;
  }

  async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (!this.transport.isConfigured()) return { outcome: 'NOT_CONFIGURED' };
    const contact = await this.contacts.smsRecipientOf(request.recipient.userId);
    if (!contact.available) return { outcome: 'FAILED', errorCode: `SMS_RECIPIENT_${contact.reason}`, retryable: false };

    const timedOut: SmsSendResult = { kind: 'TRANSIENT', code: 'SMS_TIMEOUT' };
    const result = await withDeadline(
      this.transport.send(contact.phone, smsTextOf(request), SMS_DELIVERY_POLICY.requestTimeoutMs).catch((): SmsSendResult => {
        // The exception's message is not logged: it may carry the number or a credential.
        this.logger.warn(`SMS gateway threw for notification ${request.notificationId}`);
        return { kind: 'TRANSIENT', code: 'SMS_NETWORK_ERROR' };
      }),
      SMS_DELIVERY_POLICY.deliveryDeadlineMs,
      timedOut,
    );

    const code = (c: unknown, fallback: string) => (typeof c === 'string' && PROVIDER_ERROR_CODE.test(c) ? c : fallback);
    switch (result?.kind) {
      case 'SENT':
        return { outcome: 'SENT', providerMessageId: typeof result.messageId === 'string' ? result.messageId : undefined };
      case 'INVALID_RECIPIENT':
        return { outcome: 'FAILED', errorCode: code(result.code, 'SMS_INVALID_RECIPIENT'), retryable: false };
      case 'REJECTED':
        return { outcome: 'FAILED', errorCode: code(result.code, 'SMS_REJECTED'), retryable: false };
      case 'TRANSIENT':
        return { outcome: 'FAILED', errorCode: code(result.code, 'SMS_UNAVAILABLE'), retryable: true };
      case 'NOT_CONFIGURED':
        return { outcome: 'NOT_CONFIGURED' };
      default:
        return { outcome: 'FAILED', errorCode: 'SMS_INVALID_RESULT', retryable: true };
    }
  }
}
