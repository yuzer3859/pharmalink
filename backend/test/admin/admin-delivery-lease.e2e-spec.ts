import { randomUUID } from 'crypto';
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

const BASE = '/admin/notifications/delivery';
const RELEASED = 'ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED';
const LEASE = DELIVERY_QUEUE_POLICY.leaseMs;
type User = RegisteredUser & Tokens;

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
 * Module 16 Work 23 against real PostgreSQL: an operator releases a delivery job whose Module 13
 * lease has lapsed, and the normal Work 13 pipeline delivers it. The queue is filled by the real path
 * (Module 01 events, Work 11 preferences, the dispatcher, in-memory providers); claims are then
 * placed at known instants, exactly as `claim` writes them (lease = claim time + leaseMs).
 */
describe('Admin notification delivery lease release (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const registry = new ScriptedRegistry();
  let push: InMemoryNotificationChannelProvider;
  let admin: User;
  let victim: User;
  let seeded: { stale: string; live: string; pending: string; completed: string; suppressed: string; exhausted: string; staleNotification: string; staleLease: Date };

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
  const jobById = (id: string) => ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id } });
  const release = (id: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).post(`${BASE}/${id}/release`);
    return token ? r.set(...auth(token)) : r;
  };
  /** A claim `claimedAgoMs` ago, as the dispatcher writes it. */
  const claimed = (claimedAgoMs: number) => new Date(Date.now() - claimedAgoMs + LEASE);

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    push = new InMemoryNotificationChannelProvider(NotificationChannel.PUSH);
    registry.use(push, new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL, 'FAILED', 'EMAIL_UNAVAILABLE'));

    // U1: PUSH completes, EMAIL fails five times (EXHAUSTED), SMS waits (no provider) → PENDING.
    const n1 = await suspend(await newUser());
    let now = new Date(Date.now() + 1_000);
    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatchDue(now);
      now = new Date(Math.max(+(await jobOf(n1, 'EMAIL')).nextAttemptAt, +now) + 1);
    }
    // U2: e-mail disabled after the job was queued → SUPPRESSED.
    const u2 = await newUser();
    const n2 = await suspend(u2);
    await request(ctx.server).post(`/admin/users/${u2.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    const u2Again = { ...u2, ...(await login(ctx, u2.phone, u2.password)) };
    await request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(u2Again.accessToken)).send({ channels: [{ channel: 'EMAIL', enabled: false }] }).expect(200);
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    // U3: queued, never dispatched. Its PUSH was claimed 3 min ago by a worker that died after two
    // earlier failures (lease lapsed 1 min ago); its EMAIL was claimed 30 s ago (lease running).
    victim = await newUser();
    const n3 = await suspend(victim);
    const staleLease = claimed(LEASE + 60_000);
    await ctx.prisma.notificationDeliveryJob.update({
      where: { notificationId_channel: { notificationId: n3, channel: 'PUSH' } },
      data: { status: 'PROCESSING', leaseExpiresAt: staleLease, attemptCount: 2, lastErrorCode: 'PUSH_UNAVAILABLE' },
    });
    await ctx.prisma.notificationDeliveryJob.update({ where: { notificationId_channel: { notificationId: n3, channel: 'EMAIL' } }, data: { status: 'PROCESSING', leaseExpiresAt: claimed(30_000) } });

    seeded = {
      stale: (await jobOf(n3, 'PUSH')).id,
      live: (await jobOf(n3, 'EMAIL')).id,
      pending: (await jobOf(n1, 'SMS')).id,
      completed: (await jobOf(n1, 'PUSH')).id,
      exhausted: (await jobOf(n1, 'EMAIL')).id,
      suppressed: (await jobOf(n2, 'EMAIL')).id,
      staleNotification: n3,
      staleLease,
    };
  });

  it('the seeded queue holds every state, produced by the real delivery path', async () => {
    const states = await Promise.all(['stale', 'live', 'pending', 'completed', 'exhausted', 'suppressed'].map(async (k) => (await jobById(seeded[k as 'stale'] as string)).status));
    expect(states).toEqual(['PROCESSING', 'PROCESSING', 'PENDING', 'COMPLETED', 'EXHAUSTED', 'SUPPRESSED']);
  });

  it('ADMIN releases a lapsed lease: PROCESSING → PENDING due now, lease cleared, same job, counts kept; no provider call; audited once', async () => {
    const before = await jobById(seeded.stale);
    const notificationBefore = await ctx.prisma.notification.findUniqueOrThrow({ where: { id: seeded.staleNotification } });
    const prefsBefore = await ctx.prisma.channelPreference.findMany({ orderBy: { id: 'asc' } });
    const attemptsBefore = await ctx.prisma.deliveryAttempt.findMany({ orderBy: { id: 'asc' } });
    const jobsBefore = await ctx.prisma.notificationDeliveryJob.count();
    const sentBefore = push.delivered.length;
    const t0 = Date.now();

    const res = body(await release(seeded.stale).expect(200)) as Record<string, unknown>;
    const after = await jobById(seeded.stale);

    expect(after).toMatchObject({
      id: before.id,
      notificationId: before.notificationId,
      channel: 'PUSH',
      status: 'PENDING',
      attemptCount: 2,
      lastErrorCode: 'PUSH_UNAVAILABLE',
      leaseExpiresAt: null,
      completedAt: null,
      createdAt: before.createdAt,
    });
    expect(+after.nextAttemptAt).toBeGreaterThanOrEqual(t0 - 1_000);
    expect(+after.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    // The Work 20 job shape, exactly.
    expect(res).toEqual({
      id: after.id,
      notificationId: after.notificationId,
      channel: 'PUSH',
      status: 'PENDING',
      attemptCount: 2,
      nextAttemptAt: after.nextAttemptAt.toISOString(),
      leaseExpiresAt: null,
      lastErrorCode: 'PUSH_UNAVAILABLE',
      completedAt: null,
      createdAt: after.createdAt.toISOString(),
      updatedAt: after.updatedAt.toISOString(),
    });

    expect(push.delivered.length).toBe(sentBefore);
    expect(await ctx.prisma.notificationDeliveryJob.count()).toBe(jobsBefore);
    expect(await ctx.prisma.deliveryAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(attemptsBefore);
    expect(await ctx.prisma.notification.findUniqueOrThrow({ where: { id: seeded.staleNotification } })).toEqual(notificationBefore);
    expect(await ctx.prisma.channelPreference.findMany({ orderBy: { id: 'asc' } })).toEqual(prefsBefore);

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: RELEASED } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: admin.userId, resourceType: 'NotificationDeliveryJob', resourceId: seeded.stale });
    expect(audit[0].context).toEqual({
      deliveryJobId: seeded.stale,
      channel: 'PUSH',
      previousStatus: 'PROCESSING',
      newStatus: 'PENDING',
      previousLeaseExpiresAt: seeded.staleLease.toISOString(),
      leaseExpired: true,
      attemptCount: 2,
      lastErrorCode: 'PUSH_UNAVAILABLE',
    });
    const raw = JSON.stringify([audit[0].context, res]);
    for (const secret of [victim.phone, victim.userId, notificationBefore.renderedTitle!, notificationBefore.renderedBody!, 'errorDetail', 'payload', 'recipient', 'sha256:']) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
  });

  it('the scheduler then delivers the released job through the normal pipeline, as attempt attemptCount + 1', async () => {
    await release(seeded.stale).expect(200);
    await dispatcher.dispatchDue(new Date());
    expect(await jobById(seeded.stale)).toMatchObject({ status: 'COMPLETED', attemptCount: 3, leaseExpiresAt: null });
    const attempts = await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId: seeded.staleNotification, channel: 'PUSH' } });
    expect(attempts.map((a) => [a.attemptNumber, a.status])).toEqual([[3, 'SENT']]);
    expect(push.delivered.filter((d) => d.notificationId === seeded.staleNotification)).toHaveLength(1);
  });

  it('a lease still running → 409; PENDING, COMPLETED, SUPPRESSED, EXHAUSTED → 409; nothing changes, nothing audited', async () => {
    const snapshot = await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } });
    const attempts = await ctx.prisma.deliveryAttempt.count();
    for (const [state, id] of [['PROCESSING (live lease)', seeded.live], ['PENDING', seeded.pending], ['COMPLETED', seeded.completed], ['SUPPRESSED', seeded.suppressed], ['EXHAUSTED', seeded.exhausted]] as const) {
      const res = await release(id);
      expect({ state, status: res.status, code: res.body?.error?.code ?? res.body?.code }).toEqual({ state, status: 409, code: 'CONFLICT' });
    }
    expect(await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
    expect(await ctx.prisma.deliveryAttempt.count()).toBe(attempts);
    expect(await ctx.prisma.auditLog.count({ where: { action: RELEASED } })).toBe(0);
  });

  it('expired vs valid lease: the live one becomes releasable exactly when its lease lapses', async () => {
    await release(seeded.live).expect(409);
    await ctx.prisma.notificationDeliveryJob.update({ where: { id: seeded.live }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    await release(seeded.live).expect(200);
    expect(await jobById(seeded.live)).toMatchObject({ status: 'PENDING', leaseExpiresAt: null });
  });

  it('unknown job → 404, malformed id → 400; nothing changes and nothing is audited', async () => {
    const snapshot = await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } });
    await release(randomUUID()).expect(404);
    await release('not-a-uuid').expect(400);
    expect(await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
    expect(await ctx.prisma.auditLog.count({ where: { action: RELEASED } })).toBe(0);
  });

  it('concurrent releases of one stale job: exactly one 200, the rest 409; one transition, one audit row, one job', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => release(seeded.stale)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await jobById(seeded.stale)).toMatchObject({ status: 'PENDING', attemptCount: 2, leaseExpiresAt: null });
    expect(await ctx.prisma.notificationDeliveryJob.count({ where: { notificationId: seeded.staleNotification, channel: 'PUSH' } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: RELEASED } })).toBe(1);
  });

  it('a release racing the dispatcher’s own re-claim of the same lapsed lease: one wins; the job is delivered exactly once', async () => {
    const [res] = await Promise.all([release(seeded.stale), dispatcher.dispatchDue(new Date())]);
    expect([200, 409]).toContain(res.status);
    expect(await ctx.prisma.auditLog.count({ where: { action: RELEASED } })).toBe(res.status === 200 ? 1 : 0);
    // If the release won, the job is PENDING and due: one more tick delivers it.
    await dispatcher.dispatchDue(new Date());
    expect((await jobById(seeded.stale)).status).toBe('COMPLETED');
    const sent = await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId: seeded.staleNotification, channel: 'PUSH' } });
    expect(sent.map((a) => [a.attemptNumber, a.status])).toEqual([[3, 'SENT']]);
  });

  it('401 without authentication; 403 for every other role and for notification:queue:read alone; SUPER_ADMIN allowed', async () => {
    const snapshot = await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } });
    expect((await release(seeded.stale, null)).status).toBe(401);
    const tokens: Array<[string, string]> = [['CUSTOMER', (await newUser()).accessToken]];
    for (const role of ['DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    const read = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'notification:queue:read' } });
    const viewer = await ctx.prisma.role.upsert({ where: { key: 'QUEUE_VIEWER_TEST' }, update: {}, create: { key: 'QUEUE_VIEWER_TEST', name: 'Queue viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: viewer.id, permissionId: read.id } }, update: {}, create: { roleId: viewer.id, permissionId: read.id } });
    tokens.push(['QUEUE_VIEWER_TEST', (await createUserWithRole(ctx, 'QUEUE_VIEWER_TEST')).accessToken]);
    for (const [role, token] of tokens) expect({ role, status: (await release(seeded.stale, token)).status }).toEqual({ role, status: 403 });
    expect(await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
    expect(await ctx.prisma.auditLog.count({ where: { action: RELEASED } })).toBe(0);

    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    await release(seeded.stale, superAdmin.accessToken).expect(200);
    expect(await ctx.prisma.auditLog.findMany({ where: { action: RELEASED }, select: { actorUserId: true } })).toEqual([{ actorUserId: superAdmin.userId }]);
    // No new permission: the Work 21 key, still ADMIN only.
    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'notification:queue:manage' } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
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

    it('Module 16 releases leases only through Module 13’s lease-release port — no Prisma, repositories, lease rule or scheduler', () => {
      const imports = new Set<string>();
      for (const file of sources(join(root, 'admin'))) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /DELIVERY_LEASE_RELEASE_REPOSITORY|releasedLeaseJobState|lapsedLeaseWhere|leaseExpiresAt\s*<=|leaseMs|notification-delivery\.scheduler/.test(source) }).toEqual({ file: rel(file), found: false });
        for (const m of source.matchAll(/from '(?:\.\.\/)+notifications\/([^']+)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'application/ports/inbound/notification-delivery-admin.port',
        'application/ports/inbound/notification-delivery-health.port',
        'application/ports/inbound/notification-delivery-lease-release.port',
        'application/ports/inbound/notification-delivery-retry.port',
        'application/ports/inbound/notification-suppression-admin.port',
        'notifications.module',
      ]);
    });

    it('the release reuses the one lapsed-lease predicate inside Module 13’s delivery adapter; the command and controller never touch Prisma', () => {
      const adapter = readFileSync(join(root, 'notifications', 'infrastructure', 'persistence', 'prisma-notification-delivery.repository.ts'), 'utf8');
      const releaseBody = adapter.slice(adapter.indexOf('async releaseLapsedLease'));
      expect(releaseBody).toMatch(/lapsedLeaseWhere\(now\)/);
      expect(releaseBody).not.toMatch(/<=\s*now|lte:/);
      for (const file of sources(join(root, 'admin')).filter((f) => /delivery-lease|release-delivery-lease/.test(f))) {
        expect({ file: rel(file), found: /PrismaService|@prisma\/client|infrastructure\/persistence/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), found: false });
      }
    });
  });
});
