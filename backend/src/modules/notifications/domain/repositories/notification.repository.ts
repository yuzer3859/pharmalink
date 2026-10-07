import { NotificationCategory, NotificationChannel, NotificationStatus } from '../enums';
import { NotificationData, NotificationTemplateCode } from '../templates';

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

/** A notification to write. `dedupeKey` is the idempotency key; the row's unique index enforces it. */
export interface NewNotification {
  recipientUserId: string;
  category: NotificationCategory;
  channel: NotificationChannel;
  templateCode: NotificationTemplateCode;
  /** The source event's type — an opaque reference to what caused the notification. */
  eventType: string;
  dedupeKey: string;
  data: NotificationData;
  title: string;
  body: string;
  status: NotificationStatus;
}

/** A stored in-app notification, as its owner sees it. */
export interface NotificationRecord {
  id: string;
  recipientUserId: string;
  category: NotificationCategory;
  templateCode: string | null;
  data: NotificationData;
  title: string;
  body: string;
  status: NotificationStatus;
  createdAt: Date;
}

export interface NotificationListFilter {
  /** `true` = unread only, `false` = read only, absent = both. */
  unread?: boolean;
}

/**
 * Persistence port for in-app notifications (module-13). Every read and write is scoped to one
 * recipient and to the `IN_APP` channel: there is no method that reaches a notification by id
 * alone, so an ownership check cannot be forgotten by a caller.
 */
export interface INotificationRepository {
  /**
   * Inserts unless a row with the same `dedupeKey` exists. Returns `true` when a row was
   * written, `false` when the key was already present. The insert is `ON CONFLICT DO NOTHING`, so
   * concurrent duplicate deliveries cannot both insert.
   *
   * Work 13: when the row is written, one `PENDING` delivery job per `deliveryChannels` entry is
   * written in the same transaction — never for a duplicate, so a redelivered event queues nothing
   * twice (the jobs' unique (notificationId, channel) index backs that up).
   */
  insertIfAbsent(notification: NewNotification, deliveryChannels?: readonly NotificationChannel[]): Promise<boolean>;
  listForRecipient(
    recipientUserId: string,
    filter: NotificationListFilter,
    page: number,
    size: number,
  ): Promise<{ items: NotificationRecord[]; total: number }>;
  countUnread(recipientUserId: string): Promise<number>;
  /** The recipient's notification, or `null` when it does not exist or belongs to someone else. */
  findForRecipient(id: string, recipientUserId: string): Promise<NotificationRecord | null>;
  /** Marks one of the recipient's notifications `READ`; a no-op when it already is. */
  markRead(id: string, recipientUserId: string): Promise<void>;
  /** Marks every unread notification of the recipient `READ`. Returns how many changed. */
  markAllRead(recipientUserId: string): Promise<number>;
}
