import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { NotificationDeliveryLeaseReleasePortAdapter } from '../../notifications/application/ports/inbound/notification-delivery-lease-release.port';
import { DELIVERY_QUEUE_POLICY } from '../../notifications/domain/delivery-retry-policy';
import { DeliveryJobStatus, NotificationChannel } from '../../notifications/domain/enums';
import { DeliveryJobRecord } from '../../notifications/domain/repositories/delivery-admin.repository';
import {
  IDeliveryLeaseReleaseRepository,
  LeaseReleaseOutcome,
  releasedLeaseJobState,
} from '../../notifications/domain/repositories/delivery-lease-release.repository';
import { requeuedJobState } from '../../notifications/domain/repositories/delivery-requeue.repository';
import { InMemoryNotificationChannelProvider } from '../../notifications/infrastructure/providers/in-memory-notification-channel.provider';
import { AdminDeliveryLeaseController } from '../interface/controllers/admin-delivery-lease.controller';
import { ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED, ReleaseDeliveryLeaseCommand } from './commands/release-delivery-lease.command';

/**
 * `notification_delivery_jobs` in memory with the adapter's semantics: the transition applies only
 * while the row is still PROCESSING under a lapsed lease (`leaseExpiresAt <= now`) and still holds
 * the lease that was read — the conditional UPDATE.
 */
class Jobs implements IDeliveryLeaseReleaseRepository {
  rows: DeliveryJobRecord[] = [];
  writes = 0;
  async releaseLapsedLease(jobId: string, now: Date): Promise<LeaseReleaseOutcome> {
    const seen = this.rows.find((r) => r.id === jobId);
    if (!seen) return { kind: 'NOT_FOUND' };
    const lease = seen.leaseExpiresAt;
    // Yield, as the round-trip between the read and the UPDATE would, so concurrent callers interleave.
    await Promise.resolve();
    const row = this.rows.find((r) => r.id === jobId)!;
    if (row.status === DeliveryJobStatus.PROCESSING && row.leaseExpiresAt && +row.leaseExpiresAt <= +now && +row.leaseExpiresAt === +lease!) {
      Object.assign(row, releasedLeaseJobState(now), { updatedAt: now });
      this.writes++;
      return { kind: 'RELEASED', job: { ...row }, previousLeaseExpiresAt: lease! };
    }
    return { kind: 'NOT_RELEASABLE', status: row.status };
  }
}

const logger = () => ({ setContext: () => undefined, log: () => undefined, warn: () => undefined }) as unknown as AppLogger;

