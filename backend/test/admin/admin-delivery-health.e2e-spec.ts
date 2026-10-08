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

const HEALTH = '/admin/notifications/delivery/health';
const LEASE = DELIVERY_QUEUE_POLICY.leaseMs;
type User = RegisteredUser & Tokens;
type Health = {
  generatedAt: string;
  queue: { total: number; pending: number; processing: number; completed: number; suppressed: number; exhausted: number };
  backlog: { pendingCount: number; oldestPendingCreatedAt: string | null; oldestPendingAgeSeconds: number | null };
  processing: { processingCount: number; staleProcessingCount: number; oldestProcessingStartedAt: string | null; oldestProcessingAgeSeconds: number | null };
};

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
 * Module 16 Work 22 against real PostgreSQL: the delivery queue's health snapshot. The queue is
 * filled by the real path (Module 01 events, the Work 13 dispatcher, in-memory providers); claims
 * are then placed at known instants so the lease arithmetic can be checked exactly.
 */
describe('Admin notification delivery queue health (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const registry = new ScriptedRegistry();
  let admin: User;
  let seeded: { backdatedPending: string; staleProcessing: string; freshProcessing: string; staleLease: Date; oldestPendingCreatedAt: Date };

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
  const jobOf = (notificationId: string, channel: string) =>
    ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { notificationId_channel: { notificationId, channel: channel as never } } });
  const get = (token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(HEALTH);
    return token ? r.set(...auth(token)) : r;
  };
  const health = async () => body(await get().expect(200)) as unknown as Health;

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
    // U2, U3: queued, not dispatched. U2's PUSH was claimed 3 min ago (lease lapsed 1 min ago);
    // U3's PUSH 1 min ago (1 min of lease left) — exactly what `claim` writes: lease = t + leaseMs.
    const n2 = await suspend(await newUser());
    const n3 = await suspend(await newUser());
    const staleLease = new Date(Date.now() - 180_000 + LEASE);
    await ctx.prisma.notificationDeliveryJob.update({ where: { notificationId_channel: { notificationId: n2, channel: 'PUSH' } }, data: { status: 'PROCESSING', leaseExpiresAt: staleLease } });
    await ctx.prisma.notificationDeliveryJob.update({ where: { notificationId_channel: { notificationId: n3, channel: 'PUSH' } }, data: { status: 'PROCESSING', leaseExpiresAt: new Date(Date.now() - 60_000 + LEASE) } });
    // The oldest backlog: U1's SMS job, backdated one hour.
    const oldestPendingCreatedAt = new Date(Date.now() - 3_600_000);
    await ctx.prisma.notificationDeliveryJob.update({ where: { notificationId_channel: { notificationId: n1, channel: 'SMS' } }, data: { createdAt: oldestPendingCreatedAt } });

    seeded = {
      backdatedPending: (await jobOf(n1, 'SMS')).id,
      staleProcessing: (await jobOf(n2, 'PUSH')).id,
      freshProcessing: (await jobOf(n3, 'PUSH')).id,
      staleLease,
      oldestPendingCreatedAt,
    };
  });

  it('200 for ADMIN: exact counts, backlog and processing figures from the seeded queue and the database', async () => {
    const h = await health();
    const db = await ctx.prisma.notificationDeliveryJob.findMany();
    const count = (s: string) => db.filter((j) => j.status === s).length;
    expect(h.queue).toEqual({ total: db.length, pending: count('PENDING'), processing: 2, completed: count('COMPLETED'), suppressed: count('SUPPRESSED'), exhausted: 1 });
    expect(h.queue.completed).toBeGreaterThanOrEqual(1);
    expect(h.queue.pending).toBeGreaterThanOrEqual(5);

    const generatedAt = Date.parse(h.generatedAt);
    expect(h.backlog).toEqual({
      pendingCount: count('PENDING'),
      oldestPendingCreatedAt: seeded.oldestPendingCreatedAt.toISOString(),
      oldestPendingAgeSeconds: Math.floor((generatedAt - +seeded.oldestPendingCreatedAt) / 1000),
    });
    expect(h.backlog.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(3_600);

    // The oldest claim started at its lease − leaseMs: 3 minutes ago.
    const startedAt = new Date(+seeded.staleLease - LEASE);
    expect(h.processing).toEqual({
      processingCount: 2,
      staleProcessingCount: 1,
      oldestProcessingStartedAt: startedAt.toISOString(),
      oldestProcessingAgeSeconds: Math.floor((generatedAt - +startedAt) / 1000),
    });
    expect(h.processing.oldestProcessingAgeSeconds).toBeGreaterThanOrEqual(180);
  });

  it('stale processing is the dispatcher’s own reclaim rule: the job counted stale is exactly the one it reclaims', async () => {
    expect((await health()).processing.staleProcessingCount).toBe(1);
    // Only PUSH is served now, so the dispatcher considers PUSH jobs alone: due = PENDING-and-due or lease lapsed.
    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH));
    await dispatcher.dispatchDue(new Date());
    const [stale, fresh] = await Promise.all([seeded.staleProcessing, seeded.freshProcessing].map((id) => ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id } })));
    expect(stale.status).toBe('COMPLETED');
    expect(fresh.status).toBe('PROCESSING');
    expect((await health()).processing).toMatchObject({ processingCount: 1, staleProcessingCount: 0 });

    // A lease that lapses exactly now counts as stale (`leaseExpiresAt <= now`, as in the claim query).
    await ctx.prisma.notificationDeliveryJob.update({ where: { id: seeded.freshProcessing }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    expect((await health()).processing).toMatchObject({ processingCount: 1, staleProcessingCount: 1 });
  });

  it('an empty queue: zero counts and null timestamps and ages', async () => {
    await ctx.prisma.deliveryAttempt.deleteMany();
    await ctx.prisma.notificationDeliveryJob.deleteMany();
    const h = await health();
    expect(h).toEqual({
      generatedAt: expect.any(String),
      queue: { total: 0, pending: 0, processing: 0, completed: 0, suppressed: 0, exhausted: 0 },
      backlog: { pendingCount: 0, oldestPendingCreatedAt: null, oldestPendingAgeSeconds: null },
      processing: { processingCount: 0, staleProcessingCount: 0, oldestProcessingStartedAt: null, oldestProcessingAgeSeconds: null },
    });
  });

  it('read-only: job status, nextAttemptAt, attempts, notifications and the audit log are unchanged by repeated reads', async () => {
    const snapshot = async () => ({
      jobs: await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } }),
      attempts: await ctx.prisma.deliveryAttempt.findMany({ orderBy: { id: 'asc' } }),
      notifications: await ctx.prisma.notification.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
    });
    const before = await snapshot();
    for (let i = 0; i < 3; i++) await health();
    expect(await snapshot()).toEqual(before);

    // No other method exists on the path.
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(ctx.server)[method](HEALTH).set(...auth(admin.accessToken)).send({});
      expect({ method, status: res.status }).toEqual({ method, status: 404 });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('no id, recipient, content, provider or error data in the response — aggregates only', async () => {
    const res = await get().expect(200);
    const raw = JSON.stringify(res.body);
    const jobs = await ctx.prisma.notificationDeliveryJob.findMany();
    const notifications = await ctx.prisma.notification.findMany();
    const users = await ctx.prisma.user.findMany({ select: { id: true, phone: true } });
    const attempts = await ctx.prisma.deliveryAttempt.findMany();
    for (const secret of [
      ...jobs.flatMap((j) => [j.id, j.notificationId]),
      ...notifications.flatMap((n) => [n.renderedTitle!, n.renderedBody!]),
      ...users.flatMap((u) => [u.id, u.phone]).filter((v): v is string => !!v),
      ...attempts.map((a) => a.providerMsgId).filter((v): v is string => !!v),
      'EMAIL_UNAVAILABLE', 'in-memory', 'errorDetail', 'payload', 'recipient', 'notificationId', 'sha256:',
    ]) {
      expect({ secret: secret.slice(0, 16), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 16), found: false });
    }
    const h = body(res) as unknown as Health;
    expect(Object.keys(h)).toEqual(['generatedAt', 'queue', 'backlog', 'processing']);
  });

  it('401 without authentication; 403 for every role without notification:queue:read; SUPER_ADMIN and a read-only holder are allowed', async () => {
    expect((await get(null)).status).toBe(401);
    const tokens: Array<[string, string]> = [['CUSTOMER', (await newUser()).accessToken]];
    for (const role of ['DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    for (const [role, token] of tokens) expect({ role, status: (await get(token)).status }).toEqual({ role, status: 403 });

    await get((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
    // The Work 20 read key alone suffices — no new permission, and queue:manage is not needed.
    const read = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'notification:queue:read' } });
    const viewer = await ctx.prisma.role.upsert({ where: { key: 'QUEUE_VIEWER_TEST' }, update: {}, create: { key: 'QUEUE_VIEWER_TEST', name: 'Queue viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: viewer.id, permissionId: read.id } }, update: {}, create: { roleId: viewer.id, permissionId: read.id } });
    await get((await createUserWithRole(ctx, 'QUEUE_VIEWER_TEST')).accessToken).expect(200);

    const holders = async (key: string) => (await ctx.prisma.rolePermission.findMany({ where: { permission: { key }, role: { key: { not: 'QUEUE_VIEWER_TEST' } } }, include: { role: { select: { key: true } } } })).map((h) => h.role.key);
    expect(await holders('notification:queue:read')).toEqual(['ADMIN']);
    expect(await holders('notification:queue:manage')).toEqual(['ADMIN']);
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

    it('Module 16 reaches queue health only through Module 13’s health port — no Prisma, repositories, scheduler or lease internals', () => {
      const imports = new Set<string>();
      for (const file of sources(join(root, 'admin'))) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /DELIVERY_HEALTH_REPOSITORY|lapsedLeaseWhere|DELIVERY_QUEUE_POLICY|leaseMs|notification-delivery\.scheduler/.test(source) }).toEqual({ file: rel(file), found: false });
        for (const m of source.matchAll(/from '(?:\.\.\/)+notifications\/([^']+)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'application/ports/inbound/notification-delivery-admin.port',
        'application/ports/inbound/notification-delivery-health.port',
        'application/ports/inbound/notification-delivery-retry.port',
        'application/ports/inbound/notification-suppression-admin.port',
        'notifications.module',
      ]);
    });

    it('the stale-lease predicate has one definition, shared by the dispatcher’s claim query and the health aggregate', () => {
      const users = sources(join(root, 'notifications')).filter((f) => /\blapsedLeaseWhere\b/.test(readFileSync(f, 'utf8'))).map(rel).sort();
      expect(users).toEqual([
        'notifications/infrastructure/persistence/delivery-lease.ts',
        'notifications/infrastructure/persistence/prisma-delivery-admin.repository.ts',
        'notifications/infrastructure/persistence/prisma-notification-delivery.repository.ts',
      ]);
      // No second spelling of the rule anywhere in Module 13.
      for (const file of sources(join(root, 'notifications')).filter((f) => !f.endsWith('delivery-lease.ts'))) {
        expect({ file: rel(file), found: /leaseExpiresAt: \{ lte/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), found: false });
      }
    });
  });
});
