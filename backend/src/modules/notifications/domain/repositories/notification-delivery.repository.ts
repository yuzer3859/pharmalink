import { NotificationCategory, NotificationChannel, NotificationStatus } from '../enums';

export const NOTIFICATION_DELIVERY_REPOSITORY = Symbol('NOTIFICATION_DELIVERY_REPOSITORY');

/**
 * What the delivery pipeline reads of a stored notification: who it is for, what it says and its
 * category. Not the event payload, dedupe key or source event type.
 */
export interface DeliverableNotification {
  id: string;
  recipientUserId: string;
  category: NotificationCategory;
  /** The row's own channel — `IN_APP` for every notification Works 01–10 write. */
  channel: NotificationChannel;
  title: string;
  body: string;
}

/** One `delivery_attempts` row. */
export interface DeliveryAttemptRecord {
  notificationId: string;
  attemptNumber: number;
  channel: NotificationChannel;
  provider: string | null;
  providerMessageId: string | null;
  status: NotificationStatus;
  errorCode: string | null;
  errorDetail: string | null;
  attemptedAt: Date;
}

export type NewDeliveryAttempt = Omit<DeliveryAttemptRecord, 'attemptedAt'>;

/**
 * Persistence port for delivery (module-13 Work 12), over `notifications` (read only) and
 * `delivery_attempts` (append only). Internal: used by `NotificationDeliveryService`, never by a
 * controller — which is why, unlike the inbox repository, it may read a notification by id.
 */
export interface INotificationDeliveryRepository {
  findDeliverable(notificationId: string): Promise<DeliverableNotification | null>;
  /** Every attempt for the notification, by attempt number. */
  listAttempts(notificationId: string): Promise<DeliveryAttemptRecord[]>;
  recordAttempt(attempt: NewDeliveryAttempt): Promise<void>;
}
