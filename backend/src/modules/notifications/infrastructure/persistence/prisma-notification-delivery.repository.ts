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
import {
  IDeliveryRequeueRepository,
  MANUALLY_REQUEUEABLE_STATUS,
  RequeueOutcome,
  requeuedJobState,
} from '../../domain/repositories/delivery-requeue.repository';
import {
  IDeliveryLeaseReleaseRepository,
  LeaseReleaseOutcome,
  releasedLeaseJobState,
} from '../../domain/repositories/delivery-lease-release.repository';
import { lapsedLeaseWhere } from './delivery-lease';
import { toDeliveryJobRecord } from './prisma-delivery-admin.repository';

const PENDING = DeliveryJobStatus.PENDING as unknown as PrismaJob['status'];
const PROCESSING = DeliveryJobStatus.PROCESSING as unknown as PrismaJob['status'];
const REQUEUEABLE = MANUALLY_REQUEUEABLE_STATUS as unknown as PrismaJob['status'];

/** Thrown inside `settle`'s transaction to roll it back when the lease is no longer ours. */
class LeaseLost extends Error {}

/**
 * `INotificationDeliveryRepository` over Prisma, on Module 13's own tables: `notifications` is
 * read (a fixed column selection — no payload, dedupe key or event type) and never updated;
 * `notification_delivery_jobs` is claimed and settled with conditional updates; `delivery_attempts`
 * is only inserted into. Also the operator's manual requeue (module-16 Work 21) and lease release
 * (Work 23), so every transition of a job's status lives in this one adapter.
 */
@Injectable()
export class PrismaNotificationDeliveryRepository
  implements INotificationDeliveryRepository, IDeliveryRequeueRepository, IDeliveryLeaseReleaseRepository
{
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
      lapsedLeaseWhere(now),
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

  async requeueExhausted(jobId: string, now: Date): Promise<RequeueOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const next = requeuedJobState(now);
      // One UPDATE … WHERE status = EXHAUSTED: a concurrent requeue blocks on the row, then
      // re-checks the WHERE against the committed PENDING row and matches nothing. The dispatcher
      // never claims an EXHAUSTED job, so it cannot race this either.
      const { count } = await tx.notificationDeliveryJob.updateMany({
        where: { id: jobId, status: REQUEUEABLE },
        data: { status: next.status as unknown as PrismaJob['status'], nextAttemptAt: next.nextAttemptAt, leaseExpiresAt: next.leaseExpiresAt, completedAt: next.completedAt },
      });
      // Read inside the same transaction: the row as this update left it, before any claim.
      const row = await tx.notificationDeliveryJob.findUnique({ where: { id: jobId } });
      if (!row) return { kind: 'NOT_FOUND' };
      if (count === 1) return { kind: 'REQUEUED', job: toDeliveryJobRecord(row) };
      return { kind: 'NOT_REQUEUEABLE', status: row.status as unknown as DeliveryJobStatus };
    });
  }

  async releaseLapsedLease(jobId: string, now: Date): Promise<LeaseReleaseOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const seen = await tx.notificationDeliveryJob.findUnique({ where: { id: jobId }, select: { leaseExpiresAt: true } });
      if (!seen) return { kind: 'NOT_FOUND' };
      const next = releasedLeaseJobState(now);
      // The decision is this UPDATE's predicate, not the read above: still PROCESSING, lease lapsed
      // at `now` (the dispatcher's own rule), and still the lease that was read — the same fencing
      // `settle` uses. A dispatcher re-claim (new lease), a worker's settle (no longer PROCESSING)
      // or another release (PENDING) committed first leaves nothing to match; one committing after
      // finds this row PENDING and fails its own predicate.
      const { count } = await tx.notificationDeliveryJob.updateMany({
        where: { id: jobId, AND: [lapsedLeaseWhere(now), { leaseExpiresAt: seen.leaseExpiresAt }] },
        data: { status: next.status as unknown as PrismaJob['status'], nextAttemptAt: next.nextAttemptAt, leaseExpiresAt: next.leaseExpiresAt, completedAt: next.completedAt },
      });
      const row = await tx.notificationDeliveryJob.findUniqueOrThrow({ where: { id: jobId } });
      if (count === 1) return { kind: 'RELEASED', job: toDeliveryJobRecord(row), previousLeaseExpiresAt: seen.leaseExpiresAt! };
      return { kind: 'NOT_RELEASABLE', status: row.status as unknown as DeliveryJobStatus };
    });
  }
}
