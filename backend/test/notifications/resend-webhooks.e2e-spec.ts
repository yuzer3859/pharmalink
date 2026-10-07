import { randomUUID } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { EMAIL_TRANSPORT } from '../../src/modules/notifications/application/ports/outbound/email-transport.port';
import { NotificationDeliveryDispatcher } from '../../src/modules/notifications/application/services/notification-delivery.dispatcher';
import { suppressionKeyOf } from '../../src/modules/notifications/domain/suppression';
import { InMemoryEmailTransport } from '../../src/modules/notifications/infrastructure/email/in-memory-email.transport';
import { RESEND_CONFIG_KEYS, ResendConfig } from '../../src/modules/notifications/infrastructure/email/resend.config';
import { NOTIFICATION_DELIVERY_INTERVAL } from '../../src/modules/notifications/infrastructure/scheduling/notification-delivery.scheduler';
import { signSvix } from '../../src/modules/notifications/infrastructure/webhooks/svix-signature';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { IConfigPort } from '../../src/shared/config/config.port';
import { auth, body, createUserWithRole, errorOf, login, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const PASSWORD = 'Str0ng!Passw0rd';
const SECRET = `whsec_${Buffer.from('e2e-webhook-signing-secret-32by!').toString('base64')}`;
type EmailUser = { userId: string; email: string } & Tokens;

/**
 * Module 13 Work 18 against real PostgreSQL and the real HTTP stack: Resend webhooks through the
 * actual controller — raw body, Svix signature, receipt idempotency — into delivery history and
 * the suppression list, and the suppression enforced on the next real send. E-mail is "sent" by the
 * non-production in-memory transport (its message ids stand in for Resend's `email_id`); no request
 * reaches Resend.
 */
describe('Resend webhooks and suppression (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const mailer = new InMemoryEmailTransport();
  const settings: Record<string, string | undefined> = { [RESEND_CONFIG_KEYS.webhookSecret]: SECRET };
  const config = new ResendConfig({ get: (k: string) => settings[k], getOrThrow: () => '', isFeatureEnabled: () => false } as unknown as IConfigPort);

  beforeAll(async () => {
    ctx = await createTestApp([
      { provide: EMAIL_TRANSPORT, useValue: mailer },
      { provide: ResendConfig, useValue: config },
    ]);
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
    settings[RESEND_CONFIG_KEYS.webhookSecret] = SECRET;
  });

  async function emailUser(): Promise<EmailUser> {
    const email = `customer.${randomUUID().slice(0, 8)}@example.com`;
    const res = await request(ctx.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    await ctx.drainOutbox();
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: email, code: ctx.notifications.lastCodeFor(email, 'otp-register'), purpose: OtpPurpose.REGISTER })
      .expect(201);
    return { userId: body(res).userId as string, email, ...(await login(ctx, email, PASSWORD)) };
  }

  /** A real ACCOUNT_SUSPENDED (or _REACTIVATED) notification, e-mailed through the queue; returns it with its message id. */
  async function sendOne(u: EmailUser, action: 'suspend' | 'reactivate') {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server).post(`/admin/users/${u.userId}/${action}`).set(...auth(admin.accessToken)).send(action === 'suspend' ? { reason: 'Review' } : {}).expect(204);
    await ctx.drainOutbox();
    const n = await ctx.prisma.notification.findFirstOrThrow({
      where: { recipientUserId: u.userId, templateCode: action === 'suspend' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_REACTIVATED' },
      orderBy: { createdAt: 'desc' },
    });
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    const sent = await ctx.prisma.deliveryAttempt.findFirst({ where: { notificationId: n.id, channel: 'EMAIL', status: 'SENT' } });
    return { n, emailId: sent?.providerMsgId ?? null };
  }

  /** POSTs a Svix-signed Resend webhook, the body sent as exact bytes. */
  const post = (payload: unknown, opts: { id?: string; secret?: string; tamper?: (b: string) => string; headers?: Record<string, string | undefined> } = {}) => {
    const raw = JSON.stringify(payload);
    const id = opts.id ?? `msg_${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string | undefined> = {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': ts,
      'svix-signature': signSvix(opts.secret ?? SECRET, id, ts, raw),
      ...opts.headers,
    };
    let req = request(ctx.server).post('/webhooks/resend');
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) req = req.set(k, v);
    return req.send(opts.tamper ? opts.tamper(raw) : raw);
  };
  const event = (type: string, emailId: string | null, to: string[], extra: Record<string, unknown> = {}) => ({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: emailId, to, from: 'PharmaLink <alerts@notify.example.com>', subject: 'Account suspended', created_at: new Date().toISOString(), ...extra },
  });
  const snapshot = async () => ({
    receipts: await ctx.prisma.notificationWebhookReceipt.count(),
    attempts: await ctx.prisma.deliveryAttempt.count(),
    suppressions: await ctx.prisma.suppressionEntry.count(),
    notifications: await ctx.prisma.notification.count(),
    jobs: await ctx.prisma.notificationDeliveryJob.count(),
  });

  it('delivered → DELIVERED history row; the exact replay is a DUPLICATE with no effect; delayed changes nothing', async () => {
    const a = await emailUser();
    const { n, emailId } = await sendOne(a, 'suspend');
    expect(emailId).toMatch(/^email-\d+$/);
    const jobBefore = await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { notificationId_channel: { notificationId: n.id, channel: 'EMAIL' } } });

    const id = `msg_${randomUUID()}`;
    const payload = event('email.delivered', emailId, [a.email]);
    expect(body(await post(payload, { id }).expect(200))).toEqual({ received: true, outcome: 'APPLIED' });
    expect(body(await post(payload, { id }).expect(200))).toEqual({ received: true, outcome: 'DUPLICATE' });

    expect((await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId: n.id, channel: 'EMAIL' }, orderBy: [{ attemptNumber: 'asc' }, { attemptedAt: 'asc' }] })).map((x) => [x.attemptNumber, x.status, x.providerMsgId, x.errorCode])).toEqual([
      [1, 'SENT', emailId, null],
      [1, 'DELIVERED', emailId, null],
    ]);
    // The job and the notification are untouched; no new job, no resend.
    expect(await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id: jobBefore.id } })).toEqual(jobBefore);
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('SENT');
    expect(mailer.sent).toHaveLength(1);

    const before = await snapshot();
    expect(body(await post(event('email.delivery_delayed', emailId, [a.email])).expect(200)).outcome).toBe('APPLIED');
    const after = await snapshot();
    expect(after).toEqual({ ...before, receipts: before.receipts + 1 });
  });

  it('a permanent bounce → BOUNCED + destination suppressed; the next e-mail to it is SUPPRESSED before any send; a complaint keeps it suppressed; another user is unaffected', async () => {
    const a = await emailUser();
    const b = await emailUser();
    const { n, emailId } = await sendOne(a, 'suspend');
    expect(body(await post(event('email.bounced', emailId, [a.email.toUpperCase()], { bounce: { type: 'Permanent', subType: 'General', message: `550 ${a.email} gone` } })).expect(200)).outcome).toBe('APPLIED');

    expect((await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId: n.id, status: 'BOUNCED' } })).map((x) => [x.errorCode, x.errorDetail])).toEqual([['EMAIL_BOUNCED', null]]);
    expect(await ctx.prisma.suppressionEntry.findMany({ select: { channel: true, address: true, reason: true } })).toEqual([
      { channel: 'EMAIL', address: suppressionKeyOf(a.email), reason: 'PERMANENT_BOUNCE' },
    ]);

    // The next notification for A: the e-mail job closes SUPPRESSED without reaching the provider.
    const sentBefore = mailer.sent.length;
    const next = await sendOne(a, 'reactivate');
    expect(mailer.sent).toHaveLength(sentBefore);
    expect(next.emailId).toBeNull();
    expect(await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { notificationId_channel: { notificationId: next.n.id, channel: 'EMAIL' } } })).toMatchObject({
      status: 'SUPPRESSED',
      lastErrorCode: 'EMAIL_DESTINATION_SUPPRESSED',
    });
    expect((await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId: next.n.id, channel: 'EMAIL' } })).map((x) => [x.status, x.errorCode])).toEqual([['SUPPRESSED', 'EMAIL_DESTINATION_SUPPRESSED']]);

    // A complaint on the first message: recorded, still exactly one suppression row.
    expect(body(await post(event('email.complained', emailId, [a.email])).expect(200)).outcome).toBe('APPLIED');
    expect((await ctx.prisma.deliveryAttempt.findMany({ where: { notificationId: n.id, status: 'BOUNCED' } })).map((x) => x.errorCode).sort()).toEqual(['EMAIL_BOUNCED', 'EMAIL_COMPLAINED']);
    expect(await ctx.prisma.suppressionEntry.count()).toBe(1);

    // B still gets mail.
    const toB = await sendOne(b, 'suspend');
    expect(toB.emailId).not.toBeNull();
    expect(mailer.sent.at(-1)!.message.to).toBe(b.email);
  });

  it('a transient bounce records a soft bounce and does not suppress', async () => {
    const a = await emailUser();
    const { emailId } = await sendOne(a, 'suspend');
    await post(event('email.bounced', emailId, [a.email], { bounce: { type: 'Transient', subType: 'MailboxFull', message: 'full' } })).expect(200);
    expect(await ctx.prisma.deliveryAttempt.count({ where: { errorCode: 'EMAIL_SOFT_BOUNCED' } })).toBe(1);
    expect(await ctx.prisma.suppressionEntry.count()).toBe(0);
  });

  it('an invalid, tampered, unsigned or stale webhook → 401 and zero database change; a missing secret → 503', async () => {
    const a = await emailUser();
    const { emailId } = await sendOne(a, 'suspend');
    const payload = event('email.bounced', emailId, [a.email], { bounce: { type: 'Permanent' } });
    const before = await snapshot();
    const wrong = `whsec_${Buffer.from('not-the-right-secret-at-all-32b!').toString('base64')}`;
    for (const res of [
      await post(payload, { secret: wrong }),
      await post(payload, { tamper: (b) => b.replace('Permanent', 'Transient') }),
      await post(payload, { headers: { 'svix-signature': undefined } }),
      await post(payload, { headers: { 'svix-id': undefined } }),
      await post(payload, { headers: { 'svix-timestamp': String(Math.floor(Date.now() / 1000) - 3600) } }),
    ]) {
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe('WEBHOOK_SIGNATURE_INVALID');
      expect(JSON.stringify(res.body)).not.toContain(a.email);
    }
    settings[RESEND_CONFIG_KEYS.webhookSecret] = undefined;
    expect((await post(payload)).status).toBe(503);
    expect(await snapshot()).toEqual(before);
  });

  it('an unknown email_id or an unsupported event is acknowledged with nothing fabricated', async () => {
    const before = await snapshot();
    expect(body(await post(event('email.bounced', '3f0c-unknown', ['someone@example.com'], { bounce: { type: 'Permanent' } })).expect(200)).outcome).toBe('UNMATCHED');
    expect(body(await post({ type: 'email.opened', data: { email_id: 'x' } }).expect(200)).outcome).toBe('IGNORED');
    expect(body(await post({ type: 'contact.created', data: {} }).expect(200)).outcome).toBe('IGNORED');
    expect(await snapshot()).toEqual({ ...before, receipts: before.receipts + 3 });
    expect((await ctx.prisma.notificationWebhookReceipt.findMany({ select: { provider: true, eventType: true } })).map((r) => r.eventType).sort()).toEqual([
      'contact.created',
      'email.bounced',
      'email.opened',
    ]);
  });

  it('concurrent copies of one webhook → one effective processing', async () => {
    const a = await emailUser();
    const { emailId } = await sendOne(a, 'suspend');
    const id = `msg_${randomUUID()}`;
    const payload = event('email.complained', emailId, [a.email]);
    const results = await Promise.all([post(payload, { id }), post(payload, { id }), post(payload, { id })]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.map((r) => body(r).outcome).sort()).toEqual(['APPLIED', 'DUPLICATE', 'DUPLICATE']);
    expect(await ctx.prisma.notificationWebhookReceipt.count({ where: { eventId: id } })).toBe(1);
    expect(await ctx.prisma.deliveryAttempt.count({ where: { errorCode: 'EMAIL_COMPLAINED' } })).toBe(1);
    expect(await ctx.prisma.suppressionEntry.count()).toBe(1);
  });

  it('no raw address, payload, subject, signature or secret is stored or echoed; webhooks create no notification, job or audit row; in-app intact', async () => {
    const a = await emailUser();
    const { n, emailId } = await sendOne(a, 'suspend');
    const counts = { notifications: await ctx.prisma.notification.count(), jobs: await ctx.prisma.notificationDeliveryJob.count(), audit: await ctx.prisma.auditLog.count() };
    const responses = [
      (await post(event('email.delivered', emailId, [a.email]))).body,
      (await post(event('email.bounced', emailId, [a.email], { bounce: { type: 'Permanent', message: `550 MAILBOX-GONE-MARKER ${a.email}` } }))).body,
      (await post(event('email.complained', emailId, [a.email]))).body,
    ];
    expect({ notifications: await ctx.prisma.notification.count(), jobs: await ctx.prisma.notificationDeliveryJob.count(), audit: await ctx.prisma.auditLog.count() }).toEqual(counts);
    const stored = JSON.stringify([
      await ctx.prisma.notificationWebhookReceipt.findMany(),
      await ctx.prisma.deliveryAttempt.findMany(),
      await ctx.prisma.suppressionEntry.findMany(),
      await ctx.prisma.notificationDeliveryJob.findMany(),
      await ctx.prisma.notification.findMany(),
      responses,
    ]);
    for (const secret of [a.email, a.email.split('@')[0], SECRET, 'v1,', 'MAILBOX-GONE-MARKER', 'alerts@notify', 'Account suspended","data']) {
      expect({ secret: secret.slice(0, 12), found: stored.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    // The account was suspended by the event that produced the notification; reactivate it to read the inbox.
    await sendOne(a, 'reactivate');
    const user = { ...a, ...(await login(ctx, a.email, PASSWORD)) };
    const inbox = (body(await request(ctx.server).get('/notifications').set(...auth(user.accessToken)).expect(200)) as unknown as { items: Array<{ id: string }> }).items;
    expect(inbox.map((i) => i.id)).toContain(n.id);
  });

  describe('boundaries', () => {
    const root = join(__dirname, '..', '..', 'src', 'modules', 'notifications');
    const sources = (): string[] => {
      const files: string[] = [];
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      };
      walk(root);
      return files;
    };
    const rel = (f: string) => f.replace(/\\/g, '/').split('/modules/notifications/')[1];

    it('Prisma stays in infrastructure/persistence; signature and Resend parsing stay out of domain and application', () => {
      for (const file of sources().filter((f) => !rel(f).startsWith('infrastructure/persistence/'))) {
        expect({ file: rel(file), prisma: /PrismaService|@prisma\/client|prisma\.\w+/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), prisma: false });
      }
      for (const file of sources().filter((f) => /^(domain|application)\//.test(rel(f)))) {
        expect({ file: rel(file), found: /from '[^']*(svix-signature|resend-webhook\.parser)'|timingSafeEqual|createHmac/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), found: false });
      }
      expect(sources().filter((f) => /\.(notificationWebhookReceipt|suppressionEntry)\b/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([
        'infrastructure/persistence/prisma-email-webhook.repository.ts',
      ]);
    });

    it('the webhook secret is read only by ResendConfig; no Module 01 / 02 persistence; no raw SQL', () => {
      expect(sources().filter((f) => /'RESEND_WEBHOOK_SECRET'/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual(['infrastructure/email/resend.config.ts']);
      for (const file of sources()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [/prisma\.(user|customerProfile|notificationPreference)\b/, /identity\/infrastructure\//, /\$queryRaw|\$executeRaw/]) {
          expect({ file: rel(file), forbidden: String(forbidden), found: forbidden.test(source) }).toEqual({ file: rel(file), forbidden: String(forbidden), found: false });
        }
      }
    });
  });
});
