import { EmailDeliveryReport } from '../../commands/process-email-delivery-report.command';

export const EMAIL_WEBHOOK_READER = Symbol('EMAIL_WEBHOOK_READER');

/** One inbound provider webhook as received: the exact bytes and the request headers (lower-cased). */
export interface RawEmailWebhook {
  rawBody: Buffer | undefined;
  headers: Record<string, string | undefined>;
}

export type EmailWebhookReading =
  /** No signing secret configured — refuse everything. */
  | { status: 'NOT_CONFIGURED' }
  /** Signature, headers or timestamp invalid — refuse, process nothing. */
  | { status: 'INVALID_SIGNATURE' }
  /** Authentic; reduced to what Module 13 acts on. */
  | { status: 'VERIFIED'; report: EmailDeliveryReport };

/**
 * Authenticates and reads an e-mail provider's webhook (module-13 Work 18). The provider's
 * signature scheme, secret and payload format live behind this port, in infrastructure
 * (`ResendWebhookReader`); the controller and the application see only the outcome.
 */
export interface IEmailWebhookReader {
  read(webhook: RawEmailWebhook): EmailWebhookReading;
}
