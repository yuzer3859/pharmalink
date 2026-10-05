import { Inject, Injectable } from '@nestjs/common';
import { NotificationStatus } from '../../domain/enums';
import { NotificationErrors } from '../../domain/errors';
import {
  INotificationRepository,
  NOTIFICATION_REPOSITORY,
  NotificationRecord,
} from '../../domain/repositories/notification.repository';

export interface MarkNotificationReadInput {
  /** Always the authenticated principal — never taken from the request body or query. */
  recipientUserId: string;
  notificationId: string;
}

/**
 * `POST /notifications/:id/read`. Idempotent: reading a read notification is a no-op that
 * answers the same. Another user's notification is `NOT_FOUND`, exactly as an unknown id is.
 */
@Injectable()
export class MarkNotificationReadCommand {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly notifications: INotificationRepository) {}

  async execute(input: MarkNotificationReadInput): Promise<NotificationRecord> {
    const found = await this.notifications.findForRecipient(input.notificationId, input.recipientUserId);
    if (!found) {
      throw NotificationErrors.notFound();
    }
    if (found.status !== NotificationStatus.READ) {
      await this.notifications.markRead(found.id, input.recipientUserId);
    }
    return { ...found, status: NotificationStatus.READ };
  }
}
