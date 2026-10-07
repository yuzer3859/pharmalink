import { Injectable } from '@nestjs/common';
import { DeliveryAttempt as PrismaDeliveryAttempt, NotificationDeliveryJob as PrismaJob } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DeliveryJobStatus, NotificationCategory, NotificationChannel } from '../../domain/enums';
import {
  ClaimedDeliveryJob,
  DeliverableNotification,
  DeliveryJobSettlement,
  INotificationDeliveryRepository,
} from '../../domain/repositories/notification-delivery.repository';

const PENDING = DeliveryJobStatus.PENDING as unknown as PrismaJob['status'];
const PROCESSING = DeliveryJobStatus.PROCESSING as unknown as PrismaJob['status'];

/** Thrown inside `settle`'s transaction to roll it back when the lease is no longer ours. */
class LeaseLost extends Error {}

/**
 * `INotificationDeliveryRepository` over Prisma, on Module 13's own tables: `notifications` is
 * read (a fixed column selection — no payload, dedupe key or event type) and never updated;
 * `notification_delivery_jobs` is claimed and settled with conditional updates; `delivery_attempts`
 * is only inserted into.
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

  private due(now: Date) {
    return [
      { status: PENDING, nextAttemptAt: { lte: now } },
      { status: PROCESSING, leaseExpiresAt: { lte: now } },
    ];
  }

  async findDueJobIds(now: Date, channels: readonly NotificationChannel[], limit: number): Promise<string[]> {
    const rows = await this.prisma.notificationDeliveryJob.findMany({
      where: { channel: { in: channels as unknown as PrismaJob['channel'][] }, OR: this.due(now) },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async claim(jobId: string, now: Date, leaseExpiresAt: Date): Promise<ClaimedDeliveryJob | null> {
    // One UPDATE … WHERE <still due>. Postgres re-checks the WHERE against the committed row after
    // any concurrent writer finishes, so a second worker's identical update matches nothing.
    const { count } = await this.prisma.notificationDeliveryJob.updateMany({
      where: { id: jobId, OR: this.due(now) },
      data: { status: PROCESSING, leaseExpiresAt },
    });
    if (count !== 1) return null;
    const row = await this.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    return {
      id: row.id,
      notificationId: row.notificationId,
      channel: row.channel as unknown as NotificationChannel,
      attemptCount: row.attemptCount,
      leaseExpiresAt,
    };
  }

  async settle(job: ClaimedDeliveryJob, s: DeliveryJobSettlement): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.notificationDeliveryJob.updateMany({
          // The fence: only the holder of this exact lease may settle the job.
          where: { id: job.id, status: PROCESSING, leaseExpiresAt: job.leaseExpiresAt },
          data: {
            status: s.status as unknown as PrismaJob['status'],
            attemptCount: s.attemptCount,
            leaseExpiresAt: null,
            lastErrorCode: s.lastErrorCode,
            completedAt: s.completedAt,
            ...(s.nextAttemptAt ? { nextAttemptAt: s.nextAttemptAt } : {}),
          },
        });
        if (count !== 1) throw new LeaseLost();
        if (s.attempt) {
          await tx.deliveryAttempt.create({
            data: {
              notificationId: job.notificationId,
              attemptNumber: s.attempt.attemptNumber,
              channel: job.channel as unknown as PrismaDeliveryAttempt['channel'],
              provider: s.attempt.provider,
              providerMsgId: s.attempt.providerMessageId,
              status: s.attempt.status as unknown as PrismaDeliveryAttempt['status'],
              errorCode: s.attempt.errorCode,
              errorDetail: null,
            },
          });
        }
      });
      return true;
    } catch (e) {
      if (e instanceof LeaseLost) return false;
      throw e;
    }
  }
}
