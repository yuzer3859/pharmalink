import { Inject, Injectable } from '@nestjs/common';
import { INotificationRepository, NOTIFICATION_REPOSITORY } from '../../domain/repositories/notification.repository';

/** `POST /notifications/read-all`. Idempotent: a second call finds nothing unread and changes nothing. */
@Injectable()
export class MarkAllNotificationsReadCommand {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly notifications: INotificationRepository) {}

  async execute(recipientUserId: string): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(recipientUserId) };
  }
}
