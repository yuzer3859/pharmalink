import { readdirSync, readFileSync, statSync } from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import { join } from 'path';
import request from 'supertest';
import { NOTIFICATION_CHANNEL_PROVIDER_REGISTRY } from '../../src/modules/notifications/application/ports/outbound/notification-channel-provider.port';
import type {
  INotificationChannelProvider,
  INotificationChannelProviderRegistry,
} from '../../src/modules/notifications/application/ports/outbound/notification-channel-provider.port';
import { NotificationDeliveryService } from '../../src/modules/notifications/application/services/notification-delivery.service';
import { NotificationChannel } from '../../src/modules/notifications/domain/enums';
import { InMemoryNotificationChannelProvider } from '../../src/modules/notifications/infrastructure/providers/in-memory-notification-channel.provider';
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
 * Module 13 Work 12 against real PostgreSQL: a notification produced by an existing event path
 * (Module 01's suspend/reactivate, Work 01), preferences set through Work 11's own route, then
 * `NotificationDeliveryService` — with the non-production in-memory providers, or none at all as
 * production binds — writing `delivery_attempts`.
 */
describe('Notification delivery foundation (e2e)', () => {
  let ctx: TestContext;
  let delivery: NotificationDeliveryService;
  const registry = new ScriptedRegistry();

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: NOTIFICATION_CHANNEL_PROVIDER_REGISTRY, useValue: registry }]);
    delivery = ctx.app.get(NotificationDeliveryService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    registry.use();
  });

  /** A user with a real SECURITY notification (account reactivated) in their inbox. */
  async function userWithNotification(prefs: Array<{ channel: string; enabled: boolean }> = []) {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const registered = await registerAndVerify(ctx);
    let user: User = { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
    if (prefs.length > 0) {
      await request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(user.accessToken)).send({ channels: prefs }).expect(200);
    }
    await request(ctx.server).post(`/admin/users/${user.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await request(ctx.server).post(`/admin/users/${user.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    user = { ...user, ...(await login(ctx, registered.phone, registered.password)) };
    const row = await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: user.userId, templateCode: 'ACCOUNT_REACTIVATED' } });
    return { user, notificationId: row.id };
  }

  // Alphabetical by channel, then attempt number (Postgres would order the enum by declaration).
  const attempts = async (notificationId: string) =>
    (await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId } })).sort(
      (a, b) => a.channel.localeCompare(b.channel) || a.attemptNumber - b.attemptNumber,
    );
  const inbox = async (token: string) =>
    (body(await request(ctx.server).get('/notifications').set(...auth(token)).expect(200)) as unknown as { items: Array<{ id: string; type: string }> }).items;

  it('applies stored preferences: disabled channels are SUPPRESSED, enabled ones go to the test provider and are SENT', async () => {
    const { user, notificationId } = await userWithNotification([
      { channel: 'SMS', enabled: false },
      { channel: 'PUSH', enabled: true },
    ]);
    const push = new InMemoryNotificationChannelProvider(NotificationChannel.PUSH);
    const sms = new InMemoryNotificationChannelProvider(NotificationChannel.SMS);
    const email = new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL);
    registry.use(push, sms, email);

    const result = await delivery.deliver(notificationId);
    expect(result).toEqual({
      status: 'PROCESSED',
      channels: [
        { channel: 'IN_APP', outcome: 'IN_APP_RECORDED' },
        { channel: 'PUSH', outcome: 'SENT', attemptNumber: 1 },
        { channel: 'SMS', outcome: 'SUPPRESSED', attemptNumber: 1 },
        { channel: 'EMAIL', outcome: 'SENT', attemptNumber: 1 },
      ],
    });
    expect(sms.delivered).toEqual([]);
    expect(push.delivered).toEqual([
      expect.objectContaining({ notificationId, channel: 'PUSH', category: 'SECURITY', recipient: { userId: user.userId } }),
    ]);
    expect((await attempts(notificationId)).map((a) => [a.channel, a.attemptNumber, a.status, a.provider, a.providerMsgId, a.errorCode, a.errorDetail])).toEqual([
      ['PUSH', 1, 'SENT', 'in-memory-push', `in-memory:PUSH:${notificationId}`, null, null],
      ['SMS', 1, 'SUPPRESSED', null, null, 'PREFERENCE_DISABLED', null],
      ['EMAIL', 1, 'SENT', 'in-memory-email', `in-memory:EMAIL:${notificationId}`, null, null],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

    // The in-app copy is untouched and still served.
    expect(await ctx.prisma.notification.findUniqueOrThrow({ where: { id: notificationId } })).toMatchObject({ channel: 'IN_APP', status: 'SENT' });
    expect((await inbox(user.accessToken)).map((i) => i.id)).toContain(notificationId);
  });

  it('persists a provider failure safely, and retries it as attempt 2 on the next call', async () => {
    const { notificationId } = await userWithNotification();
    registry.use(
      new InMemoryNotificationChannelProvider(NotificationChannel.PUSH, 'FAILED', 'DEVICE_UNREGISTERED'),
      new InMemoryNotificationChannelProvider(NotificationChannel.SMS, 'THROW'),
      new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL),
    );
    await delivery.deliver(notificationId);
    const failed = await attempts(notificationId);
    expect(failed.map((a) => [a.channel, a.status, a.errorCode, a.errorDetail])).toEqual([
      ['PUSH', 'FAILED', 'DEVICE_UNREGISTERED', null],
      ['SMS', 'FAILED', 'PROVIDER_ERROR', null],
      ['EMAIL', 'SENT', null, null],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    expect(JSON.stringify(failed)).not.toContain('in-memory provider failure');

    registry.use(...[NotificationChannel.PUSH, NotificationChannel.SMS, NotificationChannel.EMAIL].map((c) => new InMemoryNotificationChannelProvider(c)));
    const second = await delivery.deliver(notificationId);
    expect(second.status === 'PROCESSED' && second.channels.map((c) => [c.channel, c.outcome, c.attemptNumber])).toEqual([
      ['IN_APP', 'IN_APP_RECORDED', undefined],
      ['PUSH', 'SENT', 2],
      ['SMS', 'SENT', 2],
      ['EMAIL', 'ALREADY_SETTLED', undefined],
    ]);
    expect(await ctx.prisma.deliveryAttempt.count({ where: { notificationId } })).toBe(5);
  });

  it('with no provider bound — production’s wiring — records CHANNEL_NOT_CONFIGURED and makes no network call', async () => {
    const { user, notificationId } = await userWithNotification([{ channel: 'EMAIL', enabled: false }]);
    const spies = [
      jest.spyOn(http, 'request'),
      jest.spyOn(https, 'request'),
      jest.spyOn(net.Socket.prototype, 'connect'),
      ...(typeof globalThis.fetch === 'function' ? [jest.spyOn(globalThis, 'fetch')] : []),
    ];
    try {
      await delivery.deliver(notificationId);
      await delivery.deliver(notificationId);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect((await attempts(notificationId)).map((a) => [a.channel, a.attemptNumber, a.status, a.provider, a.errorCode])).toEqual([
      ['EMAIL', 1, 'SUPPRESSED', null, 'PREFERENCE_DISABLED'],
      ['PUSH', 1, 'FAILED', null, 'CHANNEL_NOT_CONFIGURED'],
      ['PUSH', 2, 'FAILED', null, 'CHANNEL_NOT_CONFIGURED'],
      ['SMS', 1, 'FAILED', null, 'CHANNEL_NOT_CONFIGURED'],
      ['SMS', 2, 'FAILED', null, 'CHANNEL_NOT_CONFIGURED'],
    ].sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)));
    expect((await inbox(user.accessToken)).map((i) => i.id)).toContain(notificationId);
  });

  it('the shipped module binds no provider for any channel, and never the in-memory one', () => {
    const providers = Reflect.getMetadata('providers', NotificationsModule) as Array<{ provide?: unknown; useValue?: INotificationChannelProviderRegistry }>;
    const bound = providers.find((p) => p.provide === NOTIFICATION_CHANNEL_PROVIDER_REGISTRY)!;
    for (const channel of Object.values(NotificationChannel)) expect(bound.useValue!.providerFor(channel)).toBeNull();
    const moduleSource = readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'notifications', 'notifications.module.ts'), 'utf8');
    expect(moduleSource).not.toContain('InMemoryNotificationChannelProvider');
  });

  it('repeated delivery leaves the notification row, its read state and the inbox exactly as they were; no duplicate IN_APP row', async () => {
    const { user, notificationId } = await userWithNotification();
    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH));
    await request(ctx.server).post(`/notifications/${notificationId}/read`).set(...auth(user.accessToken)).send({}).expect(200);
    const before = await ctx.prisma.notification.findMany({ orderBy: { id: 'asc' } });
    await Promise.all([delivery.deliver(notificationId), delivery.deliver(notificationId)]);
    await delivery.deliver(notificationId);
    expect(await ctx.prisma.notification.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await ctx.prisma.notification.count({ where: { recipientUserId: user.userId, channel: 'IN_APP' } })).toBe(before.filter((n) => n.recipientUserId === user.userId).length);
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: notificationId } })).status).toBe('READ');
    expect(await ctx.prisma.notification.count({ where: { channel: { not: 'IN_APP' } } })).toBe(0);
  });

  it('writes no audit row, no outbox event, no preference, and never touches Module 02’s deprecated table', async () => {
    const { notificationId } = await userWithNotification([{ channel: 'SMS', enabled: false }]);
    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH));
    const counts = async () => ({
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
      preferences: await ctx.prisma.channelPreference.count(),
      legacy: await ctx.prisma.notificationPreference.count(),
      notifications: await ctx.prisma.notification.count(),
    });
    const before = await counts();
    await delivery.deliver(notificationId);
    expect(await counts()).toEqual(before);
    expect(before.legacy).toBe(0);
    expect(await ctx.prisma.deliveryAttempt.count()).toBe(3);
  });

  it('an unknown notification id records nothing', async () => {
    expect(await delivery.deliver('00000000-0000-4000-8000-000000000000')).toEqual({ status: 'NOT_FOUND' });
    expect(await ctx.prisma.deliveryAttempt.count()).toBe(0);
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

    it('the delivery service and the providers never touch Prisma', () => {
      const checked = sources().filter((f) => /application\/services\/|infrastructure\/providers\/|application\/ports\//.test(rel(f)));
      expect(checked.map(rel).sort()).toEqual([
        'application/ports/outbound/notification-channel-provider.port.ts',
        'application/services/notification-delivery.service.ts',
        'infrastructure/providers/in-memory-notification-channel.provider.ts',
        'infrastructure/providers/notification-channel-provider.registry.ts',
      ]);
      for (const file of checked) expect({ file: rel(file), prisma: PRISMA.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), prisma: false });
    });

    it('only the delivery adapter touches delivery_attempts, and no controller reaches delivery at all', () => {
      expect(sources().filter((f) => /prisma\.deliveryAttempt\b/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([
        'infrastructure/persistence/prisma-notification-delivery.repository.ts',
      ]);
      for (const file of sources().filter((f) => rel(f).startsWith('interface/'))) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /notification-delivery|NOTIFICATION_DELIVERY_REPOSITORY|NotificationDeliveryService|channel-provider|deliveryAttempt/.test(source) }).toEqual({
          file: rel(file),
          found: false,
        });
      }
    });

    it('Module 13 never reaches Module 02 persistence nor the deprecated notification_preferences table', () => {
      for (const file of sources()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [/prisma\.notificationPreference\b/, /\$queryRaw|\$executeRaw/,/modules\/profiles\//, /'(?:\.\.\/)+profiles\//]) {
          expect({ file: rel(file), forbidden: String(forbidden), found: forbidden.test(source) }).toEqual({ file: rel(file), forbidden: String(forbidden), found: false });
        }
      }
    });
  });
});
