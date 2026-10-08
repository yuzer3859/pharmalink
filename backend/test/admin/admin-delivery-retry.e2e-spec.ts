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
import { NotificationChannel } from '../../src/modules/notifications/domain/enums';
import { InMemoryNotificationChannelProvider } from '../../src/modules/notifications/infrastructure/providers/in-memory-notification-channel.provider';
import { NOTIFICATION_DELIVERY_INTERVAL } from '../../src/modules/notifications/infrastructure/scheduling/notification-delivery.scheduler';
import { auth, body, createUserWithRole, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const BASE = '/admin/notifications/delivery';
const RETRIED = 'ADMIN_NOTIFICATION_DELIVERY_RETRIED';
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
 * Module 16 Work 21 against real PostgreSQL: an operator requeues an EXHAUSTED delivery job and the
 * normal Work 13 pipeline delivers it. The queue is filled by the real path (Module 01 events, Work
 * 11 preferences, the dispatcher) with the non-production in-memory providers. No real provider.
 */
describe('Admin notification delivery retry (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const registry = new ScriptedRegistry();
  const failingEmail = () => new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL, 'FAILED', 'EMAIL_UNAVAILABLE');
  let admin: User;
  let victim: User;
  let seeded: { exhausted: string; completed: string; pending: string; suppressed: string; processing: string; notification: string };

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
  const retry = (id: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).post(`${BASE}/${id}/retry`);
    return token ? r.set(...auth(token)) : r;
  };
  async function exhaust(notificationId: string) {
    let now = new Date(Date.now() + 1_000);
    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatchDue(now);
      now = new Date(Math.max(+(await jobOf(notificationId, 'EMAIL')).nextAttemptAt, +now) + 1);
    }
  }

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH), failingEmail());

    // U1: PUSH completes, EMAIL fails five times (EXHAUSTED), SMS waits (no provider) → PENDING.
    victim = await newUser();
    const n1 = await suspend(victim);
    await exhaust(n1);
    // U2: e-mail disabled after the job was queued → SUPPRESSED.
    const u2 = await newUser();
    const n2 = await suspend(u2);
    await request(ctx.server).post(`/admin/users/${u2.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    const u2Again = { ...u2, ...(await login(ctx, u2.phone, u2.password)) };
    await request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(u2Again.accessToken)).send({ channels: [{ channel: 'EMAIL', enabled: false }] }).expect(200);
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    // U3: one job claimed by a "worker" → PROCESSING.
    const u3 = await newUser();
    const n3 = await suspend(u3);
    await ctx.prisma.notificationDeliveryJob.update({
      where: { notificationId_channel: { notificationId: n3, channel: 'PUSH' } },
      data: { status: 'PROCESSING', leaseExpiresAt: new Date(Date.now() + 120_000) },
    });
    seeded = {
      exhausted: (await jobOf(n1, 'EMAIL')).id,
      completed: (await jobOf(n1, 'PUSH')).id,
      pending: (await jobOf(n1, 'SMS')).id,
      suppressed: (await jobOf(n2, 'EMAIL')).id,
      processing: (await jobOf(n3, 'PUSH')).id,
      notification: n1,
    };
  });

  it('the seeded queue holds every state, produced by the real delivery path', async () => {
    const states = await Promise.all([seeded.exhausted, seeded.completed, seeded.pending, seeded.suppressed, seeded.processing].map(async (id) => (await jobById(id)).status));
    expect(states).toEqual(['EXHAUSTED', 'COMPLETED', 'PENDING', 'SUPPRESSED', 'PROCESSING']);
    expect((await jobById(seeded.exhausted)).attemptCount).toBe(5);
  });

  it('ADMIN retries an EXHAUSTED job: EXHAUSTED → PENDING due now, same job, nothing sent, notification untouched; audited', async () => {
    const before = await jobById(seeded.exhausted);
    const notificationBefore = await ctx.prisma.notification.findUniqueOrThrow({ where: { id: seeded.notification } });
    const attemptsBefore = await ctx.prisma.deliveryAttempt.findMany({ orderBy: { id: 'asc' } });
    const jobsBefore = await ctx.prisma.notificationDeliveryJob.count();
    const t0 = Date.now();

    const res = body(await retry(seeded.exhausted).expect(200)) as Record<string, unknown>;
    const after = await jobById(seeded.exhausted);

    expect(after).toMatchObject({
      id: before.id,
      notificationId: before.notificationId,
      channel: 'EMAIL',
      status: 'PENDING',
      attemptCount: 5,
      lastErrorCode: 'EMAIL_UNAVAILABLE',
      leaseExpiresAt: null,
      completedAt: null,
      createdAt: before.createdAt,
    });
    // Due now — the scheduler's `PENDING AND nextAttemptAt <= now` picks it up on its next tick.
    expect(+after.nextAttemptAt).toBeGreaterThanOrEqual(t0 - 1_000);
    expect(+after.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    expect(res).toEqual({
      id: after.id,
      notificationId: after.notificationId,
      channel: 'EMAIL',
      status: 'PENDING',
      attemptCount: 5,
      nextAttemptAt: after.nextAttemptAt.toISOString(),
      leaseExpiresAt: null,
      lastErrorCode: 'EMAIL_UNAVAILABLE',
      completedAt: null,
      createdAt: after.createdAt.toISOString(),
      updatedAt: after.updatedAt.toISOString(),
    });
    // No second job, no attempt (the provider was not called from the request), notification unchanged.
    expect(await ctx.prisma.notificationDeliveryJob.count()).toBe(jobsBefore);
    expect(await ctx.prisma.notificationDeliveryJob.count({ where: { notificationId: seeded.notification, channel: 'EMAIL' } })).toBe(1);
    expect(await ctx.prisma.deliveryAttempt.findMany({ orderBy: { id: 'asc' } })).toEqual(attemptsBefore);
    expect(await ctx.prisma.notification.findUniqueOrThrow({ where: { id: seeded.notification } })).toEqual(notificationBefore);

    const audit = await ctx.prisma.auditLog.findMany({ where: { action: RETRIED } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: admin.userId, resourceType: 'NotificationDeliveryJob', resourceId: seeded.exhausted });
    expect(audit[0].context).toEqual({
      deliveryJobId: seeded.exhausted,
      channel: 'EMAIL',
      previousStatus: 'EXHAUSTED',
      newStatus: 'PENDING',
      attemptCount: 5,
      lastErrorCode: 'EMAIL_UNAVAILABLE',
    });
    const raw = JSON.stringify(audit[0].context);
    for (const secret of [victim.phone, notificationBefore.renderedTitle!, notificationBefore.renderedBody!, seeded.notification, victim.userId, 'errorDetail', 'sha256:']) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
  });

  it('the scheduler then delivers it through the normal pipeline: attempt 6; a failure re-exhausts it, a later retry can complete it', async () => {
    await retry(seeded.exhausted).expect(200);
    // Still failing: attempt 6, and — past the fifth failure — straight back to EXHAUSTED.
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    expect(await jobById(seeded.exhausted)).toMatchObject({ status: 'EXHAUSTED', attemptCount: 6, lastErrorCode: 'EMAIL_UNAVAILABLE' });
    const attempts = await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId: seeded.notification, channel: 'EMAIL' }, orderBy: { attemptNumber: 'asc' } });
    expect(attempts.map((a) => [a.attemptNumber, a.status])).toEqual([1, 2, 3, 4, 5, 6].map((n) => [n, 'FAILED']));

    // The provider recovers; a second manual retry is delivered as attempt 7.
    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH), new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL));
    await retry(seeded.exhausted).expect(200);
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    expect(await jobById(seeded.exhausted)).toMatchObject({ status: 'COMPLETED', attemptCount: 7, leaseExpiresAt: null });
    const last = await ctx.prisma.deliveryAttempt.findFirstOrThrow({ where: { notificationId: seeded.notification, channel: 'EMAIL' }, orderBy: { attemptNumber: 'desc' } });
    expect([last.attemptNumber, last.status]).toEqual([7, 'SENT']);
    expect(await ctx.prisma.auditLog.count({ where: { action: RETRIED } })).toBe(2);
  });

  it('SUPER_ADMIN can retry (wildcard)', async () => {
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    await retry(seeded.exhausted, superAdmin.accessToken).expect(200);
    expect((await jobById(seeded.exhausted)).status).toBe('PENDING');
    expect(await ctx.prisma.auditLog.findMany({ where: { action: RETRIED }, select: { actorUserId: true } })).toEqual([{ actorUserId: superAdmin.userId }]);
  });

  it('PENDING, PROCESSING, COMPLETED and SUPPRESSED cannot be retried → 409; nothing changes and nothing is audited', async () => {
    const snapshot = await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } });
    const attempts = await ctx.prisma.deliveryAttempt.count();
    for (const [state, id] of [['PENDING', seeded.pending], ['PROCESSING', seeded.processing], ['COMPLETED', seeded.completed], ['SUPPRESSED', seeded.suppressed]] as const) {
      const res = await retry(id);
      expect({ state, status: res.status, code: res.body?.error?.code ?? res.body?.code }).toEqual({ state, status: 409, code: 'CONFLICT' });
    }
    expect(await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
    expect(await ctx.prisma.deliveryAttempt.count()).toBe(attempts);
    expect(await ctx.prisma.auditLog.count({ where: { action: RETRIED } })).toBe(0);
  });

  it('unknown job → 404, malformed id → 400; nothing changes and nothing is audited', async () => {
    const snapshot = await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } });
    await retry(randomUUID()).expect(404);
    await retry('not-a-uuid').expect(400);
    expect(await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
    expect(await ctx.prisma.auditLog.count({ where: { action: RETRIED } })).toBe(0);
  });

  it('concurrent retries of one EXHAUSTED job: exactly one 200, the rest 409; one transition, one audit row, one job', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => retry(seeded.exhausted)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await jobById(seeded.exhausted)).toMatchObject({ status: 'PENDING', attemptCount: 5 });
    expect(await ctx.prisma.notificationDeliveryJob.count({ where: { notificationId: seeded.notification, channel: 'EMAIL' } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: RETRIED } })).toBe(1);
    // The one requeue is delivered once.
    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL));
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    expect(await ctx.prisma.deliveryAttempt.count({ where: { notificationId: seeded.notification, channel: 'EMAIL', status: 'SENT' } })).toBe(1);
  });

  it('401 without authentication; 403 for every other role and for a holder of notification:queue:read alone; nothing changes', async () => {
    const snapshot = await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } });
    expect((await retry(seeded.exhausted, null)).status).toBe(401);

    const tokens: Array<[string, string]> = [['CUSTOMER', (await newUser()).accessToken]];
    for (const role of ['DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    // A test-only role holding exactly the Work 20 read key: seeing the queue never implies changing it.
    const read = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'notification:queue:read' } });
    const viewer = await ctx.prisma.role.upsert({ where: { key: 'QUEUE_VIEWER_TEST' }, update: {}, create: { key: 'QUEUE_VIEWER_TEST', name: 'Queue viewer (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: viewer.id, permissionId: read.id } }, update: {}, create: { roleId: viewer.id, permissionId: read.id } });
    const viewerUser = await createUserWithRole(ctx, 'QUEUE_VIEWER_TEST');
    await request(ctx.server).get(`${BASE}/${seeded.exhausted}`).set(...auth(viewerUser.accessToken)).expect(200);
    tokens.push(['QUEUE_VIEWER_TEST', viewerUser.accessToken]);

    for (const [role, token] of tokens) {
      expect({ role, status: (await retry(seeded.exhausted, token)).status }).toEqual({ role, status: 403 });
    }
    expect(await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(snapshot);
    expect(await ctx.prisma.auditLog.count({ where: { action: RETRIED } })).toBe(0);

    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'notification:queue:manage' } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
    expect(await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'notification:queue:manage' }, select: { resource: true, action: true } })).toEqual({ resource: 'notification', action: 'queue_manage' });
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

    it('Module 16 reaches the queue only through Module 13’s inbound ports — no Prisma, repositories, domain rules or infrastructure', () => {
      const imports = new Set<string>();
      for (const file of sources(join(root, 'admin'))) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /notificationDeliveryJob|notification_delivery_jobs|DELIVERY_REQUEUE_REPOSITORY|requeuedJobState|MANUALLY_REQUEUEABLE_STATUS/.test(source) }).toEqual({ file: rel(file), found: false });
        for (const m of source.matchAll(/from '(?:\.\.\/)+notifications\/([^']+)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'application/ports/inbound/notification-delivery-admin.port',
        'application/ports/inbound/notification-delivery-retry.port',
        'application/ports/inbound/notification-suppression-admin.port',
        'notifications.module',
      ]);
    });

    it('the retry command and controller never touch Prisma; the transition lives in Module 13’s delivery adapter alone', () => {
      for (const file of sources(join(root, 'admin')).filter((f) => /delivery-retry|retry-delivery-job/.test(f))) {
        expect({ file: rel(file), found: /PrismaService|@prisma\/client|infrastructure\/persistence/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), found: false });
      }
      expect(sources(join(root, 'notifications')).filter((f) => /requeuedJobState\(/.test(readFileSync(f, 'utf8'))).map(rel).sort()).toEqual([
        'notifications/domain/repositories/delivery-requeue.repository.ts',
        'notifications/infrastructure/persistence/prisma-notification-delivery.repository.ts',
      ]);
    });
  });
});
