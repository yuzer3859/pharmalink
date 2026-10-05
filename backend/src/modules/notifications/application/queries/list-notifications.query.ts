import { Inject, Injectable } from '@nestjs/common';
import {
  INotificationRepository,
  NOTIFICATION_REPOSITORY,
  NotificationRecord,
} from '../../domain/repositories/notification.repository';

export const DEFAULT_NOTIFICATION_PAGE = 1;
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20;
export const MAX_NOTIFICATION_PAGE_SIZE = 100;

export interface ListNotificationsInput {
  recipientUserId: string;
  unread?: boolean;
  page?: number;
  size?: number;
}

export interface NotificationPage {
  items: NotificationRecord[];
  total: number;
  page: number;
  size: number;
}

/** `GET /notifications` — the caller's own in-app notifications, newest first. */
@Injectable()
export class ListNotificationsQuery {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly notifications: INotificationRepository) {}

  async execute(input: ListNotificationsInput): Promise<NotificationPage> {
    // The DTO already bounds these; clamped again so the query is safe from any caller.
    const page =
      input.page !== undefined && Number.isFinite(input.page) && input.page > 0
        ? Math.floor(input.page)
        : DEFAULT_NOTIFICATION_PAGE;
    const size =
      input.size !== undefined && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_NOTIFICATION_PAGE_SIZE)
        : DEFAULT_NOTIFICATION_PAGE_SIZE;

    const { items, total } = await this.notifications.listForRecipient(
      input.recipientUserId,
      { unread: input.unread },
      page,
      size,
    );
    return { items, total, page, size };
  }
}
