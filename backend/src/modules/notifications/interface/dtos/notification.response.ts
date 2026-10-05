import { NotificationStatus } from '../../domain/enums';
import { NotificationRecord } from '../../domain/repositories/notification.repository';
import { NotificationPage } from '../../application/queries/list-notifications.query';

/**
 * One in-app notification as its owner sees it. The recipient is not echoed back (it is the
 * caller), and neither is the dedupe key, the source event type or anything of the event itself
 * beyond the allow-listed `data`.
 */
export interface NotificationResponse {
  id: string;
  /** The template code — a stable key a client can switch on (icon, deep link). */
  type: string | null;
  category: string;
  title: string;
  body: string;
  data: Record<string, string | number | null>;
  read: boolean;
  createdAt: string;
}

export interface NotificationListResponse {
  items: NotificationResponse[];
  total: number;
  page: number;
  size: number;
}

// Explicit allow-list, never a spread of the stored row.
export function toNotificationResponse(n: NotificationRecord): NotificationResponse {
  return {
    id: n.id,
    type: n.templateCode,
    category: n.category,
    title: n.title,
    body: n.body,
    data: { ...n.data },
    read: n.status === NotificationStatus.READ,
    createdAt: n.createdAt.toISOString(),
  };
}

export function toNotificationListResponse(page: NotificationPage): NotificationListResponse {
  return {
    items: page.items.map(toNotificationResponse),
    total: page.total,
    page: page.page,
    size: page.size,
  };
}
