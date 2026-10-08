import 'reflect-metadata';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { NotificationDeliveryHealthPortAdapter } from '../../notifications/application/ports/inbound/notification-delivery-health.port';
import { DELIVERY_QUEUE_POLICY } from '../../notifications/domain/delivery-retry-policy';
import { DeliveryJobStatus } from '../../notifications/domain/enums';
import { DeliveryHealthAggregates, IDeliveryHealthRepository } from '../../notifications/domain/repositories/delivery-health.repository';
import { AdminDeliveryQueueController } from '../interface/controllers/admin-delivery-queue.controller';
import { toDeliveryQueueHealthResponse } from '../interface/dtos/delivery-queue-health.response';
import { GetDeliveryQueueHealthQuery } from './queries/delivery-queue-health.query';

type Row = { status: DeliveryJobStatus; createdAt: Date; leaseExpiresAt: Date | null };

/** `notification_delivery_jobs` in memory, aggregated as the adapter's SQL does. */
class Jobs implements IDeliveryHealthRepository {
  rows: Row[] = [];
  seenNow: Date | null = null;
  async aggregatesAt(now: Date): Promise<DeliveryHealthAggregates> {
    this.seenNow = now;
    const of = (s: DeliveryJobStatus) => this.rows.filter((r) => r.status === s);
    const min = (ds: Array<Date | null>) => ds.filter((d): d is Date => !!d).sort((a, b) => +a - +b)[0] ?? null;
    const statuses = [...new Set(this.rows.map((r) => r.status))];
    return {
      byStatus: statuses.map((status) => ({ status, count: of(status).length })),
      oldestPendingCreatedAt: min(of(DeliveryJobStatus.PENDING).map((r) => r.createdAt)),
      // The dispatcher's reclaim rule: PROCESSING with leaseExpiresAt <= now.
      staleProcessingCount: of(DeliveryJobStatus.PROCESSING).filter((r) => r.leaseExpiresAt && +r.leaseExpiresAt <= +now).length,
      oldestProcessingLeaseExpiresAt: min(of(DeliveryJobStatus.PROCESSING).map((r) => r.leaseExpiresAt)),
    };
  }
}