describe('Admin notification delivery lease release (application)', () => {
  const ADMIN_ID = randomUUID();
  const LEASE = DELIVERY_QUEUE_POLICY.leaseMs;
  let jobs: Jobs;
  let audits: Array<Record<string, unknown>>;
  let command: ReleaseDeliveryLeaseCommand;
  const audit = { record: async (e: Record<string, unknown>) => void audits.push(e) } as unknown as AuditService;
  const longAgo = new Date('2026-10-01T00:00:00Z');
  /** A job; PROCESSING ones are claimed `claimedAgoMs` ago, so their lease is that claim + leaseMs. */
  const job = (status: DeliveryJobStatus, claimedAgoMs = LEASE + 60_000): DeliveryJobRecord => {
    const row: DeliveryJobRecord = {
      id: randomUUID(),
      notificationId: randomUUID(),
      channel: NotificationChannel.PUSH,
      status,
      attemptCount: 2,
      nextAttemptAt: longAgo,
      leaseExpiresAt: status === DeliveryJobStatus.PROCESSING ? new Date(Date.now() - claimedAgoMs + LEASE) : null,
      lastErrorCode: 'PUSH_UNAVAILABLE',
      completedAt: [DeliveryJobStatus.EXHAUSTED, DeliveryJobStatus.COMPLETED, DeliveryJobStatus.SUPPRESSED].includes(status) ? longAgo : null,
      createdAt: longAgo,
      updatedAt: longAgo,
    };
    jobs.rows.push(row);
    return row;
  };
  const release = (jobId: string) => command.execute({ actorUserId: ADMIN_ID, jobId, ip: '203.0.113.7' });
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
    command = new ReleaseDeliveryLeaseCommand(new NotificationDeliveryLeaseReleasePortAdapter(jobs, logger()), audit);
  });

  describe('state transition (Module 13’s rule, applied through its port)', () => {
    it('PROCESSING with a lapsed lease → PENDING; same job; attemptCount and lastErrorCode kept', async () => {
      const stale = job(DeliveryJobStatus.PROCESSING);
      const res = await release(stale.id);
      expect(res).toMatchObject({
        id: stale.id,
        notificationId: stale.notificationId,
        channel: NotificationChannel.PUSH,
        status: DeliveryJobStatus.PENDING,
        attemptCount: 2,
        lastErrorCode: 'PUSH_UNAVAILABLE',
      });
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]).toEqual(res);
    });

    it('nextAttemptAt is reset to now — due on the scheduler’s next tick', async () => {
      const stale = job(DeliveryJobStatus.PROCESSING);
      const before = Date.now();
      const res = await release(stale.id);
      expect(+res.nextAttemptAt).toBeGreaterThanOrEqual(before);
      expect(+res.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    });

    it('the lease and completion are cleared — the same "back in the queue" state as a Work 21 requeue, no new state', async () => {
      const res = await release(job(DeliveryJobStatus.PROCESSING).id);
      expect(res).toMatchObject({ leaseExpiresAt: null, completedAt: null });
      const now = new Date();
      expect(releasedLeaseJobState(now)).toEqual(requeuedJobState(now));
      expect(releasedLeaseJobState(now)).toEqual({ status: DeliveryJobStatus.PENDING, nextAttemptAt: now, leaseExpiresAt: null, completedAt: null });
    });

    it('a lease that lapses exactly now is releasable (leaseExpiresAt <= now)', async () => {
      const edge = job(DeliveryJobStatus.PROCESSING, LEASE);
      expect(await codeOf(release(edge.id))).toBe('resolved');
    });

    it('PROCESSING under a live lease → 409; unchanged; not audited', async () => {
      const live = job(DeliveryJobStatus.PROCESSING, 10_000);
      const snapshot = { ...live };
      expect(await codeOf(release(live.id))).toBe('409 CONFLICT');
      expect(jobs.rows[0]).toEqual(snapshot);
      expect(audits).toEqual([]);
    });

    for (const status of [DeliveryJobStatus.PENDING, DeliveryJobStatus.COMPLETED, DeliveryJobStatus.SUPPRESSED, DeliveryJobStatus.EXHAUSTED]) {
      it(`${status} → 409; unchanged; not audited`, async () => {
        const row = job(status);
        const snapshot = { ...row };
        expect(await codeOf(release(row.id))).toBe('409 CONFLICT');
        expect(jobs.rows[0]).toEqual(snapshot);
        expect(jobs.writes).toBe(0);
        expect(audits).toEqual([]);
      });
    }

    it('unknown job → 404; nothing written; not audited', async () => {
      job(DeliveryJobStatus.PROCESSING);
      expect(await codeOf(release(randomUUID()))).toBe('404 NOT_FOUND');
      expect(jobs.writes).toBe(0);
      expect(audits).toEqual([]);
    });

    it('concurrent releases of one stale job: exactly one transition and one audit; the rest are 409', async () => {
      const stale = job(DeliveryJobStatus.PROCESSING);
      const results = await Promise.all([1, 2, 3].map(() => codeOf(release(stale.id))));
      expect(results.sort()).toEqual(['409 CONFLICT', '409 CONFLICT', 'resolved']);
      expect(jobs.writes).toBe(1);
      expect(audits).toHaveLength(1);
    });

    it('a release racing a dispatcher re-claim (new lease) loses: 409, no write, no audit', async () => {
      const stale = job(DeliveryJobStatus.PROCESSING);
      const pending = codeOf(release(stale.id));
      // The dispatcher claims it between the read and the UPDATE: a fresh lease.
      jobs.rows[0].leaseExpiresAt = new Date(Date.now() + LEASE);
      expect(await pending).toBe('409 CONFLICT');
      expect(jobs.writes).toBe(0);
      expect(audits).toEqual([]);
    });

    it('the HTTP path calls no provider: the command depends on the port and the audit only', async () => {
      const provider = new InMemoryNotificationChannelProvider(NotificationChannel.PUSH);
      await release(job(DeliveryJobStatus.PROCESSING).id);
      expect(provider.delivered).toEqual([]);
      expect(Reflect.getMetadata('design:paramtypes', ReleaseDeliveryLeaseCommand)).toEqual([Object, AuditService]);
      expect(Reflect.getMetadata('design:paramtypes', AdminDeliveryLeaseController)).toEqual([ReleaseDeliveryLeaseCommand]);
    });
  });

  describe('audit', () => {
    it('a successful release records exactly one ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED, operational metadata only', async () => {
      const stale = job(DeliveryJobStatus.PROCESSING);
      const lease = stale.leaseExpiresAt!;
      await release(stale.id);
      expect(audits).toEqual([
        {
          actorUserId: ADMIN_ID,
          action: ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED,
          resourceType: 'NotificationDeliveryJob',
          resourceId: stale.id,
          context: {
            deliveryJobId: stale.id,
            channel: 'PUSH',
            previousStatus: 'PROCESSING',
            newStatus: 'PENDING',
            previousLeaseExpiresAt: lease.toISOString(),
            leaseExpired: true,
            attemptCount: 2,
            lastErrorCode: 'PUSH_UNAVAILABLE',
          },
          ip: '203.0.113.7',
        },
      ]);
      expect(ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED).toBe('ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED');
      expect(JSON.stringify(audits)).not.toMatch(/notificationId|recipient|email|phone|token|title|body|payload|providerMsgId|errorDetail|sha256/i);
    });
  });

  describe('authorization', () => {
    it('the route is POST :id/release and takes notification:queue:manage — the Work 21 key, not queue:read', () => {
      const handler = AdminDeliveryLeaseController.prototype.releaseOne;
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['notification:queue:manage']);
      expect(Reflect.getMetadata('path', handler)).toBe(':id/release');
      expect(Reflect.getMetadata('method', handler)).toBe(1); // RequestMethod.POST
      expect(Reflect.getMetadata('path', AdminDeliveryLeaseController)).toBe('admin/notifications/delivery');
    });

    it('ADMIN holds it; SUPER_ADMIN by wildcard; every other role is refused (403); queue:read alone never implies it', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, manage: hasPermission(grants, 'notification:queue:manage') }).toEqual({ role, manage: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['notification:queue:read'], 'notification:queue:manage')).toBe(false);
    });
  });
});
