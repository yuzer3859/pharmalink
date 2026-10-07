import { Injectable } from '@nestjs/common';
import { EmailDeliveryReport } from '../../application/commands/process-email-delivery-report.command';
import { EmailWebhookReading, IEmailWebhookReader, RawEmailWebhook } from '../../application/ports/outbound/email-webhook-reader.port';
import { ResendConfig } from '../email/resend.config';
import { eventTypeOf, parseResendEmailEvent } from './resend-webhook.parser';
import { verifySvixSignature } from './svix-signature';

const KIND: Record<string, EmailDeliveryReport['kind']> = {
  'email.delivered': 'DELIVERED',
  'email.delivery_delayed': 'DELAYED',
  'email.bounced': 'BOUNCED',
  'email.complained': 'COMPLAINED',
};

/**
 * `IEmailWebhookReader` for Resend (module-13 Work 18): `RESEND_WEBHOOK_SECRET` from `ResendConfig`,
 * the Svix signature over the raw bytes, then `parseResendEmailEvent`. Nothing is parsed before the
 * signature verifies; the `svix-id` header becomes the receipt's event id.
 */
@Injectable()
export class ResendWebhookReader implements IEmailWebhookReader {
  constructor(private readonly config: ResendConfig) {}

  read({ rawBody, headers }: RawEmailWebhook): EmailWebhookReading {
    const secret = this.config.webhookSecret();
    if (!secret) return { status: 'NOT_CONFIGURED' };
    const svixId = headers['svix-id'];
    const verified = verifySvixSignature(secret, {
      id: svixId,
      timestamp: headers['svix-timestamp'],
      signature: headers['svix-signature'],
      rawBody,
    });
    if (!verified || !svixId || svixId.length > 200 || !rawBody) return { status: 'INVALID_SIGNATURE' };

    const event = parseResendEmailEvent(rawBody);
    return {
      status: 'VERIFIED',
      report: {
        provider: 'resend',
        eventId: svixId,
        eventType: event?.type ?? eventTypeOf(rawBody),
        kind: event ? KIND[event.type] : 'IGNORED',
        providerMessageId: event?.emailId ?? null,
        recipients: event?.to ?? [],
        permanent: event?.bounceType === 'Permanent',
        occurredAt: event?.occurredAt ?? null,
      },
    };
  }
}
