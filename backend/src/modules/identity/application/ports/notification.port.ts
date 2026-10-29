export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');

export type NotificationChannel = 'SMS' | 'EMAIL' | 'PUSH';

export interface NotificationRequest {
  channel: NotificationChannel;
  to: string;
  template: string;
  data: Record<string, string | number>;
}

/**
 * Why a message was not delivered. Carries no address, content or provider response.
 * - `NOT_CONFIGURED` — the channel has no working provider (SMS today; e-mail without Resend).
 * - `FAILED` — the provider was asked and did not accept the message (timeout, outage, rejection).
 */
export class NotificationUndeliverableError extends Error {
  constructor(
    readonly channel: NotificationChannel,
    readonly reason: 'NOT_CONFIGURED' | 'FAILED',
  ) {
    super(`${channel} notification not delivered: ${reason}`);
    this.name = 'NotificationUndeliverableError';
  }
}

/**
 * Module 01's outbound-communication port (module-01 §15): OTP codes and account-security notices.
 *
 * Messages are sent synchronously, never queued, so an OTP code is never written to an outbox row,
 * a notification payload or a delivery job (Work 62). `send` resolves only when the provider has
 * accepted the message; otherwise it rejects with `NotificationUndeliverableError`. Callers must
 * never report a code as sent when it rejects.
 */
export interface INotificationPort {
  /** Whether `channel` has a configured provider. Says nothing about whether a send will succeed. */
  canDeliver(channel: NotificationChannel): boolean;
  send(request: NotificationRequest): Promise<void>;
}
