import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import {
  INotificationChannelProvider,
  INotificationChannelProviderRegistry,
  NOTIFICATION_CHANNEL_PROVIDER_REGISTRY,
} from '../../src/modules/notifications/application/ports/outbound/notification-channel-provider.port';
import { NotificationDeliveryDispatcher } from '../../src/modules/notifications/application/services/notification-delivery.dispatcher';
import { DELIVERY_QUEUE_POLICY } from '../../src/modules/notifications/domain/delivery-retry-policy';
import { NotificationChannel } from '../../src/modules/notifications/domain/enums';
import { InMemoryNotificationChannelProvider } from '../../src/modules/notifications/infrastructure/providers/in-memory-notification-channel.provider';
import { NOTIFICATION_DELIVERY_INTERVAL } from '../../src/modules/notifications/infrastructure/scheduling/notification-delivery.scheduler';
import { auth, body, createUserWithRole, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const CHANNELS = '/admin/notifications/delivery/channels';
const LEASE = DELIVERY_QUEUE_POLICY.leaseMs;
type User = RegisteredUser & Tokens;
type Channel = {
  channel: string;
  providerConfigured: boolean;
  jobs: Record<'total' | 'pending' | 'processing' | 'completed' | 'suppressed' | 'exhausted', number>;
  backlog: { pendingCount: number; oldestPendingCreatedAt: string | null; oldestPendingAgeSeconds: number | null };
  processing: { processingCount: number; staleProcessingCount: number; oldestProcessingStartedAt: string | null; oldestProcessingAgeSeconds: number | null };
};
type Snapshot = { generatedAt: string; channels: Channel[] };

class ScriptedRegistry implements INotificationChannelProviderRegistry {
  providers = new Map<NotificationChannel, INotificationChannelProvider>();
  use(...providers: INotificationChannelProvider[]) {
    this.providers = new Map(providers.map((p) => [p.channel, p]));
  }
  providerFor(c: NotificationChannel) {
    return this.providers.get(c) ?? null;
  }
}

/**
 * Module 16 Work 24 against real PostgreSQL: per-channel queue health and provider readiness. The
 * queue is filled by the real path (Module 01 events, the Work 13 dispatcher, in-memory providers for
 * PUSH and EMAIL, none for SMS — as in production today); claims are then placed at known instants,
 * exactly as `claim` writes them (lease = claim time + leaseMs).
 */
describe('Admin notification delivery channel health (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const registry = new ScriptedRegistry();
  let admin: User;
  let seeded: { smsOldest: Date; emailOldest: Date; pushStaleLease: Date; emailLiveLease: Date; smsJob: string };

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: NOTIFICATION_CHANNEL_PROVIDER_REGISTRY, useValue: registry }]);
    dispatcher = ctx.app.get(NotificationDeliveryDispatcher);
    // The test drives the dispatcher by hand; the 5 s interval would race the assertions.
    ctx.app.get(SchedulerRegistry).deleteInterval(NOTIFICATION_DELIVERY_INTERVAL);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  async function newUser(): Promise<User> {
    const r = await registerAndVerify(ctx);
    return { ...r, ...(await login(ctx, r.phone, r.password)) };
  }
  async function suspend(u: User): Promise<string> {
    await request(ctx.server).post(`/admin/users/${u.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await ctx.drainOutbox();
    return (await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: u.userId, templateCode: 'ACCOUNT_SUSPENDED' } })).id;
  }
  const where = (notificationId: string, channel: string) => ({ notificationId_channel: { notificationId, channel: channel as never } });
  const jobOf = (notificationId: string, channel: string) => ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: where(notificationId, channel) });
  const get = (token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(CHANNELS);
    return token ? r.set(...auth(token)) : r;
  };
  const snapshot = async () => body(await get().expect(200)) as unknown as Snapshot;
  const claimed = (claimedAgoMs: number) => new Date(Date.now() - claimedAgoMs + LEASE);

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH), new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL, 'FAILED', 'EMAIL_UNAVAILABLE'));

    // U1: PUSH completes, EMAIL fails five times (EXHAUSTED), SMS waits (no provider) → PENDING.
    const n1 = await suspend(await newUser());
    let now = new Date(Date.now() + 1_000);
    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatchDue(now);
      now = new Date(Math.max(+(await jobOf(n1, 'EMAIL')).nextAttemptAt, +now) + 1);
    }
    // U2: PUSH claimed 3 min ago (lease lapsed), EMAIL claimed 30 s ago (lease running).
    const n2 = await suspend(await newUser());
    const pushStaleLease = claimed(LEASE + 60_000);
    const emailLiveLease = claimed(30_000);
    await ctx.prisma.notificationDeliveryJob.update({ where: where(n2, 'PUSH'), data: { status: 'PROCESSING', leaseExpiresAt: pushStaleLease } });
    await ctx.prisma.notificationDeliveryJob.update({ where: where(n2, 'EMAIL'), data: { status: 'PROCESSING', leaseExpiresAt: emailLiveLease } });
    // U3: queued, never dispatched. Backdate its EMAIL (10 min) and U2's SMS (2 h) to fix the oldest backlog per channel.
    const n3 = await suspend(await newUser());
    const smsOldest = new Date(Date.now() - 7_200_000);
    const emailOldest = new Date(Date.now() - 600_000);
    await ctx.prisma.notificationDeliveryJob.update({ where: where(n2, 'SMS'), data: { createdAt: smsOldest } });
    await ctx.prisma.notificationDeliveryJob.update({ where: where(n3, 'EMAIL'), data: { createdAt: emailOldest } });
    seeded = { smsOldest, emailOldest, pushStaleLease, emailLiveLease, smsJob: (await jobOf(n2, 'SMS')).id };
  });

  it('200 for ADMIN with PUSH, SMS and EMAIL; per-channel counts match the database exactly', async () => {
    const s = await snapshot();
    expect(s.channels.map((c) => c.channel)).toEqual(['PUSH', 'SMS', 'EMAIL']);
    const db = await ctx.prisma.notificationDeliveryJob.findMany();
    for (const c of s.channels) {
      const rows = db.filter((j) => j.channel === c.channel);
      const n = (status: string) => rows.filter((j) => j.status === status).length;
      expect({ channel: c.channel, jobs: c.jobs }).toEqual({
        channel: c.channel,
        jobs: { total: rows.length, pending: n('PENDING'), processing: n('PROCESSING'), completed: n('COMPLETED'), suppressed: n('SUPPRESSED'), exhausted: n('EXHAUSTED') },
      });
    }
    const by = Object.fromEntries(s.channels.map((c) => [c.channel, c]));
    expect(by.PUSH.jobs).toMatchObject({ completed: 1, processing: 1 });
    expect(by.SMS.jobs).toMatchObject({ pending: 3, processing: 0, completed: 0, suppressed: 0, exhausted: 0, total: 3 });
    expect(by.EMAIL.jobs).toMatchObject({ exhausted: 1, processing: 1 });
  });

  it('backlog and processing figures are channel-specific; stale uses the lapsed-lease rule', async () => {
    const s = await snapshot();
    const t = Date.parse(s.generatedAt);
    const by = Object.fromEntries(s.channels.map((c) => [c.channel, c]));
    const age = (d: Date) => Math.floor((t - +d) / 1000);

    expect(by.SMS.backlog).toEqual({ pendingCount: 3, oldestPendingCreatedAt: seeded.smsOldest.toISOString(), oldestPendingAgeSeconds: age(seeded.smsOldest) });
    expect(by.EMAIL.backlog).toEqual({ pendingCount: by.EMAIL.jobs.pending, oldestPendingCreatedAt: seeded.emailOldest.toISOString(), oldestPendingAgeSeconds: age(seeded.emailOldest) });

    const pushStarted = new Date(+seeded.pushStaleLease - LEASE);
    const emailStarted = new Date(+seeded.emailLiveLease - LEASE);
    expect(by.PUSH.processing).toEqual({ processingCount: 1, staleProcessingCount: 1, oldestProcessingStartedAt: pushStarted.toISOString(), oldestProcessingAgeSeconds: age(pushStarted) });
    expect(by.EMAIL.processing).toEqual({ processingCount: 1, staleProcessingCount: 0, oldestProcessingStartedAt: emailStarted.toISOString(), oldestProcessingAgeSeconds: age(emailStarted) });
    expect(by.SMS.processing).toEqual({ processingCount: 0, staleProcessingCount: 0, oldestProcessingStartedAt: null, oldestProcessingAgeSeconds: null });

    // A lease that lapses exactly now is stale (<= now); the per-channel sum equals the Work 22 total.
    await ctx.prisma.notificationDeliveryJob.updateMany({ where: { status: 'PROCESSING', channel: 'EMAIL' }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    const after = await snapshot();
    expect(after.channels.find((c) => c.channel === 'EMAIL')!.processing.staleProcessingCount).toBe(1);
    const whole = body(await request(ctx.server).get('/admin/notifications/delivery/health').set(...auth(admin.accessToken)).expect(200)) as unknown as { processing: { staleProcessingCount: number }; backlog: { pendingCount: number } };
    expect(after.channels.reduce((n, c) => n + c.processing.staleProcessingCount, 0)).toBe(whole.processing.staleProcessingCount);
    expect(after.channels.reduce((n, c) => n + c.backlog.pendingCount, 0)).toBe(whole.backlog.pendingCount);
  });

  it('provider readiness is the bound-provider gate: PUSH and EMAIL true, SMS false; it follows the registry; SMS jobs stay PENDING', async () => {
    expect(Object.fromEntries((await snapshot()).channels.map((c) => [c.channel, c.providerConfigured]))).toEqual({ PUSH: true, SMS: false, EMAIL: true });

    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH));
    expect(Object.fromEntries((await snapshot()).channels.map((c) => [c.channel, c.providerConfigured]))).toEqual({ PUSH: true, SMS: false, EMAIL: false });

    // Queue behaviour is unchanged: the dispatcher never reads SMS jobs without a provider.
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    expect((await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id: seeded.smsJob } })).status).toBe('PENDING');
    expect(await ctx.prisma.deliveryAttempt.count({ where: { channel: 'SMS' } })).toBe(0);
  });

  it('read-only: jobs, nextAttemptAt, attempts, notifications, preferences and the audit log are unchanged; other methods are 404', async () => {
    const state = async () => ({
      jobs: await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } }),
      attempts: await ctx.prisma.deliveryAttempt.findMany({ orderBy: { id: 'asc' } }),
      notifications: await ctx.prisma.notification.findMany({ orderBy: { id: 'asc' } }),
      preferences: await ctx.prisma.channelPreference.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
    });
    const before = await state();
    for (let i = 0; i < 3; i++) await snapshot();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(ctx.server)[method](CHANNELS).set(...auth(admin.accessToken)).send({});
      expect({ method, status: res.status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('no id, recipient, content, provider name, credential or error data in the response', async () => {
    const res = await get().expect(200);
    const raw = JSON.stringify(res.body);
    const jobs = await ctx.prisma.notificationDeliveryJob.findMany();
    const notifications = await ctx.prisma.notification.findMany();
    const users = await ctx.prisma.user.findMany({ select: { id: true, phone: true } });
    for (const secret of [
      ...jobs.flatMap((j) => [j.id, j.notificationId]),
      ...notifications.flatMap((n) => [n.renderedTitle!, n.renderedBody!]),
      ...users.flatMap((u) => [u.id, u.phone]).filter((v): v is string => !!v),
      'in-memory', 'EMAIL_UNAVAILABLE', 'fcm', 'resend', 'RESEND_', 'FCM_', 'apiKey', 'privateKey', 'errorDetail', 'payload', 'recipient', 'sha256:', '@',
    ]) {
      expect({ secret: secret.slice(0, 16), found: raw.toLowerCase().includes(secret.toLowerCase()) }).toEqual({ secret: secret.slice(0, 16), found: false });
    }
    const s = body(res) as unknown as Snapshot;
    expect(Object.keys(s)).toEqual(['generatedAt', 'channels']);
    for (const c of s.channels) expect(Object.keys(c)).toEqual(['channel', 'providerConfigured', 'jobs', 'backlog', 'processing']);
  });

  it('401 without authentication; 403 for every role without notification:queue:read; SUPER_ADMIN and a read-only holder allowed', async () => {
    expect((await get(null)).status).toBe(401);
    const tokens: Array<[string, string]> = [['CUSTOMER', (await newUser()).accessToken]];
    for (const role of ['DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    for (const [role, token] of tokens) expect({ role, status: (await get(token)).status }).toEqual({ role, status: 403 });

    await get((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
    const read = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'notification:queue:read' } });
    const viewer = await ctx.prisma.role.upsert({ where: { key: 'QUEUE_VIEWER_TEST' }, update: {}, create: { key: 'QUEUE_VIEWER_TEST', name: 'Queue viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: viewer.id, permissionId: read.id } }, update: {}, create: { roleId: viewer.id, permissionId: read.id } });
    await get((await createUserWithRole(ctx, 'QUEUE_VIEWER_TEST')).accessToken).expect(200);
    // No new permission.
    expect((await ctx.prisma.permission.findMany({ where: { key: { startsWith: 'notification:queue:' } }, select: { key: true }, orderBy: { key: 'asc' } })).map((p) => p.key)).toEqual(['notification:queue:manage', 'notification:queue:read']);
  });

  describe('boundaries', () => {
    const root = join(__dirname, '..', '..', 'src', 'modules');
    const sources = (dir: string): string[] => {
      const files: string[] = [];
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      };
      walk(dir);
      return files;
    };
    const rel = (f: string) => f.replace(/\\/g, '/').split('/src/modules/')[1];

    it('Module 16 reads channel health only through Module 13’s channel-health port — no Prisma, providers, registry, transports or configuration', () => {
      const imports = new Set<string>();
      for (const file of sources(join(root, 'admin'))) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /DELIVERY_CHANNEL_HEALTH_REPOSITORY|NOTIFICATION_CHANNEL_PROVIDER_REGISTRY|channelsWithProvider|isConfigured|FcmConfig|ResendConfig|FCM_|RESEND_|lapsedLeaseWhere/.test(source) }).toEqual({ file: rel(file), found: false });
        for (const m of source.matchAll(/from '(?:\.\.\/)+notifications\/([^']+)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'application/ports/inbound/notification-delivery-admin.port',
        'application/ports/inbound/notification-delivery-channel-health.port',
        'application/ports/inbound/notification-delivery-health.port',
        'application/ports/inbound/notification-delivery-lease-release.port',
        'application/ports/inbound/notification-delivery-retry.port',
        'application/ports/inbound/notification-suppression-admin.port',
        'notifications.module',
      ]);
    });

    it('readiness and the dispatcher share one gate; stale and claim-start each have one definition', () => {
      const users = (re: RegExp) => sources(join(root, 'notifications')).filter((f) => re.test(readFileSync(f, 'utf8'))).map(rel).sort();
      expect(users(/channelsWithProvider\(/)).toEqual([
        'notifications/application/ports/inbound/notification-delivery-channel-health.port.ts',
        'notifications/application/services/notification-delivery.dispatcher.ts',
      ]);
      expect(users(/providerFor\(c\) !== null/)).toEqual(['notifications/application/ports/outbound/notification-channel-provider.port.ts']);
      // Deriving a claim's start (lease − leaseMs) — the dispatcher only ever adds it to set a lease.
      expect(users(/-\s*DELIVERY_QUEUE_POLICY\.leaseMs/)).toEqual(['notifications/domain/delivery-queue-health.ts']);
      expect(users(/\blapsedLeaseWhere\b/)).toEqual([
        'notifications/infrastructure/persistence/delivery-lease.ts',
        'notifications/infrastructure/persistence/prisma-delivery-admin.repository.ts',
        'notifications/infrastructure/persistence/prisma-notification-delivery.repository.ts',
      ]);
    });
  });
});
