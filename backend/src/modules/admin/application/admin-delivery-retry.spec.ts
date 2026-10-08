import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { NotificationDeliveryRetryPortAdapter } from '../../notifications/application/ports/inbound/notification-delivery-retry.port';
import { retryDelayAfter } from '../../notifications/domain/delivery-retry-policy';
import { DeliveryJobStatus, NotificationChannel } from '../../notifications/domain/enums';
import { DeliveryJobRecord } from '../../notifications/domain/repositories/delivery-admin.repository';
import {
  IDeliveryRequeueRepository,
  MANUALLY_REQUEUEABLE_STATUS,
  RequeueOutcome,
  requeuedJobState,
} from '../../notifications/domain/repositories/delivery-requeue.repository';
import { AdminDeliveryQueueController } from '../interface/controllers/admin-delivery-queue.controller';
import { AdminDeliveryRetryController } from '../interface/controllers/admin-delivery-retry.controller';
import { ADMIN_NOTIFICATION_DELIVERY_RETRIED, RetryDeliveryJobCommand } from './commands/retry-delivery-job.command';

/**
 * `notification_delivery_jobs` in memory with the adapter's semantics: the transition applies only
 * while the row is still `EXHAUSTED` (the conditional UPDATE), read back in the same step.
 */
class Jobs implements IDeliveryRequeueRepository {
  rows: DeliveryJobRecord[] = [];
  writes = 0;
  async requeueExhausted(jobId: string, now: Date): Promise<RequeueOutcome> {
    // Yield first, as a round-trip would, so concurrent callers genuinely interleave.
    await Promise.resolve();
    const row = this.rows.find((r) => r.id === jobId);
    if (!row) return { kind: 'NOT_FOUND' };
    if (row.status !== MANUALLY_REQUEUEABLE_STATUS) return { kind: 'NOT_REQUEUEABLE', status: row.status };
    Object.assign(row, requeuedJobState(now), { updatedAt: now });
    this.writes++;
    return { kind: 'REQUEUED', job: { ...row } };
  }
}

const logger = () => ({ setContext: () => undefined, log: () => undefined, warn: () => undefined }) as unknown as AppLogger;

