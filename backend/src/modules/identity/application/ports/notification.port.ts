export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');

export type NotificationChannel = 'SMS' | 'EMAIL' | 'PUSH';

export interface NotificationRequest {
  channel: NotificationChannel;
  to: string;
  template: string;
  data: Record<string, string | number>;
}

/**
 * Outbound-communication port (module-01 §15 / shared-conventions §15). All outbound comms are
 * meant to ultimately route through Module 13 (Notifications); this slice provides a
 * log-only mock adapter so Identity has no direct SMS/email/FCM dependency.
 */
export interface INotificationPort {
  send(request: NotificationRequest): Promise<void>;
}
