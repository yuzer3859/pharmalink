import { Inject, Injectable } from '@nestjs/common';
import { INotificationRepository, NOTIFICATION_REPOSITORY } from '../../domain/repositories/notification.repository';

/** `GET /notifications/unread-count` — the badge number for the caller's own inbox. */
@Injectable()
export class GetUnreadCountQuery {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly notifications: INotificationRepository) {}

  async execute(recipientUserId: string): Promise<{ unread: number }> {
    return { unread: await this.notifications.countUnread(recipientUserId) };
  }
}
