import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_CONTACT_READ_PORT,
  IIdentityContactReadPort,
} from '../../../identity/application/ports/inbound/identity-contact-read.port';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { NotificationChannel, NotificationStatus } from '../../domain/enums';
import {
  EMAIL_WEBHOOK_REPOSITORY,
  IEmailWebhookRepository,
  WebhookEffect,
} from '../../domain/repositories/email-webhook.repository';
import { SuppressionReason, suppressionKeyOf } from '../../domain/suppression';

/**
 * One verified e-mail provider webhook, already reduced by the interface layer to what this module
 * acts on — provider-neutral, no payload.
 */
export interface EmailDeliveryReport {
  provider: string;
  /** The provider's delivery id for the webhook itself (Resend: `svix-id`) — the dedupe key. */
  eventId: string;
  /** The provider's event type, recorded on the receipt. */
  eventType: string;
  kind: 'DELIVERED' | 'DELAYED' | 'BOUNCED' | 'COMPLAINED' | 'IGNORED';
  /** The message id the provider returned at send time (Resend: `data.email_id`). */
  providerMessageId: string | null;
  /** Impacted recipients as reported; used only to derive suppression keys, never stored. */
  recipients: string[];
  /** For BOUNCED: whether the provider says the failure is permanent. */
  permanent: boolean;
  occurredAt: Date | null;
}

export type EmailDeliveryReportOutcome = 'APPLIED' | 'DUPLICATE' | 'UNMATCHED' | 'IGNORED';

/** `delivery_attempts.errorCode` values written for receipts. */
export const EmailReceiptCode = {
  BOUNCED: 'EMAIL_BOUNCED',
  SOFT_BOUNCED: 'EMAIL_SOFT_BOUNCED',
  COMPLAINED: 'EMAIL_COMPLAINED',
} as const;

/**
 * Applies an e-mail provider's later report about a sent message (module-13 Work 18). Webhooks
 * update delivery infrastructure only: they never create a notification, a delivery job or a
 * resend, and never change the notification or its job.
 *
 *     DELIVERED   → history row DELIVERED for the SENT attempt it reports on
 *     DELAYED     → acknowledged only (neither delivered nor failed; no status models "delayed")
 *     BOUNCED     → history row BOUNCED; permanent → EMAIL_BOUNCED + destination suppressed,
 *                   otherwise EMAIL_SOFT_BOUNCED, not suppressed
 *     COMPLAINED  → history row BOUNCED / EMAIL_COMPLAINED + destination suppressed
 *     unmatched message id, unknown type → acknowledged, nothing written but the receipt
 *
 * Every report — acted on or not — is recorded once by its event id, in the same transaction as
 * its effects: a redelivery or a concurrent copy is a `DUPLICATE` with no effect, and a failure
 * leaves nothing, so the provider's own retry reprocesses it. A destination is suppressed only for
 * a message this platform sent. Not audited.
 */
@Injectable()
export class ProcessEmailDeliveryReportCommand {
  constructor(
    @Inject(EMAIL_WEBHOOK_REPOSITORY) private readonly webhooks: IEmailWebhookRepository,
    @Inject(IDENTITY_CONTACT_READ_PORT) private readonly contacts: IIdentityContactReadPort,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(ProcessEmailDeliveryReportCommand.name);
  }

  async execute(report: EmailDeliveryReport): Promise<{ outcome: EmailDeliveryReportOutcome }> {
    const receipt = { provider: report.provider, eventId: report.eventId, eventType: report.eventType };
    const once = async (effect: WebhookEffect, outcome: EmailDeliveryReportOutcome) =>
      ({ outcome: (await this.webhooks.applyOnce(receipt, effect)) ? outcome : 'DUPLICATE' }) as const;

    if (report.kind === 'IGNORED' || !report.providerMessageId) return once({}, 'IGNORED');
    const ref = await this.webhooks.findEmailAttempt(report.providerMessageId);
    if (!ref) {
      this.logger.warn(`${report.provider} ${report.eventType} ${report.eventId} matches no e-mail this platform sent; acknowledged`);
      return once({}, 'UNMATCHED');
    }
    if (report.kind === 'DELAYED') return once({}, 'APPLIED');

    const occurredAt = report.occurredAt ?? new Date();
    const keys = () => [
      ...new Set(
        report.recipients
          .map((r) => this.contacts.canonicalEmail(r))
          .filter((r): r is string => r !== null)
          .map(suppressionKeyOf),
      ),
    ];

    switch (report.kind) {
      case 'DELIVERED':
        return once({ receiptAttempt: { ref, status: NotificationStatus.DELIVERED, errorCode: null, occurredAt } }, 'APPLIED');
      case 'BOUNCED':
        return report.permanent
          ? once(
              {
                receiptAttempt: { ref, status: NotificationStatus.BOUNCED, errorCode: EmailReceiptCode.BOUNCED, occurredAt },
                suppress: { channel: NotificationChannel.EMAIL, keys: keys(), reason: SuppressionReason.PERMANENT_BOUNCE },
              },
              'APPLIED',
            )
          : once({ receiptAttempt: { ref, status: NotificationStatus.BOUNCED, errorCode: EmailReceiptCode.SOFT_BOUNCED, occurredAt } }, 'APPLIED');
      case 'COMPLAINED':
        return once(
          {
            receiptAttempt: { ref, status: NotificationStatus.BOUNCED, errorCode: EmailReceiptCode.COMPLAINED, occurredAt },
            suppress: { channel: NotificationChannel.EMAIL, keys: keys(), reason: SuppressionReason.COMPLAINT },
          },
          'APPLIED',
        );
    }
  }
}
