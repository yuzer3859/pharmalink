import { readdirSync, readFileSync, statSync } from 'fs';
import http from 'http';
import https from 'https';
import { join } from 'path';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import {
  INotificationChannelProvider,
  INotificationChannelProviderRegistry,
  NOTIFICATION_CHANNEL_PROVIDER_REGISTRY,
} from '../../src/modules/notifications/application/ports/outbound/notification-channel-provider.port';
import { SMS_TRANSPORT } from '../../src/modules/notifications/application/ports/outbound/sms-transport.port';
import { NotificationDeliveryDispatcher } from '../../src/modules/notifications/application/services/notification-delivery.dispatcher';
import { NotificationChannel } from '../../src/modules/notifications/domain/enums';
import { NOTIFICATION_DELIVERY_INTERVAL } from '../../src/modules/notifications/infrastructure/scheduling/notification-delivery.scheduler';
import { InMemorySmsTransport } from '../../src/modules/notifications/infrastructure/sms/in-memory-sms.transport';
import { UnconfiguredSmsTransport } from '../../src/modules/notifications/infrastructure/sms/unconfigured-sms.transport';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { auth, body, createUserWithRole, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;

/**
 * Module 13 Work 15 against real PostgreSQL: SMS on the delivery queue, the recipient's phone read
 * through Module 01's real `IDENTITY_CONTACT_READ_PORT`. No SMS gateway is approved, so the only
 * stand-in is the gateway itself — the non-production `InMemorySmsTransport` bound to
 * `SMS_TRANSPORT` — and everything above it (registry, provider, contact port, dispatcher) is the
 * production wiring.
 */
describe('SMS notifications (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const gateway = new InMemorySmsTransport();

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: SMS_TRANSPORT, useValue: gateway }]);
    dispatcher = ctx.app.get(NotificationDeliveryDispatcher);
    ctx.app.get(SchedulerRegistry).deleteInterval(NOTIFICATION_DELIVERY_INTERVAL);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    gateway.sent.length = 0;
    gateway.script.clear();
  });

  async function newUser(): Promise<User> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }
  const e164 = async (u: User) => (await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.userId } })).phone!;
  const setSms = (u: User, enabled: boolean) =>
    request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(u.accessToken)).send({ channels: [{ channel: 'SMS', enabled }] }).expect(200);
  const setLanguage = (u: User, preferredLanguage: 'am' | 'en') =>
    request(ctx.server).patch('/users/me').set(...auth(u.accessToken)).send({ preferredLanguage }).expect(200);

  /** Module 01's own suspend → reactivate: two real SECURITY notifications. */
  async function cycle(u: User) {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const before = (await ctx.prisma.notification.findMany({ where: { recipientUserId: u.userId }, select: { id: true } })).map((n) => n.id);
    await request(ctx.server).post(`/admin/users/${u.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await request(ctx.server).post(`/admin/users/${u.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    const fresh = await ctx.prisma.notification.findMany({ where: { recipientUserId: u.userId, id: { notIn: before } } });
    return {
      user: { ...u, ...(await login(ctx, u.phone, u.password)) },
      suspended: fresh.find((n) => n.templateCode === 'ACCOUNT_SUSPENDED')!,
      reactivated: fresh.find((n) => n.templateCode === 'ACCOUNT_REACTIVATED')!,
    };
  }
  const smsJob = (notificationId: string) => ctx.prisma.notificationDeliveryJob.findUnique({ where: { notificationId_channel: { notificationId, channel: 'SMS' } } });
  const smsAttempts = (notificationId: string) => ctx.prisma.deliveryAttempt.findMany({ where: { notificationId, channel: 'SMS' }, orderBy: { attemptNumber: 'asc' } });
  const soon = () => new Date(Date.now() + 1_000);
  const inboxIds = async (u: User) =>
    ((body(await request(ctx.server).get('/notifications').set(...auth(u.accessToken)).expect(200)) as unknown as { items: Array<{ id: string }> }).items).map((i) => i.id);

  it('texts A’s notification body to A’s verified phone — not B’s — and completes the job with a safe attempt', async () => {
    const a = await newUser();
    const b = await newUser();
    const phoneA = await e164(a);
    const phoneB = await e164(b);
    expect(phoneA).not.toBe(phoneB);
    const { user, reactivated } = await cycle(a);
    expect(await smsJob(reactivated.id)).toMatchObject({ status: 'PENDING', attemptCount: 0 });

    await dispatcher.dispatchDue(soon());
    const mine = gateway.sent.filter((s) => s.to === phoneA);
    expect(mine.map((s) => s.text).sort()).toEqual([reactivated.renderedBody, (await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: a.userId, templateCode: 'ACCOUNT_SUSPENDED' } })).renderedBody].sort());
    expect(gateway.sent.every((s) => s.to !== phoneB)).toBe(true);
    expect(await smsJob(reactivated.id)).toMatchObject({ status: 'COMPLETED', attemptCount: 1, leaseExpiresAt: null });
    expect((await smsAttempts(reactivated.id)).map((x) => [x.attemptNumber, x.status, x.provider, x.errorCode, x.errorDetail])).toEqual([[1, 'SENT', 'sms-in-memory', null, null]]);
    expect(await inboxIds(user)).toContain(reactivated.id);
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: reactivated.id } })).status).toBe('SENT');
  });

  it('an Amharic-speaking user gets the Amharic body', async () => {
    const a = await newUser();
    await setLanguage(a, 'am');
    const { reactivated } = await cycle(a);
    await dispatcher.dispatchDue(soon());
    const text = gateway.sent.find((s) => s.text === reactivated.renderedBody)!.text;
    expect(text).toMatch(/[ሀ-፿]/);
    expect(text).not.toContain(reactivated.id);
  });

  it('SMS disabled → no job; re-enabled → a new job; disabled after queuing → SUPPRESSED and never resurrected', async () => {
    const a = await newUser();
    await setSms(a, false);
    const off = await cycle(a);
    expect(await smsJob(off.reactivated.id)).toBeNull();

    await setSms(off.user, true);
    const on = await cycle(off.user);
    expect(await smsJob(on.reactivated.id)).toMatchObject({ status: 'PENDING' });

    await setSms(on.user, false);
    await dispatcher.dispatchDue(soon());
    expect(await smsJob(on.reactivated.id)).toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'PREFERENCE_DISABLED' });
    expect(gateway.sent).toEqual([]);
    await setSms(on.user, true);
    await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
    expect(gateway.sent).toEqual([]);
  });

  it('a gateway failure and a timeout are retried on the backoff schedule', async () => {
    const a = await newUser();
    const phone = await e164(a);
    const { reactivated } = await cycle(a);
    // Only the reactivation's job matters here; settle the suspension's first.
    const suspendedJob = await ctx.prisma.notificationDeliveryJob.findFirstOrThrow({ where: { channel: 'SMS', notification: { recipientUserId: a.userId, templateCode: 'ACCOUNT_SUSPENDED' } } });
    await ctx.prisma.notificationDeliveryJob.update({ where: { id: suspendedJob.id }, data: { status: 'COMPLETED' } });

    gateway.script.set(phone, { kind: 'TRANSIENT', code: 'SMS_UNAVAILABLE' });
    const t0 = soon();
    await dispatcher.dispatchDue(t0);
    let job = (await smsJob(reactivated.id))!;
    expect(job).toMatchObject({ status: 'PENDING', attemptCount: 1, lastErrorCode: 'SMS_UNAVAILABLE' });
    expect(+job.nextAttemptAt - +t0).toBe(30_000);

    gateway.script.set(phone, { kind: 'TRANSIENT', code: 'SMS_TIMEOUT' });
    await dispatcher.dispatchDue(job.nextAttemptAt);
    job = (await smsJob(reactivated.id))!;
    expect(job).toMatchObject({ status: 'PENDING', attemptCount: 2, lastErrorCode: 'SMS_TIMEOUT' });
    expect(+job.nextAttemptAt - +(await smsAttempts(reactivated.id))[1].attemptedAt).toBeGreaterThan(0);

    gateway.script.delete(phone);
    await dispatcher.dispatchDue(job.nextAttemptAt);
    expect((await smsAttempts(reactivated.id)).map((x) => [x.attemptNumber, x.status, x.errorCode])).toEqual([
      [1, 'FAILED', 'SMS_UNAVAILABLE'],
      [2, 'FAILED', 'SMS_TIMEOUT'],
      [3, 'SENT', null],
    ]);
  });

  it('a permanently invalid recipient, or an unverified phone, ends the job after one attempt', async () => {
    const a = await newUser();
    gateway.script.set(await e164(a), { kind: 'INVALID_RECIPIENT', code: 'SMS_INVALID_NUMBER' });
    const first = await cycle(a);
    await dispatcher.dispatchDue(soon());
    await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
    expect(await smsJob(first.reactivated.id)).toMatchObject({ status: 'EXHAUSTED', attemptCount: 1, lastErrorCode: 'SMS_INVALID_NUMBER' });

    // Module 01 says the phone is no longer verified: no SMS, one terminal attempt.
    gateway.script.clear();
    await ctx.prisma.user.update({ where: { id: a.userId }, data: { phoneVerifiedAt: null } });
    const second = await cycle(first.user);
    const sentBefore = gateway.sent.length;
    await dispatcher.dispatchDue(soon());
    expect(gateway.sent).toHaveLength(sentBefore);
    expect((await smsAttempts(second.reactivated.id)).map((x) => [x.attemptNumber, x.status, x.errorCode])).toEqual([[1, 'FAILED', 'SMS_RECIPIENT_UNVERIFIED']]);
    expect(await smsJob(second.reactivated.id)).toMatchObject({ status: 'EXHAUSTED' });
  });

  it('the raw phone is nowhere: payload, jobs, attempts, HTTP responses, audit, captured output; no audit from SMS or reads; no network', async () => {
    const out: string[] = [];
    const capture = (stream: NodeJS.WriteStream) =>
      jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
        out.push(String(chunk));
        return true;
      }) as never);
    const streams = [capture(process.stdout), capture(process.stderr)];
    try {
      const a = await newUser();
      const phone = await e164(a);
      const { user, reactivated } = await cycle(a);
      gateway.script.set(phone, 'THROW');
      const auditBefore = await ctx.prisma.auditLog.count();
      const network = [jest.spyOn(http, 'request'), jest.spyOn(https, 'request')];
      try {
        await dispatcher.dispatchDue(soon());
        for (const spy of network) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of network) spy.mockRestore();
      }
      const responses = [
        (await request(ctx.server).get('/notifications').set(...auth(user.accessToken))).body,
        (await request(ctx.server).get('/notifications/unread-count').set(...auth(user.accessToken))).body,
        (await request(ctx.server).post(`/notifications/${reactivated.id}/read`).set(...auth(user.accessToken)).send({})).body,
        (await request(ctx.server).get('/notification-preferences').set(...auth(user.accessToken))).body,
      ];
      expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);

      const local = phone.replace('+251', '');
      const persisted = JSON.stringify([
        await ctx.prisma.notification.findMany({ where: { recipientUserId: a.userId } }),
        await ctx.prisma.notificationDeliveryJob.findMany(),
        await ctx.prisma.deliveryAttempt.findMany(),
        await ctx.prisma.auditLog.findMany({ where: { createdAt: { gte: new Date(Date.now() - 60_000) } }, select: { action: true, context: true } }),
        responses,
        out,
      ]);
      for (const secret of [phone, local, 'FAKE_SMS_SECRET', 'exploded']) {
        expect({ secret, found: persisted.includes(secret) }).toEqual({ secret, found: false });
      }
      expect((await smsAttempts(reactivated.id))[0]).toMatchObject({ status: 'FAILED', errorCode: 'SMS_NETWORK_ERROR', errorDetail: null });
    } finally {
      for (const s of streams) s.mockRestore();
    }
  });

  it('production binds the unconfigured transport, so no SMS provider is registered and jobs wait; PUSH is unaffected', async () => {
    const providers = Reflect.getMetadata('providers', NotificationsModule) as Array<{ provide?: unknown; useClass?: unknown; useFactory?: (...a: unknown[]) => INotificationChannelProviderRegistry }>;
    expect(providers.find((p) => p.provide === SMS_TRANSPORT)!.useClass).toBe(UnconfiguredSmsTransport);
    const factory = providers.find((p) => p.provide === NOTIFICATION_CHANNEL_PROVIDER_REGISTRY)!.useFactory!;
    const fake = (channel: NotificationChannel, name: string): INotificationChannelProvider => ({ name, channel, deliver: async () => ({ outcome: 'NOT_CONFIGURED' }) });
    const reg = factory({ isConfigured: () => false }, fake(NotificationChannel.PUSH, 'fcm'), new UnconfiguredSmsTransport(), fake(NotificationChannel.SMS, 'sms'));
    expect(Object.values(NotificationChannel).map((c) => reg.providerFor(c))).toEqual([null, null, null, null]);
    const both = factory({ isConfigured: () => true }, fake(NotificationChannel.PUSH, 'fcm'), gateway, fake(NotificationChannel.SMS, 'sms'));
    expect(Object.values(NotificationChannel).map((c) => both.providerFor(c)?.name ?? null)).toEqual(['fcm', 'sms', null, null]);
    expect(readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'notifications', 'notifications.module.ts'), 'utf8')).not.toContain('InMemorySmsTransport');
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

    it('Module 13 reads phones only through Module 01’s contact port; never users / profiles persistence or the deprecated table', () => {
      for (const file of sources(join(root, 'notifications'))) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [/prisma\.(user|customerProfile|notificationPreference)\b/, /identity\/infrastructure\//, /identity\/domain\/(?!events['`])/, /modules\/profiles\/|'(?:\.\.\/)+profiles\//, /secondaryPhone/]) {
          expect({ file: rel(file), forbidden: String(forbidden), found: forbidden.test(source) }).toEqual({ file: rel(file), forbidden: String(forbidden), found: false });
        }
      }
      expect(sources(join(root, 'notifications')).filter((f) => /identity-contact-read\.port/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([
        'notifications/infrastructure/providers/sms-notification.provider.ts',
      ]);
    });

    it('the contact adapter is the one persistence path for it; the SMS transports and provider never touch Prisma', () => {
      expect(sources(root).filter((f) => /IIdentityContactReadPort\b/.test(readFileSync(f, 'utf8')) && /PrismaService/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([
        'identity/infrastructure/persistence/prisma-identity-contact-read.adapter.ts',
      ]);
      for (const file of sources(join(root, 'notifications')).filter((f) => /infrastructure\/(sms|providers)\/|domain\/sms-content|ports\/outbound\/sms-transport/.test(rel(f)))) {
        expect({ file: rel(file), prisma: /PrismaService|@prisma\/client|prisma\.\w+/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), prisma: false });
      }
    });

    it('no SMS credential or configuration key exists anywhere — none has been approved', () => {
      for (const file of sources(join(root, 'notifications'))) {
        expect({ file: rel(file), found: /SMS_GATEWAY_[A-Z_]+'|apiKey\s*[:=]\s*'|sk_sms/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), found: false });
      }
    });
  });
});
