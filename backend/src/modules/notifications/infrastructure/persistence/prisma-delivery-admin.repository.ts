import { Injectable } from '@nestjs/common';
import { NotificationDeliveryJob as PrismaJob, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DeliveryJobStatus, NotificationChannel, NotificationStatus } from '../../domain/enums';
import {
  DeliveryAttemptAdminRecord,
  DeliveryJobCounts,
  DeliveryJobRecord,
  DeliveryJobSearchCriteria,
  IDeliveryAdminRepository,
} from '../../domain/repositories/delivery-admin.repository';

type Channel = PrismaJob['channel'];
type JobStatus = PrismaJob['status'];

const toJob = (r: PrismaJob): DeliveryJobRecord => ({
  id: r.id,
  notificationId: r.notificationId,
  channel: r.channel as unknown as NotificationChannel,
  status: r.status as unknown as DeliveryJobStatus,
  attemptCount: r.attemptCount,
  nextAttemptAt: r.nextAttemptAt,
  leaseExpiresAt: r.leaseExpiresAt,
  lastErrorCode: r.lastErrorCode,
  completedAt: r.completedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const range = (from?: Date, to?: Date) =>
  from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

/**
 * `IDeliveryAdminRepository` over Prisma (module-13 Work 20) — reads only. Never joins
 * `notifications` (no title, body, payload or recipient), never selects `errorDetail`; counts are
 * `GROUP BY` in the database. Served by the existing indexes: `(status, nextAttemptAt)` for the
 * status filters, the unique `(notificationId, channel)` for a notification's jobs and its
 * attempts' lookup by notification id.
 */
@Injectable()
export class PrismaDeliveryAdminRepository implements IDeliveryAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listJobs(c: DeliveryJobSearchCriteria, page: number, size: number): Promise<{ items: DeliveryJobRecord[]; total: number }> {
    const where: Prisma.NotificationDeliveryJobWhereInput = {
      ...(c.channel ? { channel: c.channel as unknown as Channel } : {}),
      ...(c.status ? { status: c.status as unknown as JobStatus } : {}),
      ...(c.notificationId ? { notificationId: c.notificationId } : {}),
      ...(range(c.createdFrom, c.createdTo) ? { createdAt: range(c.createdFrom, c.createdTo) } : {}),
      ...(range(c.nextAttemptFrom, c.nextAttemptTo) ? { nextAttemptAt: range(c.nextAttemptFrom, c.nextAttemptTo) } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notificationDeliveryJob.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * size, take: size }),
      this.prisma.notificationDeliveryJob.count({ where }),
    ]);
    return { items: rows.map(toJob), total };
  }

  async findJob(id: string): Promise<DeliveryJobRecord | null> {
    const row = await this.prisma.notificationDeliveryJob.findUnique({ where: { id } });
    return row ? toJob(row) : null;
  }

  async attemptsOf(notificationId: string, channel: NotificationChannel): Promise<DeliveryAttemptAdminRecord[]> {
    const rows = await this.prisma.deliveryAttempt.findMany({
      where: { notificationId, channel: channel as unknown as Channel },
      orderBy: [{ attemptNumber: 'asc' }, { attemptedAt: 'asc' }, { id: 'asc' }],
      // Explicit selection: `errorDetail` is never read.
      select: { id: true, attemptNumber: true, channel: true, provider: true, providerMsgId: true, status: true, errorCode: true, attemptedAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      attemptNumber: r.attemptNumber,
      channel: r.channel as unknown as NotificationChannel,
      provider: r.provider,
      providerMessageId: r.providerMsgId,
      status: r.status as unknown as NotificationStatus,
      errorCode: r.errorCode,
      attemptedAt: r.attemptedAt,
    }));
  }

  async countJobs(): Promise<DeliveryJobCounts> {
    const [byStatus, byChannel] = await this.prisma.$transaction([
      this.prisma.notificationDeliveryJob.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.notificationDeliveryJob.groupBy({ by: ['channel'], _count: { _all: true }, orderBy: { channel: 'asc' } }),
    ]);
    const statusCounts = byStatus.map((g) => ({ status: g.status as unknown as DeliveryJobStatus, count: (g._count as { _all: number })._all }));
    return {
      total: statusCounts.reduce((n, s) => n + s.count, 0),
      byStatus: statusCounts,
      byChannel: byChannel.map((g) => ({ channel: g.channel as unknown as NotificationChannel, count: (g._count as { _all: number })._all })),
    };
  }
}
