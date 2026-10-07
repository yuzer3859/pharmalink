import { readdirSync, readFileSync, statSync } from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
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
import {
  NOTIFICATION_DELIVERY_INTERVAL,
  NotificationDeliveryScheduler,
} from '../../src/modules/notifications/infrastructure/scheduling/notification-delivery.scheduler';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { auth, body, createUserWithRole, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;

/** The providers a test binds; empty means exactly what production binds today. */
class ScriptedRegistry implements INotificationChannelProviderRegistry {
  providers = new Map<NotificationChannel, INotificationChannelProvider>();
  use(...providers: INotificationChannelProvider[]) {
    this.providers = new Map(providers.map((p) => [p.channel, p]));
  }
  providerFor(channel: NotificationChannel) {
    return this.providers.get(channel) ?? null;
  }
}

/**
 * Module 13 Work 13 against real PostgreSQL: notifications produced by an existing event path
 * (Module 01's suspend / reactivate, Work 01), preferences through Work 11's route, delivery jobs
 * queued with them, and the dispatcher claiming, sending, retrying and exhausting them — with the
 * non-production in-memory providers, or none, as production binds.
 */
describe('Notification delivery queue (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  let scheduler: NotificationDeliveryScheduler;
  const registry = new ScriptedRegistry();
  let intervalWasRegistered = false;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: NOTIFICATION_CHANNEL_PROVIDER_REGISTRY, useValue: registry }]);
    dispatcher = ctx.app.get(NotificationDeliveryDispatcher);
    scheduler = ctx.app.get(NotificationDeliveryScheduler);
    // The 5 s interval is real in this app; ticks are driven explicitly here so results are deterministic.
    const schedules = ctx.app.get(SchedulerRegistry);
    intervalWasRegistered = schedules.getIntervals().includes(NOTIFICATION_DELIVERY_INTERVAL);
    schedules.deleteInterval(NOTIFICATION_DELIVERY_INTERVAL);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    registry.use();
  });

  async function newUser(): Promise<User> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }

  /** A real SECURITY notification (ACCOUNT_REACTIVATED) through Module 01's own routes. */
  async function reactivated(user: User) {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server).post(`/admin/users/${user.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await request(ctx.server).post(`/admin/users/${user.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    const fresh = { ...user, ...(await login(ctx, user.phone, user.password)) };
    const row = await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: user.userId, templateCode: 'ACCOUNT_REACTIVATED' } });
    return { user: fresh, notificationId: row.id };
  }

  const setPrefs = (user: User, channels: Array<{ channel: string; enabled: boolean }>) =>
    request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(user.accessToken)).send({ channels }).expect(200);
  const jobs = async (notificationId: string) =>
    (await ctx.prisma.notificationDeliveryJob.findMany({ where: { notificationId } })).sort((a, b) => a.channel.localeCompare(b.channel));
  const job = async (notificationId: string, channel: string) =>
    ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { notificationId_channel: { notificationId, channel: channel as never } } });
  const attempts = async (notificationId: string) =>
    (await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId } })).sort(
      (a, b) => a.channel.localeCompare(b.channel) || a.attemptNumber - b.attemptNumber,
    );
  const inboxIds = async (token: string) =>
    ((body(await request(ctx.server).get('/notifications').set(...auth(token)).expect(200)) as unknown as { items: Array<{ id: string }> }).items).map((i) => i.id);

  it('registers the dispatch interval with the scheduler', () => {
    expect(intervalWasRegistered).toBe(true);
  });

  describe('queue creation', () => {
    it('a real event queues one PENDING job per enabled external channel, none for IN_APP or a disabled channel', async () => {
      const u = await newUser();
      await setPrefs(u, [
        { channel: 'SMS', enabled: false },
        { channel: 'PUSH', enabled: true },
      ]);
      const { user, notificationId } = await reactivated(u);
      expect((await jobs(notificationId)).map((j) => [j.channel, j.status, j.attemptCount, j.leaseExpiresAt, j.completedAt])).toEqual([
        ['EMAIL', 'PENDING', 0, null, null],
        ['PUSH', 'PENDING', 0, null, null],
      ]);
      expect(await ctx.prisma.notificationDeliveryJob.count({ where: { channel: 'IN_APP' } })).toBe(0);
      expect(await ctx.prisma.notificationDeliveryJob.count({ where: { channel: 'SMS' } })).toBe(0);
      expect(await ctx.prisma.deliveryAttempt.count()).toBe(0);
      expect(await inboxIds(user.accessToken)).toContain(notificationId);
    });

    it('the database refuses a second job for the same notification and channel', async () => {
      const { notificationId } = await reactivated(await newUser());
      await expect(ctx.prisma.notificationDeliveryJob.create({ data: { notificationId, channel: 'PUSH' } })).rejects.toMatchObject({ code: 'P2002' });
    });

    it('redelivering the same event queues nothing twice', async () => {
      const { notificationId } = await reactivated(await newUser());
      await ctx.prisma.outbox.updateMany({ data: { publishedAt: null } });
      await ctx.drainOutbox();
      expect(await ctx.prisma.notificationDeliveryJob.count()).toBe(
        3 * (await ctx.prisma.notification.count({ where: { category: { in: ['SECURITY', 'SYSTEM', 'TRANSACTIONAL'] } } })),
      );
      expect(await jobs(notificationId)).toHaveLength(3);
    });
  });

  describe('dispatch', () => {
    it('with production’s empty registry, jobs stay PENDING, untouched, with no attempt and no network call', async () => {
      const { user, notificationId } = await reactivated(await newUser());
      const before = await jobs(notificationId);
      const spies = [
        jest.spyOn(http, 'request'),
        jest.spyOn(https, 'request'),
        jest.spyOn(net.Socket.prototype, 'connect'),
        ...(typeof globalThis.fetch === 'function' ? [jest.spyOn(globalThis, 'fetch')] : []),
      ];
      try {
        expect(await scheduler.tick()).toEqual({ due: 0, claimed: 0, outcomes: {} });
        expect(await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000))).toEqual({ due: 0, claimed: 0, outcomes: {} });
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(await jobs(notificationId)).toEqual(before);
      expect(await ctx.prisma.deliveryAttempt.count()).toBe(0);
      expect(await inboxIds(user.accessToken)).toContain(notificationId);
    });

    it('binding the test provider delivers the waiting job: exactly one SENT attempt, job COMPLETED, IN_APP untouched', async () => {
      const { user, notificationId } = await reactivated(await newUser());
      const push = new InMemoryNotificationChannelProvider(NotificationChannel.PUSH);
      registry.use(push);
      // Suspension and reactivation each queued a PUSH job.
      const summary = await scheduler.tick();
      expect(summary?.outcomes).toEqual({ COMPLETED: 2 });
      expect(push.delivered.filter((r) => r.notificationId === notificationId)).toEqual([
        expect.objectContaining({ channel: 'PUSH', category: 'SECURITY', recipient: { userId: user.userId } }),
      ]);
      expect((await attempts(notificationId)).map((a) => [a.channel, a.attemptNumber, a.status, a.provider, a.providerMsgId, a.errorCode, a.errorDetail])).toEqual([
        ['PUSH', 1, 'SENT', 'in-memory-push', `in-memory:PUSH:${notificationId}`, null, null],
      ]);
      expect(await job(notificationId, 'PUSH')).toMatchObject({ status: 'COMPLETED', attemptCount: 1, leaseExpiresAt: null, lastErrorCode: null });
      expect((await job(notificationId, 'PUSH')).completedAt).not.toBeNull();
      expect(await job(notificationId, 'SMS')).toMatchObject({ status: 'PENDING', attemptCount: 0 });
      // Terminal success: a later tick sends nothing more.
      await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
      expect(push.delivered.filter((r) => r.notificationId === notificationId)).toHaveLength(1);
      expect(await ctx.prisma.notification.findUniqueOrThrow({ where: { id: notificationId } })).toMatchObject({ status: 'SENT', channel: 'IN_APP' });
      expect(await inboxIds(user.accessToken)).toContain(notificationId);
    });

    it('a channel disabled after queuing is SUPPRESSED with a SUPPRESSED attempt and no provider call', async () => {
      const { user, notificationId } = await reactivated(await newUser());
      await setPrefs(user, [{ channel: 'EMAIL', enabled: false }]);
      const email = new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL);
      registry.use(email);
      await dispatcher.dispatchDue();
      expect(email.delivered.filter((r) => r.notificationId === notificationId)).toEqual([]);
      expect(await job(notificationId, 'EMAIL')).toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'PREFERENCE_DISABLED' });
      expect((await attempts(notificationId)).map((a) => [a.channel, a.attemptNumber, a.status, a.errorCode])).toEqual([['EMAIL', 1, 'SUPPRESSED', 'PREFERENCE_DISABLED']]);
      // Re-enabling does not resurrect it.
      await setPrefs(user, [{ channel: 'EMAIL', enabled: true }]);
      await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
      expect(email.delivered.filter((r) => r.notificationId === notificationId)).toEqual([]);
    });

    it('a provider failure records a FAILED attempt and a retry 30 s out; five failures exhaust it; no sixth call', async () => {
      const { notificationId } = await reactivated(await newUser());
      const sms = new InMemoryNotificationChannelProvider(NotificationChannel.SMS, 'FAILED', 'RECIPIENT_UNREACHABLE');
      registry.use(sms);
      let now = new Date();
      await dispatcher.dispatchDue(now);
      const first = await job(notificationId, 'SMS');
      expect(first).toMatchObject({ status: 'PENDING', attemptCount: 1, lastErrorCode: 'RECIPIENT_UNREACHABLE', leaseExpiresAt: null });
      expect(+first.nextAttemptAt - +now).toBe(30_000);
      expect((await attempts(notificationId)).map((a) => [a.attemptNumber, a.status, a.errorCode, a.errorDetail])).toEqual([[1, 'FAILED', 'RECIPIENT_UNREACHABLE', null]]);
      // Not before it is due.
      await dispatcher.dispatchDue(new Date(+now + 29_999));
      expect(sms.delivered.filter((r) => r.notificationId === notificationId)).toHaveLength(1);

      const delays: number[] = [];
      for (let i = 0; i < 4; i++) {
        now = (await job(notificationId, 'SMS')).nextAttemptAt;
        await dispatcher.dispatchDue(now);
        const j = await job(notificationId, 'SMS');
        delays.push(j.status === 'PENDING' ? +j.nextAttemptAt - +now : -1);
      }
      expect(delays).toEqual([120_000, 600_000, 1_800_000, -1]);
      expect(await job(notificationId, 'SMS')).toMatchObject({ status: 'EXHAUSTED', attemptCount: 5, lastErrorCode: 'RECIPIENT_UNREACHABLE' });
      await dispatcher.dispatchDue(new Date(+now + 7 * 86_400_000));
      expect(sms.delivered.filter((r) => r.notificationId === notificationId)).toHaveLength(5);
      expect((await attempts(notificationId)).map((a) => [a.attemptNumber, a.status])).toEqual([1, 2, 3, 4, 5].map((n) => [n, 'FAILED']));
    });

    it('a provider that throws is persisted as PROVIDER_ERROR with no free text', async () => {
      const { notificationId } = await reactivated(await newUser());
      registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH, 'THROW'));
      await dispatcher.dispatchDue();
      const [a] = await attempts(notificationId);
      expect(a).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_ERROR', errorDetail: null });
      expect(JSON.stringify(await ctx.prisma.deliveryAttempt.findMany()) + JSON.stringify(await jobs(notificationId))).not.toContain('in-memory provider failure');
    });
  });

  describe('concurrency', () => {
    it('two concurrent dispatchers make one provider call per job and one attempt', async () => {
      const { notificationId } = await reactivated(await newUser());
      const calls: string[] = [];
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      registry.use({
        name: 'gated',
        channel: NotificationChannel.EMAIL,
        deliver: async (req) => {
          calls.push(req.notificationId);
          await gate;
          return { outcome: 'SENT' };
        },
      });
      const both = Promise.all([dispatcher.dispatchDue(), dispatcher.dispatchDue(), scheduler.tick()]);
      await new Promise((r) => setTimeout(r, 200));
      open();
      const results = await both;
      expect(results.reduce((n, r) => n + (r?.claimed ?? 0), 0)).toBe(calls.length);
      expect(calls.filter((id) => id === notificationId)).toHaveLength(1);
      expect((await attempts(notificationId)).map((a) => [a.channel, a.attemptNumber, a.status])).toEqual([['EMAIL', 1, 'SENT']]);
    });

    it('an abandoned PROCESSING job is reclaimed once its lease expires, and not before', async () => {
      const { notificationId } = await reactivated(await newUser());
      const now = new Date();
      // A worker claimed it and died.
      await ctx.prisma.notificationDeliveryJob.update({
        where: { notificationId_channel: { notificationId, channel: 'PUSH' } },
        data: { status: 'PROCESSING', leaseExpiresAt: new Date(+now + 60_000) },
      });
      const push = new InMemoryNotificationChannelProvider(NotificationChannel.PUSH);
      registry.use(push);
      const mine = () => push.delivered.filter((r) => r.notificationId === notificationId);
      await dispatcher.dispatchDue(now);
      expect(mine()).toEqual([]);
      expect(await job(notificationId, 'PUSH')).toMatchObject({ status: 'PROCESSING' });
      await dispatcher.dispatchDue(new Date(+now + 60_000));
      expect(mine()).toHaveLength(1);
      expect(await job(notificationId, 'PUSH')).toMatchObject({ status: 'COMPLETED', attemptCount: 1, leaseExpiresAt: null });
      expect(DELIVERY_QUEUE_POLICY.leaseMs).toBeGreaterThan(0);
    });
  });

  describe('scope and side effects', () => {
    it('never processes a historical notification that has no delivery job', async () => {
      const u = await newUser();
      const historical = await ctx.prisma.notification.create({
        data: { recipientUserId: u.userId, category: 'SECURITY', channel: 'IN_APP', status: 'SENT', templateCode: 'ACCOUNT_REACTIVATED', renderedTitle: 't', renderedBody: 'b', dedupeKey: 'pre-work-13' },
      });
      const providers = [NotificationChannel.PUSH, NotificationChannel.SMS, NotificationChannel.EMAIL].map((c) => new InMemoryNotificationChannelProvider(c));
      registry.use(...providers);
      await scheduler.tick();
      await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
      expect(providers.flatMap((p) => p.delivered).map((r) => r.notificationId)).not.toContain(historical.id);
      expect(await ctx.prisma.notificationDeliveryJob.count({ where: { notificationId: historical.id } })).toBe(0);
      expect(await ctx.prisma.deliveryAttempt.count({ where: { notificationId: historical.id } })).toBe(0);
      expect(await inboxIds(u.accessToken)).toContain(historical.id);
    });

    it('writes no audit row, outbox event, preference or notification; Module 02’s table stays empty; the inbox stays readable', async () => {
      const { user, notificationId } = await reactivated(await newUser());
      await ctx.drainOutbox();
      const counts = async () => ({
        audit: await ctx.prisma.auditLog.count(),
        outbox: await ctx.prisma.outbox.count(),
        preferences: await ctx.prisma.channelPreference.count(),
        notifications: await ctx.prisma.notification.count(),
        legacy: await ctx.prisma.notificationPreference.count(),
      });
      const before = await counts();
      registry.use(
        new InMemoryNotificationChannelProvider(NotificationChannel.PUSH),
        new InMemoryNotificationChannelProvider(NotificationChannel.SMS, 'FAILED'),
      );
      await scheduler.tick();
      expect(await counts()).toEqual(before);
      expect(before.legacy).toBe(0);
      await request(ctx.server).post(`/notifications/${notificationId}/read`).set(...auth(user.accessToken)).send({}).expect(200);
      expect(await inboxIds(user.accessToken)).toContain(notificationId);
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: notificationId } })).status).toBe('READ');
    });

    it('the queue stores no contact data or credentials', async () => {
      const { user, notificationId } = await reactivated(await newUser());
      registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH));
      await scheduler.tick();
      const raw = JSON.stringify(await jobs(notificationId)) + JSON.stringify(await attempts(notificationId));
      for (const forbidden of [user.phone, user.password, user.accessToken, user.userId]) {
        expect({ forbidden: forbidden.slice(0, 6), found: raw.includes(forbidden) }).toEqual({ forbidden: forbidden.slice(0, 6), found: false });
      }
    });

    // Work 14 made the registry a factory, Work 15 added SMS to it: each channel's provider is bound
    // only when its transport is configured, and nothing at all without them — which is still Work
    // 13's production behaviour.
    it('the shipped module binds no provider without configured transports, only those configured, never the in-memory one', () => {
      type Transport = { isConfigured(): boolean };
      const providers = Reflect.getMetadata('providers', NotificationsModule) as Array<{
        provide?: unknown;
        useFactory?: (pushTransport: Transport, push: INotificationChannelProvider, smsTransport: Transport, sms: INotificationChannelProvider) => INotificationChannelProviderRegistry;
      }>;
      const factory = providers.find((p) => p.provide === NOTIFICATION_CHANNEL_PROVIDER_REGISTRY)!.useFactory!;
      const push = { name: 'fcm', channel: NotificationChannel.PUSH, deliver: async () => ({ outcome: 'NOT_CONFIGURED' as const }) };
      const sms = { name: 'sms', channel: NotificationChannel.SMS, deliver: async () => ({ outcome: 'NOT_CONFIGURED' as const }) };
      const off = { isConfigured: () => false };
      const on = { isConfigured: () => true };
      const unconfigured = factory(off, push, off, sms);
      for (const channel of Object.values(NotificationChannel)) expect(unconfigured.providerFor(channel)).toBeNull();
      const configured = factory(on, push, off, sms);
      expect(Object.values(NotificationChannel).map((c) => configured.providerFor(c)?.name ?? null)).toEqual(['fcm', null, null, null]);
      expect(readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'notifications', 'notifications.module.ts'), 'utf8')).not.toContain('InMemoryNotificationChannelProvider');
    });
  });

  describe('boundaries', () => {
    const moduleRoot = join(__dirname, '..', '..', 'src', 'modules', 'notifications');
    const sources = (): string[] => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      };
      walk(moduleRoot);
      return files;
    };
    const rel = (f: string) => f.replace(/\\/g, '/').split('/modules/notifications/')[1];
    const PRISMA = /PrismaService|@prisma\/client|prisma\.\w+/;

    it('the dispatcher, the scheduler and the providers never touch Prisma', () => {
      const checked = sources().filter((f) => /^(application\/services|application\/ports|infrastructure\/providers|infrastructure\/scheduling)\//.test(rel(f)));
      expect(checked.map(rel).sort()).toEqual([
        'application/ports/outbound/notification-channel-provider.port.ts',
        // Work 14
        'application/ports/outbound/push-transport.port.ts',
        // Work 15
        'application/ports/outbound/sms-transport.port.ts',
        'application/services/notification-delivery.dispatcher.ts',
        'infrastructure/providers/in-memory-notification-channel.provider.ts',
        'infrastructure/providers/notification-channel-provider.registry.ts',
        // Work 14
        'infrastructure/providers/push-notification.provider.ts',
        // Work 15
        'infrastructure/providers/sms-notification.provider.ts',
        'infrastructure/providers/with-deadline.ts',
        'infrastructure/scheduling/notification-delivery.scheduler.ts',
      ]);
      for (const file of checked) expect({ file: rel(file), prisma: PRISMA.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), prisma: false });
    });

    it('jobs and attempts are reached only through the persistence adapters; no controller reaches delivery', () => {
      expect(sources().filter((f) => /prisma\.deliveryAttempt\b|tx\.deliveryAttempt\b/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([
        'infrastructure/persistence/prisma-notification-delivery.repository.ts',
      ]);
      expect(sources().filter((f) => /\.notificationDeliveryJob\b/.test(readFileSync(f, 'utf8'))).map(rel).sort()).toEqual([
        'infrastructure/persistence/prisma-notification-delivery.repository.ts',
        'infrastructure/persistence/prisma-notification.repository.ts',
      ]);
      for (const file of sources().filter((f) => rel(f).startsWith('interface/'))) {
        const found = /notification-delivery|NOTIFICATION_DELIVERY_REPOSITORY|Dispatcher|channel-provider|deliveryAttempt|DeliveryJob/.test(readFileSync(file, 'utf8'));
        expect({ file: rel(file), found }).toEqual({ file: rel(file), found: false });
      }
    });

    it('Module 13 never reaches Module 02 persistence, the deprecated notification_preferences table, raw SQL or Redis', () => {
      for (const file of sources()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [/prisma\.notificationPreference\b/, /\$queryRaw|\$executeRaw/, /modules\/profiles\//, /'(?:\.\.\/)+profiles\//, /[Rr]edis/]) {
          expect({ file: rel(file), forbidden: String(forbidden), found: forbidden.test(source) }).toEqual({ file: rel(file), forbidden: String(forbidden), found: false });
        }
      }
    });
  });
});
