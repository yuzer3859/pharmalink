import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import {
  EMAIL_TRANSPORT,
} from '../../src/modules/notifications/application/ports/outbound/email-transport.port';
import {
  NOTIFICATION_CHANNEL_PROVIDER_REGISTRY,
  INotificationChannelProviderRegistry,
} from '../../src/modules/notifications/application/ports/outbound/notification-channel-provider.port';
import { NotificationDeliveryDispatcher } from '../../src/modules/notifications/application/services/notification-delivery.dispatcher';
import { NotificationChannel } from '../../src/modules/notifications/domain/enums';
import { RESEND_SEND_URL, ResendEmailTransport } from '../../src/modules/notifications/infrastructure/email/resend-email.transport';
import { RESEND_CONFIG_KEYS, ResendConfig } from '../../src/modules/notifications/infrastructure/email/resend.config';
import { NOTIFICATION_DELIVERY_INTERVAL } from '../../src/modules/notifications/infrastructure/scheduling/notification-delivery.scheduler';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { IConfigPort } from '../../src/shared/config/config.port';
import { AppLogger } from '../../src/shared/logging/app-logger.service';
import { auth, body, createUserWithRole, login, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const PASSWORD = 'Str0ng!Passw0rd';
const API_KEY = 're_E2E_FAKE_KEY_0123456789_SECRET';
const FROM = 'PharmaLink <alerts@notify.example.com>';
type EmailUser = { userId: string; email: string } & Tokens;
type Script = { status: number; body: unknown } | 'TIMEOUT' | 'NETWORK';

/**
 * Stands in for api.resend.com only. Everything above it is production code: the registry factory
 * (which registers the e-mail provider because the transport is configured), `EmailNotificationProvider`,
 * Module 01's contact port, the dispatcher and `ResendEmailTransport` — its request, headers,
 * idempotency key, timeout and error mapping.
 */
class FakeResend {
  calls: Array<{ url: string; headers: Record<string, string>; body: { from: string; to: string[]; subject: string; text: string } }> = [];
  next: Script[] = [];
  fetch = (async (url: string, init: RequestInit) => {
    this.calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const s = this.next.shift() ?? { status: 200, body: { id: `re-msg-${this.calls.length}` } };
    if (s === 'TIMEOUT') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (s === 'NETWORK') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(s.body), { status: s.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}
const resendError = (status: number, name: string, to = '') => ({ status, body: { statusCode: status, name, message: `Refused ${to} with key ${API_KEY}` } });

/** Module 13 Work 17 against real PostgreSQL: the Resend transport on the e-mail delivery queue. */
describe('Resend e-mail provider (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const resend = new FakeResend();
  const settings: Record<string, string | undefined> = { [RESEND_CONFIG_KEYS.apiKey]: API_KEY, [RESEND_CONFIG_KEYS.fromEmail]: FROM };
  const configPort = { get: (k: string) => settings[k], getOrThrow: () => '', isFeatureEnabled: () => false } as unknown as IConfigPort;

  beforeAll(async () => {
    const transport = new ResendEmailTransport(new ResendConfig(configPort), new AppLogger(), resend.fetch);
    ctx = await createTestApp([{ provide: EMAIL_TRANSPORT, useValue: transport }]);
    dispatcher = ctx.app.get(NotificationDeliveryDispatcher);
    ctx.app.get(SchedulerRegistry).deleteInterval(NOTIFICATION_DELIVERY_INTERVAL);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    resend.calls = [];
    resend.next = [];
    settings[RESEND_CONFIG_KEYS.apiKey] = API_KEY;
    settings[RESEND_CONFIG_KEYS.fromEmail] = FROM;
  });

  /** Module 01's own e-mail registration: register → OTP to the address → verify. */
  async function emailUser(): Promise<EmailUser> {
    const email = `customer.${randomUUID().slice(0, 8)}@example.com`;
    const res = await request(ctx.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    await ctx.drainOutbox();
    const code = ctx.notifications.lastCodeFor(email, 'otp-register');
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(201);
    return { userId: body(res).userId as string, email, ...(await login(ctx, email, PASSWORD)) };
  }
  /** A real ACCOUNT_REACTIVATED notification via Module 01's suspend → reactivate; the suspension's e-mail job is settled so it does not interfere. */
  async function reactivation(u: EmailUser) {
    await request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(u.accessToken)).send({ channels: [{ channel: 'EMAIL', enabled: true }] }).expect(200);
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server).post(`/admin/users/${u.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await request(ctx.server).post(`/admin/users/${u.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    const suspended = await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: u.userId, templateCode: 'ACCOUNT_SUSPENDED' } });
    await ctx.prisma.notificationDeliveryJob.updateMany({ where: { notificationId: suspended.id }, data: { status: 'COMPLETED' } });
    const n = await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: u.userId, templateCode: 'ACCOUNT_REACTIVATED' } });
    return { user: { ...u, ...(await login(ctx, u.email, PASSWORD)) }, n };
  }
  const job = (notificationId: string) => ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { notificationId_channel: { notificationId, channel: 'EMAIL' } } });
  const attempts = (notificationId: string) => ctx.prisma.deliveryAttempt.findMany({ where: { notificationId, channel: 'EMAIL' }, orderBy: { attemptNumber: 'asc' } });
  const soon = () => new Date(Date.now() + 1_000);

  it('sends the exact Resend request for the right recipient and records SENT with the Resend id', async () => {
    const a = await emailUser();
    const b = await emailUser();
    const { user, n } = await reactivation(a);
    expect((await ctx.prisma.notificationDeliveryJob.findMany({ where: { notificationId: n.id, channel: 'EMAIL' } })).length).toBe(1);

    await dispatcher.dispatchDue(soon());
    const mine = resend.calls.filter((c) => c.body.to[0] === a.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({
      url: RESEND_SEND_URL,
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', 'idempotency-key': `notification-email/${n.id}` },
      body: { from: FROM, to: [a.email], subject: n.renderedTitle, text: n.renderedBody },
    });
    expect(resend.calls.some((c) => c.body.to.includes(b.email))).toBe(false);
    expect(await job(n.id)).toMatchObject({ status: 'COMPLETED', attemptCount: 1, lastErrorCode: null });
    expect((await attempts(n.id)).map((x) => [x.attemptNumber, x.status, x.provider, x.providerMsgId, x.errorCode, x.errorDetail])).toEqual([
      [1, 'SENT', 'resend', 're-msg-1', null, null],
    ]);
    // In-app unchanged, still served.
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('SENT');
    const inbox = (body(await request(ctx.server).get('/notifications').set(...auth(user.accessToken)).expect(200)) as unknown as { items: Array<{ id: string }> }).items;
    expect(inbox.map((i) => i.id)).toContain(n.id);
  });

  it('429 and 5xx retry on the backoff schedule with the same idempotency key; a timeout is a retryable EMAIL_TIMEOUT', async () => {
    const a = await emailUser();
    const { n } = await reactivation(a);
    resend.next = [resendError(429, 'rate_limit_exceeded'), resendError(503, 'service_unavailable'), 'TIMEOUT', 'NETWORK'];
    let now = soon();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatchDue(now);
      const j = await job(n.id);
      if (j.status !== 'PENDING') break;
      delays.push(+j.nextAttemptAt - +now);
      now = j.nextAttemptAt;
    }
    expect(delays).toEqual([30_000, 120_000, 600_000, 1_800_000]);
    expect((await attempts(n.id)).map((x) => [x.attemptNumber, x.status, x.errorCode, x.errorDetail])).toEqual([
      [1, 'FAILED', 'EMAIL_RATE_LIMITED', null],
      [2, 'FAILED', 'EMAIL_UNAVAILABLE', null],
      [3, 'FAILED', 'EMAIL_TIMEOUT', null],
      [4, 'FAILED', 'EMAIL_NETWORK_ERROR', null],
      [5, 'SENT', null, null],
    ]);
    expect(new Set(resend.calls.map((c) => c.headers['idempotency-key']))).toEqual(new Set([`notification-email/${n.id}`]));
    expect(await job(n.id)).toMatchObject({ status: 'COMPLETED', attemptCount: 5 });
  });

  it('an invalid recipient (422 validation_error) ends the job after one attempt', async () => {
    const a = await emailUser();
    const { n } = await reactivation(a);
    resend.next = [resendError(422, 'validation_error', a.email)];
    await dispatcher.dispatchDue(soon());
    await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
    expect(await job(n.id)).toMatchObject({ status: 'EXHAUSTED', attemptCount: 1, lastErrorCode: 'EMAIL_REJECTED' });
    expect(resend.calls).toHaveLength(1);
  });

  it('an unverified sender domain (403) or a bad key (401) pauses the job: PENDING, no attempt, no retry used', async () => {
    const a = await emailUser();
    const { n } = await reactivation(a);
    resend.next = [resendError(403, 'validation_error'), resendError(401, 'missing_api_key')];
    await dispatcher.dispatchDue(soon());
    expect(await job(n.id)).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    await dispatcher.dispatchDue(new Date(Date.now() + 10 * 60_000));
    expect(await job(n.id)).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    expect(await attempts(n.id)).toEqual([]);
    // Once fixed, it goes out.
    await dispatcher.dispatchDue(new Date(Date.now() + 20 * 60_000));
    expect(await job(n.id)).toMatchObject({ status: 'COMPLETED', attemptCount: 1 });
  });

  it('credentials removed at runtime → NOT_CONFIGURED: job waits with no attempt and no request', async () => {
    const a = await emailUser();
    const { n } = await reactivation(a);
    settings[RESEND_CONFIG_KEYS.fromEmail] = undefined;
    await dispatcher.dispatchDue(soon());
    expect(resend.calls).toEqual([]);
    expect(await job(n.id)).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    expect(await attempts(n.id)).toEqual([]);
  });

  it('no API key, sender, address or Resend message text in jobs, attempts, notifications, responses, audit or output; SMS / PUSH untouched; no real network', async () => {
    const out: string[] = [];
    const capture = (stream: NodeJS.WriteStream) =>
      jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
        out.push(String(chunk));
        return true;
      }) as never);
    const streams = [capture(process.stdout), capture(process.stderr)];
    try {
      const a = await emailUser();
      const { user, n } = await reactivation(a);
      resend.next = [resendError(503, 'service_unavailable', a.email)];
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
        (await request(ctx.server).post(`/notifications/${n.id}/read`).set(...auth(user.accessToken)).send({})).body,
      ];
      expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
      const persisted = JSON.stringify([
        await ctx.prisma.notification.findMany(),
        await ctx.prisma.notificationDeliveryJob.findMany(),
        await ctx.prisma.deliveryAttempt.findMany(),
        responses,
        out,
      ]);
      for (const secret of [API_KEY, 're_E2E', 'alerts@notify', a.email, 'Refused']) {
        expect({ secret, found: persisted.includes(secret) }).toEqual({ secret, found: false });
      }
      // SMS and PUSH have no configured transport here: their jobs wait, untouched.
      const others = await ctx.prisma.notificationDeliveryJob.findMany({ where: { notificationId: n.id, channel: { in: ['SMS', 'PUSH'] } } });
      expect(others.map((j) => [j.channel, j.status, j.attemptCount]).sort()).toEqual([
        ['PUSH', 'PENDING', 0],
        ['SMS', 'PENDING', 0],
      ]);
    } finally {
      for (const s of streams) s.mockRestore();
    }
  });
});

