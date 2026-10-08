import 'reflect-metadata';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { NotificationDeliveryChannelHealthPortAdapter } from '../../notifications/application/ports/inbound/notification-delivery-channel-health.port';
import { channelsWithProvider } from '../../notifications/application/ports/outbound/notification-channel-provider.port';
import { DELIVERY_QUEUE_POLICY } from '../../notifications/domain/delivery-retry-policy';
import { DeliveryJobStatus, NotificationChannel } from '../../notifications/domain/enums';
import { DeliveryChannelAggregates, IDeliveryChannelHealthRepository } from '../../notifications/domain/repositories/delivery-channel-health.repository';
import { InMemoryNotificationChannelProvider } from '../../notifications/infrastructure/providers/in-memory-notification-channel.provider';
import { StaticNotificationChannelProviderRegistry } from '../../notifications/infrastructure/providers/notification-channel-provider.registry';
import { UnconfiguredSmsTransport } from '../../notifications/infrastructure/sms/unconfigured-sms.transport';
import { AdminDeliveryQueueController } from '../interface/controllers/admin-delivery-queue.controller';
import { toDeliveryChannelHealthResponse } from '../interface/dtos/delivery-channel-health.response';
import { GetDeliveryChannelHealthQuery } from './queries/delivery-channel-health.query';

const { PUSH, SMS, EMAIL } = NotificationChannel;
type Row = { channel: NotificationChannel; status: DeliveryJobStatus; createdAt: Date; leaseExpiresAt: Date | null };

/** `notification_delivery_jobs` in memory, grouped by channel as the adapter's SQL does. */
class Jobs implements IDeliveryChannelHealthRepository {
  rows: Row[] = [];
  seenNow: Date | null = null;
  async channelAggregatesAt(now: Date): Promise<DeliveryChannelAggregates> {
    this.seenNow = now;
    const channels = [...new Set(this.rows.map((r) => r.channel))];
    const min = (ds: Array<Date | null>) => ds.filter((d): d is Date => !!d).sort((a, b) => +a - +b)[0] ?? null;
    const of = (c: NotificationChannel, s: DeliveryJobStatus) => this.rows.filter((r) => r.channel === c && r.status === s);
    const groups = [...new Set(this.rows.map((r) => `${r.channel}|${r.status}`))].map((k) => k.split('|') as [NotificationChannel, DeliveryJobStatus]);
    return {
      byChannelAndStatus: groups.map(([channel, status]) => ({ channel, status, count: of(channel, status).length })),
      // Only channels that have such rows, as GROUP BY returns.
      oldestPendingCreatedAt: channels.filter((c) => of(c, DeliveryJobStatus.PENDING).length).map((c) => ({ channel: c, at: min(of(c, DeliveryJobStatus.PENDING).map((r) => r.createdAt)) })),
      // The shared lapsed-lease rule: PROCESSING with leaseExpiresAt <= now.
      staleProcessing: channels
        .map((c) => ({ channel: c, count: of(c, DeliveryJobStatus.PROCESSING).filter((r) => r.leaseExpiresAt && +r.leaseExpiresAt <= +now).length }))
        .filter((g) => g.count > 0),
      oldestProcessingLeaseExpiresAt: channels.filter((c) => of(c, DeliveryJobStatus.PROCESSING).length).map((c) => ({ channel: c, at: min(of(c, DeliveryJobStatus.PROCESSING).map((r) => r.leaseExpiresAt)) })),
    };
  }
}

