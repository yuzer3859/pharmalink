import { randomUUID } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import { join } from 'path';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { EMAIL_TRANSPORT } from '../../src/modules/notifications/application/ports/outbound/email-transport.port';
import {
  INotificationChannelProvider,
  INotificationChannelProviderRegistry,
  NOTIFICATION_CHANNEL_PROVIDER_REGISTRY,
} from '../../src/modules/notifications/application/ports/outbound/notification-channel-provider.port';
import { NotificationDeliveryDispatcher } from '../../src/modules/notifications/application/services/notification-delivery.dispatcher';
import { NotificationChannel } from '../../src/modules/notifications/domain/enums';
import { InMemoryEmailTransport } from '../../src/modules/notifications/infrastructure/email/in-memory-email.transport';
import { UnconfiguredEmailTransport } from '../../src/modules/notifications/infrastructure/email/unconfigured-email.transport';
import { NOTIFICATION_DELIVERY_INTERVAL } from '../../src/modules/notifications/infrastructure/scheduling/notification-delivery.scheduler';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { auth, body, createUserWithRole, login, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const PASSWORD = 'Str0ng!Passw0rd';
type EmailUser = { userId: string; email: string } & Tokens;

/**
 * Module 13 Work 16 against real PostgreSQL: e-mail on the delivery queue, the recipient's address
 * read through Module 01's real `IDENTITY_CONTACT_READ_PORT`. No e-mail provider is approved, so the
 * only stand-in is the provider itself — the non-production `InMemoryEmailTransport` bound to
 * `EMAIL_TRANSPORT` — and everything above it is the production wiring.
 */
describe('E-mail notifications (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const mailer = new InMemoryEmailTransport();

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: EMAIL_TRANSPORT, useValue: mailer }]);
    dispatcher = ctx.app.get(NotificationDeliveryDispatcher);
    ctx.app.get(SchedulerRegistry).deleteInterval(NOTIFICATION_DELIVERY_INTERVAL);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    mailer.sent.length = 0;
    mailer.script.clear();
  });

  /** Module 01's own e-mail registration: register → OTP to the address → verify (sets emailVerifiedAt). */
  async function emailUser(): Promise<EmailUser> {
    const email = `Customer.${randomUUID().slice(0, 8)}@Example.com`;
    const res = await request(ctx.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    await ctx.drainOutbox();
    const normalized = email.toLowerCase();
    const code = ctx.notifications.lastCodeFor(normalized, 'otp-register');
    await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(201);
    return { userId: body(res).userId as string, email: normalized, ...(await login(ctx, normalized, PASSWORD)) };
  }
  const setEmail = (u: EmailUser, enabled: boolean) =>
    request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(u.accessToken)).send({ channels: [{ channel: 'EMAIL', enabled }] }).expect(200);
  const setLanguage = (u: EmailUser, preferredLanguage: 'am' | 'en') =>
    request(ctx.server).patch('/users/me').set(...auth(u.accessToken)).send({ preferredLanguage }).expect(200);

  /** Module 01's own suspend → reactivate: two real SECURITY notifications. */
  async function cycle(u: EmailUser) {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const before = (await ctx.prisma.notification.findMany({ where: { recipientUserId: u.userId }, select: { id: true } })).map((n) => n.id);
    await request(ctx.server).post(`/admin/users/${u.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await request(ctx.server).post(`/admin/users/${u.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    const fresh = await ctx.prisma.notification.findMany({ where: { recipientUserId: u.userId, id: { notIn: before } } });
    return {
      user: { ...u, ...(await login(ctx, u.email, PASSWORD)) },
      suspended: fresh.find((n) => n.templateCode === 'ACCOUNT_SUSPENDED')!,
      reactivated: fresh.find((n) => n.templateCode === 'ACCOUNT_REACTIVATED')!,
    };
  }
  const emailJobs = (notificationId: string) => ctx.prisma.notificationDeliveryJob.findMany({ where: { notificationId, channel: 'EMAIL' } });
  const emailJob = (notificationId: string) => ctx.prisma.notificationDeliveryJob.findUnique({ where: { notificationId_channel: { notificationId, channel: 'EMAIL' } } });
  const emailAttempts = (notificationId: string) => ctx.prisma.deliveryAttempt.findMany({ where: { notificationId, channel: 'EMAIL' }, orderBy: { attemptNumber: 'asc' } });
  const soon = () => new Date(Date.now() + 1_000);
  /** Settle a job this test is not about, so it does not interfere. */
  const settle = (notificationId: string) => ctx.prisma.notificationDeliveryJob.updateMany({ where: { notificationId, channel: 'EMAIL' }, data: { status: 'COMPLETED' } });
  const inboxIds = async (u: EmailUser) =>
    ((body(await request(ctx.server).get('/notifications').set(...auth(u.accessToken)).expect(200)) as unknown as { items: Array<{ id: string }> }).items).map((i) => i.id);

  it('mails A’s notification to A’s verified address — never B’s — with title as subject and body as text', async () => {
    const a = await emailUser();
    const b = await emailUser();
    await setEmail(a, true);
    const { user, suspended, reactivated } = await cycle(a);
    expect(await emailJobs(reactivated.id)).toHaveLength(1);
    expect(await emailJob(reactivated.id)).toMatchObject({ status: 'PENDING', attemptCount: 0 });

    await dispatcher.dispatchDue(soon());
    const toA = mailer.sent.filter((s) => s.message.to === a.email);
    expect(toA.map((s) => s.message.reference).sort()).toEqual([suspended.id, reactivated.id].sort());
    expect(toA.find((s) => s.message.reference === reactivated.id)!.message).toEqual({
      to: a.email,
      subject: reactivated.renderedTitle,
      text: reactivated.renderedBody,
      reference: reactivated.id,
    });
    expect(mailer.sent.every((s) => s.message.to !== b.email)).toBe(true);
    expect(await emailJob(reactivated.id)).toMatchObject({ status: 'COMPLETED', attemptCount: 1, leaseExpiresAt: null });
    expect((await emailAttempts(reactivated.id)).map((x) => [x.attemptNumber, x.status, x.provider, x.errorCode, x.errorDetail])).toEqual([[1, 'SENT', 'email-in-memory', null, null]]);
    expect(await inboxIds(user)).toContain(reactivated.id);
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: reactivated.id } })).status).toBe('SENT');
  });

  it('an Amharic-speaking user gets the Amharic subject and body', async () => {
    const a = await emailUser();
    await setLanguage(a, 'am');
    const { reactivated } = await cycle(a);
    await dispatcher.dispatchDue(soon());
    const message = mailer.sent.find((s) => s.message.reference === reactivated.id)!.message;
    expect(message.subject).toBe(reactivated.renderedTitle);
    expect(message.text).toBe(reactivated.renderedBody);
    expect(message.subject + message.text).toMatch(/[ሀ-፿]/);
  });

  it('EMAIL disabled → no job; re-enabled → a new job; disabled after queuing → SUPPRESSED and never resurrected', async () => {
    const a = await emailUser();
    await setEmail(a, false);
    const off = await cycle(a);
    expect(await emailJobs(off.reactivated.id)).toEqual([]);

    await setEmail(off.user, true);
    const on = await cycle(off.user);
    expect(await emailJob(on.reactivated.id)).toMatchObject({ status: 'PENDING' });

    await setEmail(on.user, false);
    await dispatcher.dispatchDue(soon());
    expect(await emailJob(on.reactivated.id)).toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'PREFERENCE_DISABLED' });
    expect(mailer.sent).toEqual([]);
    await setEmail(on.user, true);
    await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
    expect(mailer.sent).toEqual([]);
  });

  it('a provider failure and a timeout are retried on the backoff schedule', async () => {
    const a = await emailUser();
    const { suspended, reactivated } = await cycle(a);
    await settle(suspended.id);
    mailer.script.set(a.email, { kind: 'TRANSIENT', code: 'EMAIL_UNAVAILABLE' });
    const t0 = soon();
    await dispatcher.dispatchDue(t0);
    let job = (await emailJob(reactivated.id))!;
    expect(job).toMatchObject({ status: 'PENDING', attemptCount: 1, lastErrorCode: 'EMAIL_UNAVAILABLE' });
    expect(+job.nextAttemptAt - +t0).toBe(30_000);

    mailer.script.set(a.email, { kind: 'TRANSIENT', code: 'EMAIL_TIMEOUT' });
    const t1 = job.nextAttemptAt;
    await dispatcher.dispatchDue(t1);
    job = (await emailJob(reactivated.id))!;
    expect(job).toMatchObject({ status: 'PENDING', attemptCount: 2, lastErrorCode: 'EMAIL_TIMEOUT' });
    expect(+job.nextAttemptAt - +t1).toBe(120_000);

    mailer.script.delete(a.email);
    await dispatcher.dispatchDue(job.nextAttemptAt);
    expect((await emailAttempts(reactivated.id)).map((x) => [x.attemptNumber, x.status, x.errorCode])).toEqual([
      [1, 'FAILED', 'EMAIL_UNAVAILABLE'],
      [2, 'FAILED', 'EMAIL_TIMEOUT'],
      [3, 'SENT', null],
    ]);
  });

  it('a permanently invalid address, or an unverified one, ends the job after one attempt', async () => {
    const a = await emailUser();
    mailer.script.set(a.email, { kind: 'INVALID_RECIPIENT', code: 'EMAIL_MAILBOX_UNKNOWN' });
    const first = await cycle(a);
    await dispatcher.dispatchDue(soon());
    await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
    expect(await emailJob(first.reactivated.id)).toMatchObject({ status: 'EXHAUSTED', attemptCount: 1, lastErrorCode: 'EMAIL_MAILBOX_UNKNOWN' });

    mailer.script.clear();
    await ctx.prisma.user.update({ where: { id: a.userId }, data: { emailVerifiedAt: null } });
    const second = await cycle(first.user);
    const sentBefore = mailer.sent.length;
    await dispatcher.dispatchDue(soon());
    expect(mailer.sent).toHaveLength(sentBefore);
    expect((await emailAttempts(second.reactivated.id)).map((x) => [x.attemptNumber, x.status, x.errorCode])).toEqual([[1, 'FAILED', 'EMAIL_RECIPIENT_UNVERIFIED']]);
  });

  it('a phone-only account has no address: one terminal NO_EMAIL attempt, nothing sent', async () => {
    const { registerAndVerify } = await import('../support/fixtures');
    const reg = await registerAndVerify(ctx);
    const u = { userId: reg.userId, email: '', ...(await login(ctx, reg.phone, reg.password)) };
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server).post(`/admin/users/${u.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await ctx.drainOutbox();
    const n = await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: u.userId, templateCode: 'ACCOUNT_SUSPENDED' } });
    await dispatcher.dispatchDue(soon());
    expect(mailer.sent).toEqual([]);
    expect((await emailAttempts(n.id)).map((x) => [x.status, x.errorCode])).toEqual([['FAILED', 'EMAIL_RECIPIENT_NO_EMAIL']]);
  });

  it('the raw address is nowhere: payloads, jobs, attempts, HTTP responses, audit, captured output; no audit from mail or reads; no network', async () => {
    const out: string[] = [];
    const capture = (stream: NodeJS.WriteStream) =>
      jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
        out.push(String(chunk));
        return true;
      }) as never);
    const streams = [capture(process.stdout), capture(process.stderr)];
    try {
      const a = await emailUser();
      const { user, reactivated } = await cycle(a);
      mailer.script.set(a.email, 'THROW');
      const auditBefore = await ctx.prisma.auditLog.count();
      const network = [jest.spyOn(http, 'request'), jest.spyOn(https, 'request'), jest.spyOn(net.Socket.prototype, 'connect')];
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

      const local = a.email.split('@')[0];
      const persisted = JSON.stringify([
        await ctx.prisma.notification.findMany({ where: { recipientUserId: a.userId } }),
        await ctx.prisma.notificationDeliveryJob.findMany(),
        await ctx.prisma.deliveryAttempt.findMany(),
        responses,
        out,
      ]);
      for (const secret of [a.email, local, 'FAKE_EMAIL_SECRET', 'relay refused']) {
        expect({ secret, found: persisted.includes(secret) }).toEqual({ secret, found: false });
      }
      // Module 01's own suspend / reactivate audit rows predate the dispatch; none of them may carry the address either.
      const auditFromDelivery = await ctx.prisma.auditLog.findMany({ where: { createdAt: { gte: new Date(Date.now() - 60_000) } }, select: { action: true, context: true } });
      expect(JSON.stringify(auditFromDelivery.filter((r) => !/USER_(SUSPENDED|REACTIVATED)|REGISTER|LOGIN|OTP|VERIF/i.test(r.action)))).not.toContain(a.email);
      expect((await emailAttempts(reactivated.id))[0]).toMatchObject({ status: 'FAILED', errorCode: 'EMAIL_NETWORK_ERROR', errorDetail: null });
    } finally {
      for (const s of streams) s.mockRestore();
    }
  });

  it('production binds the unconfigured transport: no e-mail provider registered, jobs wait; other channels unaffected', () => {
    const providers = Reflect.getMetadata('providers', NotificationsModule) as Array<{ provide?: unknown; useClass?: unknown; useFactory?: (...a: unknown[]) => INotificationChannelProviderRegistry }>;
    expect(providers.find((p) => p.provide === EMAIL_TRANSPORT)!.useClass).toBe(UnconfiguredEmailTransport);
    const factory = providers.find((p) => p.provide === NOTIFICATION_CHANNEL_PROVIDER_REGISTRY)!.useFactory!;
    const fake = (channel: NotificationChannel, name: string): INotificationChannelProvider => ({ name, channel, deliver: async () => ({ outcome: 'NOT_CONFIGURED' }) });
    const off = { isConfigured: () => false };
    const reg = factory(off, fake(NotificationChannel.PUSH, 'fcm'), off, fake(NotificationChannel.SMS, 'sms'), new UnconfiguredEmailTransport(), fake(NotificationChannel.EMAIL, 'email'));
    expect(Object.values(NotificationChannel).map((c) => reg.providerFor(c))).toEqual([null, null, null, null]);
    const withMail = factory(off, fake(NotificationChannel.PUSH, 'fcm'), off, fake(NotificationChannel.SMS, 'sms'), mailer, fake(NotificationChannel.EMAIL, 'email'));
    expect(Object.values(NotificationChannel).map((c) => withMail.providerFor(c)?.name ?? null)).toEqual([null, null, 'email', null]);
    expect(readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'notifications', 'notifications.module.ts'), 'utf8')).not.toContain('InMemoryEmailTransport');
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

    it('Module 13 reads addresses only through Module 01’s contact port — no users / profiles persistence, no deprecated table', () => {
      for (const file of sources(join(root, 'notifications'))) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [/prisma\.(user|customerProfile|notificationPreference)\b/, /identity\/infrastructure\//, /identity\/domain\/(?!events['`])/, /modules\/profiles\/|'(?:\.\.\/)+profiles\//]) {
          expect({ file: rel(file), forbidden: String(forbidden), found: forbidden.test(source) }).toEqual({ file: rel(file), forbidden: String(forbidden), found: false });
        }
      }
      expect(sources(join(root, 'notifications')).filter((f) => /emailRecipientOf/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([
        'notifications/infrastructure/providers/email-notification.provider.ts',
      ]);
    });

    it('only Module 01’s contact adapter reads the address from persistence; the e-mail transports, content and provider never touch Prisma', () => {
      expect(sources(root).filter((f) => /emailRecipientOf/.test(readFileSync(f, 'utf8')) && /PrismaService/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([
        'identity/infrastructure/persistence/prisma-identity-contact-read.adapter.ts',
      ]);
      for (const file of sources(join(root, 'notifications')).filter((f) => /infrastructure\/(email|providers)\/|domain\/email-content|ports\/outbound\/email-transport/.test(rel(f)))) {
        expect({ file: rel(file), prisma: /PrismaService|@prisma\/client|prisma\.\w+/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), prisma: false });
      }
    });

    it('no e-mail credential, SMTP setting, sender address or provider endpoint exists — none has been approved', () => {
      for (const file of sources(join(root, 'notifications'))) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /SMTP_|EMAIL_(HOST|USER|PASS|API|FROM|SENDER)|smtp:\/\/|noreply@|from:\s*'/i.test(source) }).toEqual({ file: rel(file), found: false });
      }
    });
  });
});
