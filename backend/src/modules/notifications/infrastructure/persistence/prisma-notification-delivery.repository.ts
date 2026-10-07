import { Injectable } from '@nestjs/common';
import { DeliveryAttempt as PrismaDeliveryAttempt } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../../domain/enums';
import {
  DeliverableNotification,
  DeliveryAttemptRecord,
  INotificationDeliveryRepository,
  NewDeliveryAttempt,
} from '../../domain/repositories/notification-delivery.repository';

/**
 * `INotificationDeliveryRepository` over Prisma, on Module 13's own tables: `notifications` is
 * read (a fixed column selection — no payload, dedupe key or event type) and never updated;
 * `delivery_attempts` is only inserted into.
 */
@Injectable()
export class PrismaNotificationDeliveryRepository implements INotificationDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findDeliverable(notificationId: string): Promise<DeliverableNotification | null> {
    const row = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true, recipientUserId: true, category: true, channel: true, renderedTitle: true, renderedBody: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      recipientUserId: row.recipientUserId,
      category: row.category as unknown as NotificationCategory,
      channel: row.channel as unknown as NotificationChannel,
      title: row.renderedTitle ?? '',
      body: row.renderedBody ?? '',
    };
  }

  async listAttempts(notificationId: string): Promise<DeliveryAttemptRecord[]> {
    const rows = await this.prisma.deliveryAttempt.findMany({
      where: { notificationId },
      orderBy: [{ attemptNumber: 'asc' }, { attemptedAt: 'asc' }],
    });
    return rows.map((r) => ({
      notificationId: r.notificationId,
      attemptNumber: r.attemptNumber,
      channel: r.channel as unknown as NotificationChannel,
      provider: r.provider,
      providerMessageId: r.providerMsgId,
      status: r.status as unknown as NotificationStatus,
      errorCode: r.errorCode,
      errorDetail: r.errorDetail,
      attemptedAt: r.attemptedAt,
    }));
  }

  async recordAttempt(a: NewDeliveryAttempt): Promise<void> {
    await this.prisma.deliveryAttempt.create({
      data: {
        notificationId: a.notificationId,
        attemptNumber: a.attemptNumber,
        channel: a.channel as unknown as PrismaDeliveryAttempt['channel'],
        provider: a.provider,
        providerMsgId: a.providerMessageId,
        status: a.status as unknown as PrismaDeliveryAttempt['status'],
        errorCode: a.errorCode,
        errorDetail: a.errorDetail,
      },
    });
  }
}