describe('Admin notification delivery channel health (application)', () => {
  const LEASE = DELIVERY_QUEUE_POLICY.leaseMs;
  let jobs: Jobs;
  const registry = (...channels: NotificationChannel[]) => new StaticNotificationChannelProviderRegistry(channels.map((c) => new InMemoryNotificationChannelProvider(c)));
  const ago = (ms: number) => new Date(Date.now() - ms);
  const add = (channel: NotificationChannel, status: DeliveryJobStatus, createdAgoMs = 0, claimedAgoMs: number | null = null) =>
    jobs.rows.push({ channel, status, createdAt: ago(createdAgoMs), leaseExpiresAt: claimedAgoMs === null ? null : new Date(Date.now() - claimedAgoMs + LEASE) });
  const snapshot = async (reg = registry(PUSH, EMAIL)) =>
    toDeliveryChannelHealthResponse(await new GetDeliveryChannelHealthQuery(new NotificationDeliveryChannelHealthPortAdapter(jobs, reg)).execute());
  const of = async (channel: NotificationChannel, reg?: StaticNotificationChannelProviderRegistry) => (await snapshot(reg)).channels.find((c) => c.channel === channel)!;

  beforeEach(() => {
    jobs = new Jobs();
  });

  it('an empty queue still returns PUSH, SMS and EMAIL, in that order, with zero counts and null timestamps', async () => {
    const s = await snapshot();
    expect(s.channels.map((c) => c.channel)).toEqual(['PUSH', 'SMS', 'EMAIL']);
    for (const c of s.channels) {
      expect({ ...c, providerConfigured: undefined }).toEqual({
        channel: c.channel,
        providerConfigured: undefined,
        jobs: { total: 0, pending: 0, processing: 0, completed: 0, suppressed: 0, exhausted: 0 },
        backlog: { pendingCount: 0, oldestPendingCreatedAt: null, oldestPendingAgeSeconds: null },
        processing: { processingCount: 0, staleProcessingCount: 0, oldestProcessingStartedAt: null, oldestProcessingAgeSeconds: null },
      });
    }
    expect(jobs.seenNow!.toISOString()).toBe(s.generatedAt);
  });

  it('mixed jobs are separated by channel; every status counted; total is the sum of the five', async () => {
    const plan: Array<[NotificationChannel, DeliveryJobStatus, number]> = [
      [PUSH, DeliveryJobStatus.COMPLETED, 4], [PUSH, DeliveryJobStatus.PENDING, 1], [PUSH, DeliveryJobStatus.SUPPRESSED, 2],
      [SMS, DeliveryJobStatus.PENDING, 6],
      [EMAIL, DeliveryJobStatus.EXHAUSTED, 3], [EMAIL, DeliveryJobStatus.PROCESSING, 2], [EMAIL, DeliveryJobStatus.COMPLETED, 1], [EMAIL, DeliveryJobStatus.PENDING, 1],
    ];
    for (const [c, s, n] of plan) for (let i = 0; i < n; i++) add(c, s, 1_000, s === DeliveryJobStatus.PROCESSING ? 1_000 : null);
    const s = await snapshot();
    expect(Object.fromEntries(s.channels.map((c) => [c.channel, c.jobs]))).toEqual({
      PUSH: { total: 7, pending: 1, processing: 0, completed: 4, suppressed: 2, exhausted: 0 },
      SMS: { total: 6, pending: 6, processing: 0, completed: 0, suppressed: 0, exhausted: 0 },
      EMAIL: { total: 7, pending: 1, processing: 2, completed: 1, suppressed: 0, exhausted: 3 },
    });
    for (const c of s.channels) expect(c.jobs.total).toBe(c.jobs.pending + c.jobs.processing + c.jobs.completed + c.jobs.suppressed + c.jobs.exhausted);
  });

  it('the oldest PENDING timestamp and age are per channel', async () => {
    add(SMS, DeliveryJobStatus.PENDING, 7_200_000);
    add(SMS, DeliveryJobStatus.PENDING, 60_000);
    add(EMAIL, DeliveryJobStatus.PENDING, 90_500);
    add(EMAIL, DeliveryJobStatus.EXHAUSTED, 9_999_000); // older, but not backlog
    const s = await snapshot();
    const t = Date.parse(s.generatedAt);
    const sms = s.channels.find((c) => c.channel === SMS)!;
    const email = s.channels.find((c) => c.channel === EMAIL)!;
    expect(sms.backlog).toEqual({ pendingCount: 2, oldestPendingCreatedAt: jobs.rows[0].createdAt.toISOString(), oldestPendingAgeSeconds: Math.floor((t - +jobs.rows[0].createdAt) / 1000) });
    expect(email.backlog).toEqual({ pendingCount: 1, oldestPendingCreatedAt: jobs.rows[2].createdAt.toISOString(), oldestPendingAgeSeconds: Math.floor((t - +jobs.rows[2].createdAt) / 1000) });
    expect(sms.backlog.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(7_200);
    expect(email.backlog.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(90);
  });

  it('no PENDING jobs on a channel → its pending timestamp and age are null', async () => {
    add(PUSH, DeliveryJobStatus.COMPLETED, 1_000);
    add(SMS, DeliveryJobStatus.PENDING, 1_000);
    expect((await of(PUSH)).backlog).toEqual({ pendingCount: 0, oldestPendingCreatedAt: null, oldestPendingAgeSeconds: null });
  });

  it('processing is per channel; stale uses the lapsed-lease rule; the oldest claim starts at leaseExpiresAt − leaseMs', async () => {
    add(PUSH, DeliveryJobStatus.PROCESSING, 0, LEASE + 60_000); // lapsed a minute ago
    add(PUSH, DeliveryJobStatus.PROCESSING, 0, LEASE); // lapses exactly now (<= now)
    add(PUSH, DeliveryJobStatus.PROCESSING, 0, 10_000); // running
    add(EMAIL, DeliveryJobStatus.PROCESSING, 0, 30_000); // running
    const s = await snapshot();
    const t = Date.parse(s.generatedAt);
    const push = s.channels.find((c) => c.channel === PUSH)!;
    const started = new Date(+jobs.rows[0].leaseExpiresAt! - LEASE);
    expect(push.processing).toEqual({ processingCount: 3, staleProcessingCount: 2, oldestProcessingStartedAt: started.toISOString(), oldestProcessingAgeSeconds: Math.floor((t - +started) / 1000) });
    expect(push.processing.oldestProcessingAgeSeconds).toBeGreaterThanOrEqual((LEASE + 60_000) / 1000);
    expect(s.channels.find((c) => c.channel === EMAIL)!.processing).toMatchObject({ processingCount: 1, staleProcessingCount: 0 });
  });

  it('no PROCESSING jobs on a channel → its processing timestamp and age are null', async () => {
    add(EMAIL, DeliveryJobStatus.PROCESSING, 0, 1_000);
    expect((await of(SMS)).processing).toEqual({ processingCount: 0, staleProcessingCount: 0, oldestProcessingStartedAt: null, oldestProcessingAgeSeconds: null });
  });

  describe('provider readiness', () => {
    it('providerConfigured is exactly "a provider is bound" — the dispatcher’s own gate', async () => {
      const s = await snapshot(registry(PUSH, EMAIL));
      expect(Object.fromEntries(s.channels.map((c) => [c.channel, c.providerConfigured]))).toEqual({ PUSH: true, SMS: false, EMAIL: true });
      expect(Object.fromEntries((await snapshot(registry())).channels.map((c) => [c.channel, c.providerConfigured]))).toEqual({ PUSH: false, SMS: false, EMAIL: false });
      expect(channelsWithProvider(registry(EMAIL))).toEqual([EMAIL]);
    });

    it('SMS: the production transport is never configured, so SMS is false and its jobs are simply counted, still PENDING', async () => {
      expect(new UnconfiguredSmsTransport().isConfigured()).toBe(false);
      add(SMS, DeliveryJobStatus.PENDING, 3_600_000);
      const sms = await of(SMS);
      expect(sms).toMatchObject({ providerConfigured: false, jobs: { pending: 1, total: 1 } });
      expect(channelsWithProvider(registry(PUSH, EMAIL))).not.toContain(SMS);
    });

    it('readiness is a boolean only — no provider name, credential, sender, project or endpoint, even when configured', async () => {
      const s = await snapshot(registry(PUSH, SMS, EMAIL));
      for (const c of s.channels) expect(typeof c.providerConfigured).toBe('boolean');
      expect(JSON.stringify(s)).not.toMatch(/in-memory|fcm|resend|key|secret|sender|from|project|client|endpoint|https?:|@/i);
    });
  });

  it('the response carries exactly the approved fields', async () => {
    add(PUSH, DeliveryJobStatus.PENDING, 1_000);
    add(PUSH, DeliveryJobStatus.PROCESSING, 1_000, 1_000);
    const s = await snapshot();
    expect(Object.keys(s)).toEqual(['generatedAt', 'channels']);
    for (const c of s.channels) {
      expect(Object.keys(c)).toEqual(['channel', 'providerConfigured', 'jobs', 'backlog', 'processing']);
      expect(Object.keys(c.jobs)).toEqual(['total', 'pending', 'processing', 'completed', 'suppressed', 'exhausted']);
      expect(Object.keys(c.backlog)).toEqual(['pendingCount', 'oldestPendingCreatedAt', 'oldestPendingAgeSeconds']);
      expect(Object.keys(c.processing)).toEqual(['processingCount', 'staleProcessingCount', 'oldestProcessingStartedAt', 'oldestProcessingAgeSeconds']);
    }
    expect(JSON.stringify(s)).not.toMatch(/notificationId|recipient|userId|"id"|@|phone|token|title|body|payload|errorDetail|sha256/i);
  });

  describe('authorization', () => {
    it('GET channels on the Work 20 controller, under its class-level notification:queue:read, declared before :id', () => {
      const handler = AdminDeliveryQueueController.prototype.channels;
      expect(Reflect.getMetadata('path', handler)).toBe('channels');
      expect(Reflect.getMetadata('method', handler)).toBe(0); // RequestMethod.GET
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminDeliveryQueueController)).toEqual(['notification:queue:read']);
      const methods = Object.getOwnPropertyNames(AdminDeliveryQueueController.prototype);
      expect(methods.indexOf('channels')).toBeLessThan(methods.indexOf('detail'));
    });

    it('ADMIN allowed; SUPER_ADMIN by wildcard; every other role denied (403); no new permission', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, read: hasPermission(grants, 'notification:queue:read') }).toEqual({ role, read: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(Object.values(ROLE_PERMISSIONS).flat().filter((k) => k.startsWith('notification:queue:')).sort()).toEqual(['notification:queue:manage', 'notification:queue:read']);
    });
  });
});
