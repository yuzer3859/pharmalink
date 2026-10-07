import { Injectable } from '@nestjs/common';
import { Notification as PrismaNotification, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../../domain/enums';
import {
  INotificationRepository,
  NewNotification,
  NotificationListFilter,
  NotificationRecord,
} from '../../domain/repositories/notification.repository';
import { NotificationData } from '../../domain/templates';

const IN_APP = NotificationChannel.IN_APP as unknown as PrismaNotification['channel'];
const READ = NotificationStatus.READ as unknown as PrismaNotification['status'];

function toRecord(row: PrismaNotification): NotificationRecord {
  return {
    id: row.id,
    recipientUserId: row.recipientUserId,
    category: row.category as unknown as NotificationCategory,
    templateCode: row.templateCode,
    data: (row.payload ?? {}) as NotificationData,
    title: row.renderedTitle ?? '',
    body: row.renderedBody ?? '',
    status: row.status as unknown as NotificationStatus,
    createdAt: row.createdAt,
  };
}

/**
 * `INotificationRepository` over Prisma, on Module 13's own `notifications` table — and, at insert
 * time only, its `notification_delivery_jobs` (Work 13).
 */
@Injectable()
export class PrismaNotificationRepository implements INotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertIfAbsent(n: NewNotification, deliveryChannels: readonly NotificationChannel[] = []): Promise<boolean> {
    if (deliveryChannels.length === 0) return this.insertNotification(this.prisma, n);
    // The notification and its delivery jobs commit together: a crash between the two cannot leave
    // a notification whose external delivery was silently never queued.
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.insertNotification(tx, n))) return false;
      const { id } = await tx.notification.findUniqueOrThrow({ where: { dedupeKey: n.dedupeKey }, select: { id: true } });
      await tx.notificationDeliveryJob.createMany({
        data: deliveryChannels.map((channel) => ({ notificationId: id, channel: channel as unknown as PrismaNotification['channel'] })),
        skipDuplicates: true,
      });
      return true;
    });
  }

  private async insertNotification(db: Prisma.TransactionClient, n: NewNotification): Promise<boolean> {
    // `skipDuplicates` is `INSERT … ON CONFLICT DO NOTHING`: the unique `dedupeKey` index decides,
    // atomically, so two concurrent deliveries of one event write one row and neither fails.
    const { count } = await db.notification.createMany({
      data: [
        {
          recipientUserId: n.recipientUserId,
          category: n.category as unknown as PrismaNotification['category'],
          channel: n.channel as unknown as PrismaNotification['channel'],
          templateCode: n.templateCode,
          eventType: n.eventType,
          dedupeKey: n.dedupeKey,
          payload: n.data as Prisma.InputJsonValue,
          renderedTitle: n.title,
          renderedBody: n.body,
          status: n.status as unknown as PrismaNotification['status'],
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async listForRecipient(
    recipientUserId: string,
    filter: NotificationListFilter,
    page: number,
    size: number,
  ): Promise<{ items: NotificationRecord[]; total: number }> {
    const where: Prisma.NotificationWhereInput = { recipientUserId, channel: IN_APP };
    if (filter.unread === true) where.status = { not: READ };
    if (filter.unread === false) where.status = READ;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        // Newest first; `id` breaks ties so a page boundary never repeats or skips a row.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { items: rows.map(toRecord), total };
  }

  countUnread(recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientUserId, channel: IN_APP, status: { not: READ } },
    });
  }

  async findForRecipient(id: string, recipientUserId: string): Promise<NotificationRecord | null> {
    const row = await this.prisma.notification.findFirst({
      where: { id, recipientUserId, channel: IN_APP },
    });
    return row ? toRecord(row) : null;
  }

  async markRead(id: string, recipientUserId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, recipientUserId, channel: IN_APP, status: { not: READ } },
      data: { status: READ },
    });
  }

  async markAllRead(recipientUserId: string): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { recipientUserId, channel: IN_APP, status: { not: READ } },
      data: { status: READ },
    });
    return count;
  }
}