describe('Resend e-mail provider — production wiring without credentials (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    ctx.app.get(SchedulerRegistry).deleteInterval(NOTIFICATION_DELIVERY_INTERVAL);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  it('binds ResendEmailTransport, unconfigured (no RESEND_* and NODE_ENV=test): no e-mail provider, jobs stay PENDING, no attempt, no request', async () => {
    await ctx.reset();
    expect(ctx.app.get(EMAIL_TRANSPORT)).toBeInstanceOf(ResendEmailTransport);
    expect((ctx.app.get(EMAIL_TRANSPORT) as ResendEmailTransport).isConfigured()).toBe(false);
    const registry = ctx.app.get<INotificationChannelProviderRegistry>(NOTIFICATION_CHANNEL_PROVIDER_REGISTRY);
    expect(registry.providerFor(NotificationChannel.EMAIL)).toBeNull();

    const email = `customer.${randomUUID().slice(0, 8)}@example.com`;
    const res = await request(ctx.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    await ctx.drainOutbox();
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: email, code: ctx.notifications.lastCodeFor(email, 'otp-register'), purpose: OtpPurpose.REGISTER })
      .expect(201);
    const userId = body(res).userId as string;
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server).post(`/admin/users/${userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await ctx.drainOutbox();
    const n = await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: userId } });

    const spies = [jest.spyOn(http, 'request'), jest.spyOn(https, 'request'), jest.spyOn(globalThis, 'fetch')];
    try {
      await ctx.app.get(NotificationDeliveryDispatcher).dispatchDue(new Date(Date.now() + 86_400_000));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { notificationId_channel: { notificationId: n.id, channel: 'EMAIL' } } })).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
    });
    expect(await ctx.prisma.deliveryAttempt.count()).toBe(0);
  });
});
