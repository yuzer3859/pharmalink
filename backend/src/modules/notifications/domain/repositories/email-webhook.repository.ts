import { NotificationChannel, NotificationStatus } from '../enums';
import { SuppressionReason } from '../suppression';

export const EMAIL_WEBHOOK_REPOSITORY = Symbol('EMAIL_WEBHOOK_REPOSITORY');
export const DESTINATION_SUPPRESSION_REPOSITORY = Symbol('DESTINATION_SUPPRESSION_REPOSITORY');

/** The provider attempt a webhook's message id belongs to. */
export interface EmailAttemptRef {
  notificationId: string;
  attemptNumber: number;
  provider: string | null;
  providerMessageId: string;
}

/** What one verified webhook does — decided by the application, applied atomically here. */
export interface WebhookEffect {
  /** A delivery-history row describing the provider attempt's later state; appended once. */
  receiptAttempt?: {
    ref: EmailAttemptRef;
    status: NotificationStatus.DELIVERED | NotificationStatus.BOUNCED;
    errorCode: string | null;
    occurredAt: Date;
  };
  /** Destinations (already as suppression keys) to suppress on a channel. */
  suppress?: { channel: NotificationChannel; keys: string[]; reason: SuppressionReason };
}

/**
 * Persistence port for provider webhooks (module-13 Work 18), over `notification_webhook_receipts`,
 * `delivery_attempts` (read and append only) and `suppression_list` (insert only).
 */
export interface IEmailWebhookRepository {
  /** The e-mail provider attempt that returned `providerMessageId`, or `null`. */
  findEmailAttempt(providerMessageId: string): Promise<EmailAttemptRef | null>;
  /**
   * In one transaction: records the receipt (provider, eventId) and applies `effect`. A receipt
   * already present — a redelivery, or a concurrent copy that committed first — applies nothing
   * and returns `false`. If anything fails, nothing is kept, so the provider's retry reprocesses.
   */
  applyOnce(receipt: { provider: string; eventId: string; eventType: string }, effect: WebhookEffect): Promise<boolean>;
}

/** Read port for `suppression_list` — the send-time check. */
export interface IDestinationSuppressionRepository {
  isSuppressed(channel: NotificationChannel, key: string): Promise<boolean>;
}