describe('Admin notification delivery retry (application)', () => {
  const ADMIN_ID = randomUUID();
  let jobs: Jobs;
  let audits: Array<Record<string, unknown>>;
  let command: RetryDeliveryJobCommand;
  const audit = { record: async (e: Record<string, unknown>) => void audits.push(e) } as unknown as AuditService;
  const longAgo = new Date('2026-10-01T00:00:00Z');
  const job = (status: DeliveryJobStatus, over: Partial<DeliveryJobRecord> = {}): DeliveryJobRecord => {
    const row: DeliveryJobRecord = {
      id: randomUUID(),
      notificationId: randomUUID(),
      channel: NotificationChannel.EMAIL,
      status,
      attemptCount: status === DeliveryJobStatus.EXHAUSTED ? 5 : 0,
      nextAttemptAt: longAgo,
      leaseExpiresAt: status === DeliveryJobStatus.PROCESSING ? new Date(Date.now() + 120_000) : null,
      lastErrorCode: status === DeliveryJobStatus.EXHAUSTED ? 'EMAIL_UNAVAILABLE' : null,
      completedAt: [DeliveryJobStatus.EXHAUSTED, DeliveryJobStatus.COMPLETED, DeliveryJobStatus.SUPPRESSED].includes(status) ? longAgo : null,
      createdAt: longAgo,
      updatedAt: longAgo,
      ...over,
    };
    jobs.rows.push(row);
    return row;
  };
  const retry = (jobId: string) => command.execute({ actorUserId: ADMIN_ID, jobId, ip: '203.0.113.9' });
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };

  beforeEach(() => {
    jobs = new Jobs();
    audits = [];
    command = new RetryDeliveryJobCommand(new NotificationDeliveryRetryPortAdapter(jobs, logger()), audit);
  });

  describe('state transition (Module 13’s rule, applied through its port)', () => {
    it('EXHAUSTED → PENDING, due now, no lease or completion; same job, attempt count and last error kept', async () => {
      const exhausted = job(DeliveryJobStatus.EXHAUSTED);
      const res = await retry(exhausted.id);
      expect(res).toMatchObject({
        id: exhausted.id,
        notificationId: exhausted.notificationId,
        channel: NotificationChannel.EMAIL,
        status: DeliveryJobStatus.PENDING,
        attemptCount: 5,
        lastErrorCode: 'EMAIL_UNAVAILABLE',
        leaseExpiresAt: null,
        completedAt: null,
      });
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]).toEqual(res);
    });

    it('resets nextAttemptAt to now, so the scheduler’s next tick finds the job due', async () => {
      const exhausted = job(DeliveryJobStatus.EXHAUSTED);
      const before = Date.now();
      const res = await retry(exhausted.id);
      expect(+res.nextAttemptAt).toBeGreaterThanOrEqual(before);
      expect(+res.nextAttemptAt).toBeLessThanOrEqual(Date.now());
      // `findDueJobIds`: PENDING with nextAttemptAt <= now.
      expect(res.status === DeliveryJobStatus.PENDING && +res.nextAttemptAt <= Date.now()).toBe(true);
    });

    it('a requeue is one more provider attempt, not a fresh budget: the next attempt is 6 and a failure there is terminal', () => {
      expect(requeuedJobState(new Date())).not.toHaveProperty('attemptCount');
      expect(retryDelayAfter(5 + 1)).toBeNull();
    });

    it('unknown job → 404, nothing written, nothing audited', async () => {
      job(DeliveryJobStatus.EXHAUSTED);
      expect(await codeOf(retry(randomUUID()))).toBe('404 NOT_FOUND');
      expect(jobs.writes).toBe(0);
      expect(audits).toEqual([]);
    });

    for (const status of [DeliveryJobStatus.PENDING, DeliveryJobStatus.PROCESSING, DeliveryJobStatus.COMPLETED, DeliveryJobStatus.SUPPRESSED]) {
      it(`${status} cannot be retried → 409; the job is unchanged and no retry is audited`, async () => {
        const row = job(status);
        const snapshot = { ...row };
        expect(await codeOf(retry(row.id))).toBe('409 CONFLICT');
        expect(jobs.rows[0]).toEqual(snapshot);
        expect(jobs.writes).toBe(0);
        expect(audits).toEqual([]);
      });
    }

    it('two concurrent retries of one EXHAUSTED job: exactly one transition, one success, one audit; the other is 409', async () => {
      const exhausted = job(DeliveryJobStatus.EXHAUSTED);
      const results = await Promise.all([codeOf(retry(exhausted.id)), codeOf(retry(exhausted.id)), codeOf(retry(exhausted.id))]);
      expect(results.sort()).toEqual(['409 CONFLICT', '409 CONFLICT', 'resolved']);
      expect(jobs.writes).toBe(1);
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].status).toBe(DeliveryJobStatus.PENDING);
      expect(audits).toHaveLength(1);
    });

    it('a second retry after the first succeeded is 409 — the job is already PENDING', async () => {
      const exhausted = job(DeliveryJobStatus.EXHAUSTED);
      await retry(exhausted.id);
      expect(await codeOf(retry(exhausted.id))).toBe('409 CONFLICT');
      expect(audits).toHaveLength(1);
    });
  });

  describe('audit', () => {
    it('a successful retry records ADMIN_NOTIFICATION_DELIVERY_RETRIED with operational metadata only', async () => {
      const exhausted = job(DeliveryJobStatus.EXHAUSTED, { channel: NotificationChannel.PUSH, lastErrorCode: 'PUSH_UNAVAILABLE' });
      await retry(exhausted.id);
      expect(audits).toEqual([
        {
          actorUserId: ADMIN_ID,
          action: ADMIN_NOTIFICATION_DELIVERY_RETRIED,
          resourceType: 'NotificationDeliveryJob',
          resourceId: exhausted.id,
          context: {
            deliveryJobId: exhausted.id,
            channel: 'PUSH',
            previousStatus: 'EXHAUSTED',
            newStatus: 'PENDING',
            attemptCount: 5,
            lastErrorCode: 'PUSH_UNAVAILABLE',
          },
          ip: '203.0.113.9',
        },
      ]);
      expect(ADMIN_NOTIFICATION_DELIVERY_RETRIED).toBe('ADMIN_NOTIFICATION_DELIVERY_RETRIED');
      // No notification id, recipient, destination, content, provider id or error detail.
      expect(JSON.stringify(audits)).not.toMatch(/notificationId|recipient|email|phone|token|title|body|payload|providerMsgId|errorDetail|sha256/i);
    });
  });

  describe('authorization', () => {
    it('the retry route is POST :id/retry and takes notification:queue:manage — not notification:queue:read', () => {
      const handler = AdminDeliveryRetryController.prototype.retryOne;
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['notification:queue:manage']);
      expect(Reflect.getMetadata('path', handler)).toBe(':id/retry');
      expect(Reflect.getMetadata('method', handler)).toBe(1); // RequestMethod.POST
      expect(Reflect.getMetadata('path', AdminDeliveryRetryController)).toBe('admin/notifications/delivery');
      // The Work 20 read controller stays read-only and read-permissioned.
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminDeliveryQueueController)).toEqual(['notification:queue:read']);
    });

    it('ADMIN holds notification:queue:manage; SUPER_ADMIN by wildcard; every other role is refused (403)', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, manage: hasPermission(grants, 'notification:queue:manage') }).toEqual({ role, manage: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(ROLE_PERMISSIONS.ADMIN).toContain('notification:queue:manage');
      expect(ROLE_PERMISSIONS.SUPER_ADMIN).toEqual(['*']);
    });

    it('holding notification:queue:read (or a user’s own notification keys) never implies manage', () => {
      expect(hasPermission(['notification:queue:read'], 'notification:queue:manage')).toBe(false);
      expect(hasPermission(['notification:read:own', 'notification:manage:own'], 'notification:queue:manage')).toBe(false);
    });
  });
});