describe('Admin notification delivery queue health (application)', () => {
  const LEASE = DELIVERY_QUEUE_POLICY.leaseMs;
  let jobs: Jobs;
  let query: GetDeliveryQueueHealthQuery;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const add = (status: DeliveryJobStatus, createdAgoMs = 0, claimedAgoMs: number | null = null) =>
    jobs.rows.push({
      status,
      createdAt: ago(createdAgoMs),
      // A claim at time t sets leaseExpiresAt = t + leaseMs — exactly what the dispatcher does.
      leaseExpiresAt: claimedAgoMs === null ? null : new Date(Date.now() - claimedAgoMs + LEASE),
    });
  const health = async () => toDeliveryQueueHealthResponse(await query.execute());

  beforeEach(() => {
    jobs = new Jobs();
    query = new GetDeliveryQueueHealthQuery(new NotificationDeliveryHealthPortAdapter(jobs));
  });

  it('a healthy empty queue: zero everywhere, every timestamp and age null', async () => {
    const h = await health();
    expect(h).toEqual({
      generatedAt: expect.any(String),
      queue: { total: 0, pending: 0, processing: 0, completed: 0, suppressed: 0, exhausted: 0 },
      backlog: { pendingCount: 0, oldestPendingCreatedAt: null, oldestPendingAgeSeconds: null },
      processing: { processingCount: 0, staleProcessingCount: 0, oldestProcessingStartedAt: null, oldestProcessingAgeSeconds: null },
    });
    expect(jobs.seenNow!.toISOString()).toBe(h.generatedAt);
  });

  it('mixed statuses: one count per Work 13 status, total their sum', async () => {
    for (const [s, n] of [[DeliveryJobStatus.PENDING, 3], [DeliveryJobStatus.PROCESSING, 2], [DeliveryJobStatus.COMPLETED, 5], [DeliveryJobStatus.SUPPRESSED, 1], [DeliveryJobStatus.EXHAUSTED, 4]] as const) {
      for (let i = 0; i < n; i++) add(s, 1_000, s === DeliveryJobStatus.PROCESSING ? 1_000 : null);
    }
    expect((await health()).queue).toEqual({ total: 15, pending: 3, processing: 2, completed: 5, suppressed: 1, exhausted: 4 });
  });

  it('backlog: the PENDING count, the oldest PENDING createdAt and its age in whole seconds', async () => {
    add(DeliveryJobStatus.PENDING, 30_000);
    add(DeliveryJobStatus.PENDING, 90_500);
    add(DeliveryJobStatus.PENDING, 5_000);
    // Older jobs in other states never count as backlog.
    add(DeliveryJobStatus.EXHAUSTED, 999_000);
    add(DeliveryJobStatus.COMPLETED, 999_000);
    const h = await health();
    const oldest = jobs.rows[1].createdAt;
    expect(h.backlog).toEqual({
      pendingCount: 3,
      oldestPendingCreatedAt: oldest.toISOString(),
      oldestPendingAgeSeconds: Math.floor((Date.parse(h.generatedAt) - +oldest) / 1000),
    });
    expect(h.backlog.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(90);
  });

  it('no PENDING jobs → the backlog timestamp and age are null', async () => {
    add(DeliveryJobStatus.COMPLETED, 10_000);
    add(DeliveryJobStatus.PROCESSING, 10_000, 1_000);
    expect((await health()).backlog).toEqual({ pendingCount: 0, oldestPendingCreatedAt: null, oldestPendingAgeSeconds: null });
  });

  it('processing: the count, and the oldest claim’s start (leaseExpiresAt − leaseMs) and age', async () => {
    add(DeliveryJobStatus.PROCESSING, 600_000, 10_000);
    add(DeliveryJobStatus.PROCESSING, 600_000, 45_000);
    const h = await health();
    const startedAt = new Date(+jobs.rows[1].leaseExpiresAt! - LEASE);
    expect(h.processing).toEqual({
      processingCount: 2,
      staleProcessingCount: 0,
      oldestProcessingStartedAt: startedAt.toISOString(),
      oldestProcessingAgeSeconds: Math.floor((Date.parse(h.generatedAt) - +startedAt) / 1000),
    });
    expect(h.processing.oldestProcessingAgeSeconds).toBeGreaterThanOrEqual(45);
  });

  it(`stale processing uses the real lease (${LEASE / 1000} s): claimed longer ago than the lease → stale; within it → not`, async () => {
    add(DeliveryJobStatus.PROCESSING, 0, LEASE + 60_000); // lease lapsed a minute ago
    add(DeliveryJobStatus.PROCESSING, 0, LEASE + 1_000); // lapsed a second ago
    add(DeliveryJobStatus.PROCESSING, 0, LEASE - 30_000); // 30 s of lease left
    add(DeliveryJobStatus.PROCESSING, 0, 1_000); // just claimed
    add(DeliveryJobStatus.PENDING, 0); // not processing at all
    const h = await health();
    expect(h.processing.processingCount).toBe(4);
    expect(h.processing.staleProcessingCount).toBe(2);
    expect(h.processing.oldestProcessingAgeSeconds).toBeGreaterThanOrEqual((LEASE + 60_000) / 1000);
    expect(LEASE).toBe(120_000);
  });

  it('no PROCESSING jobs → the processing timestamp and age are null', async () => {
    add(DeliveryJobStatus.PENDING, 1_000);
    expect((await health()).processing).toEqual({ processingCount: 0, staleProcessingCount: 0, oldestProcessingStartedAt: null, oldestProcessingAgeSeconds: null });
  });

  it('the response carries exactly the approved aggregate fields — no id, recipient, content or provider data', async () => {
    add(DeliveryJobStatus.PENDING, 1_000);
    add(DeliveryJobStatus.PROCESSING, 1_000, 1_000);
    const h = await health();
    expect(Object.keys(h)).toEqual(['generatedAt', 'queue', 'backlog', 'processing']);
    expect(Object.keys(h.queue)).toEqual(['total', 'pending', 'processing', 'completed', 'suppressed', 'exhausted']);
    expect(Object.keys(h.backlog)).toEqual(['pendingCount', 'oldestPendingCreatedAt', 'oldestPendingAgeSeconds']);
    expect(Object.keys(h.processing)).toEqual(['processingCount', 'staleProcessingCount', 'oldestProcessingStartedAt', 'oldestProcessingAgeSeconds']);
    expect(JSON.stringify(h)).not.toMatch(/notificationId|recipient|userId|"id"|email|phone|token|title|body|payload|provider|errorDetail|sha256/i);
  });

  describe('authorization', () => {
    it('GET health on the Work 20 controller, under its class-level notification:queue:read; no own permission', () => {
      const handler = AdminDeliveryQueueController.prototype.health;
      expect(Reflect.getMetadata('path', handler)).toBe('health');
      expect(Reflect.getMetadata('method', handler)).toBe(0); // RequestMethod.GET
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminDeliveryQueueController)).toEqual(['notification:queue:read']);
      // Declared before `:id`, so `health` is never parsed as a job id.
      const methods = Object.getOwnPropertyNames(AdminDeliveryQueueController.prototype);
      expect(methods.indexOf('health')).toBeLessThan(methods.indexOf('detail'));
    });

    it('ADMIN is allowed; SUPER_ADMIN by wildcard; every other role is denied (403)', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, read: hasPermission(grants, 'notification:queue:read') }).toEqual({ role, read: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
    });

    it('no new permission: queue:manage is still ADMIN-only, and a user’s own notification keys never imply the read', () => {
      expect(Object.entries(ROLE_PERMISSIONS).filter(([, g]) => g.includes('notification:queue:manage')).map(([r]) => r)).toEqual(['ADMIN']);
      expect(hasPermission(['notification:read:own', 'notification:manage:own'], 'notification:queue:read')).toBe(false);
    });
  });
});
