import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_CONTACT_READ_PORT,
  IIdentityContactReadPort,
} from '../../../identity/application/ports/inbound/identity-contact-read.port';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { EMAIL_TRANSPORT, EmailSendResult, IEmailTransport } from '../../application/ports/outbound/email-transport.port';
import {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  INotificationChannelProvider,
} from '../../application/ports/outbound/notification-channel-provider.port';
import { PROVIDER_ERROR_CODE } from '../../domain/delivery-policy';
import { EMAIL_DELIVERY_POLICY } from '../../domain/delivery-retry-policy';
import { emailContentOf } from '../../domain/email-content';
import { NotificationChannel } from '../../domain/enums';
import { withDeadline } from './with-deadline';

/**
 * The EMAIL channel provider (module-13 Work 16). One e-mail per notification — one job, one
 * attempt per try — to the recipient's own verified address, resolved through Module 01's
 * `IDENTITY_CONTACT_READ_PORT` at send time and held only for the call: never stored, logged or
 * returned. Same outcome mapping as SMS:
 *
 *     provider not configured / credentials refused → NOT_CONFIGURED (job waits, no attempt)
 *     no usable address (Module 01 says why)        → FAILED `EMAIL_RECIPIENT_<REASON>`, not retryable
 *     SENT                                          → SENT
 *     invalid recipient / rejected message          → FAILED, not retryable
 *     unavailable / throttled / network / timeout / throw → FAILED, retryable (Work 13 backoff)
 *     anything else                                 → FAILED `EMAIL_INVALID_RESULT`, retryable
 */
@Injectable()
export class EmailNotificationProvider implements INotificationChannelProvider {
  readonly channel = NotificationChannel.EMAIL;

  constructor(
    @Inject(IDENTITY_CONTACT_READ_PORT) private readonly contacts: IIdentityContactReadPort,
    @Inject(EMAIL_TRANSPORT) private readonly transport: IEmailTransport,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(EmailNotificationProvider.name);
  }

  get name(): string {
    return this.transport.name;
  }

  async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (!this.transport.isConfigured()) return { outcome: 'NOT_CONFIGURED' };
    const contact = await this.contacts.emailRecipientOf(request.recipient.userId);
    if (!contact.available) return { outcome: 'FAILED', errorCode: `EMAIL_RECIPIENT_${contact.reason}`, retryable: false };

    const { subject, text } = emailContentOf(request);
    const timedOut: EmailSendResult = { kind: 'TRANSIENT', code: 'EMAIL_TIMEOUT' };
    const result = await withDeadline(
      this.transport
        .send(Object.freeze({ to: contact.email, subject, text, reference: request.notificationId }), EMAIL_DELIVERY_POLICY.requestTimeoutMs)
        .catch((): EmailSendResult => {
          // The exception's message is not logged: it may carry the address or a credential.
          this.logger.warn(`e-mail provider threw for notification ${request.notificationId}`);
          return { kind: 'TRANSIENT', code: 'EMAIL_NETWORK_ERROR' };
        }),
      EMAIL_DELIVERY_POLICY.deliveryDeadlineMs,
      timedOut,
    );

    const code = (c: unknown, fallback: string) => (typeof c === 'string' && PROVIDER_ERROR_CODE.test(c) ? c : fallback);
    switch (result?.kind) {
      case 'SENT':
        return { outcome: 'SENT', providerMessageId: typeof result.messageId === 'string' ? result.messageId : undefined };
      case 'INVALID_RECIPIENT':
        return { outcome: 'FAILED', errorCode: code(result.code, 'EMAIL_INVALID_RECIPIENT'), retryable: false };
      case 'REJECTED':
        return { outcome: 'FAILED', errorCode: code(result.code, 'EMAIL_REJECTED'), retryable: false };
      case 'TRANSIENT':
        return { outcome: 'FAILED', errorCode: code(result.code, 'EMAIL_UNAVAILABLE'), retryable: true };
      case 'NOT_CONFIGURED':
        return { outcome: 'NOT_CONFIGURED' };
      default:
        return { outcome: 'FAILED', errorCode: 'EMAIL_INVALID_RESULT', retryable: true };
    }
  }
}
