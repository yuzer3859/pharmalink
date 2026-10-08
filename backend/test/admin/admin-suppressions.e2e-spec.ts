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
import { auth, body, createUserWithRole, errorOf, login, registerAndVerify, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const PASSWORD = 'Str0ng!Passw0rd';
const SECRET = `whsec_${Buffer.from('admin-suppression-e2e-secret-32b').toString('base64')}`;
const BASE = '/admin/notifications/suppressions';
type EmailUser = { userId: string; email: string } & Tokens;

/**
 * Module 13 Work 19 against real PostgreSQL: a real suppression (Work 18's signed bounce webhook),
 * administered through Module 16's control plane, and its effect on the next real send. E-mail goes
 * through the non-production in-memory transport; nothing reaches Resend.
 */
describe('Admin notification suppressions (e2e)', () => {
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

  /** A real SECURITY notification for the user via Module 01's suspend / reactivate, e-mailed through the queue. */
  async function notify(u: EmailUser, admin: Tokens, action: 'suspend' | 'reactivate') {
    await request(ctx.server).post(`/admin/users/${u.userId}/${action}`).set(...auth(admin.accessToken)).send(action === 'suspend' ? { reason: 'Review' } : {}).expect(204);
    await ctx.drainOutbox();
    const n = await ctx.prisma.notification.findFirstOrThrow({
      where: { recipientUserId: u.userId, templateCode: action === 'suspend' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_REACTIVATED' },
      orderBy: { createdAt: 'desc' },
    });
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    const job = await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { notificationId_channel: { notificationId: n.id, channel: 'EMAIL' } } });
    const sent = await ctx.prisma.deliveryAttempt.findFirst({ where: { notificationId: n.id, channel: 'EMAIL', status: 'SENT' } });
    return { n, job, emailId: sent?.providerMsgId ?? null };
  }

  /** Work 18's own path: a Svix-signed permanent bounce for the message. */
  const bounce = async (emailId: string, to: string) => {
    const raw = JSON.stringify({ type: 'email.bounced', created_at: new Date().toISOString(), data: { email_id: emailId, to: [to], bounce: { type: 'Permanent' } } });
    const id = `msg_${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    await request(ctx.server)
      .post('/webhooks/resend')
      .set('content-type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', ts)
      .set('svix-signature', signSvix(SECRET, id, ts, raw))
      .send(raw)
      .expect(200);
  };

  it('suppress → blocked send → admin lists, reads, removes (audited) → the next send goes out; the old SUPPRESSED job stays', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const a = await emailUser();

    // 1–5: a real e-mail, a real permanent bounce, a real suppression.
    const first = await notify(a, admin, 'suspend');
    expect(first.emailId).not.toBeNull();
    await bounce(first.emailId!, a.email);
    const rows = await ctx.prisma.suppressionEntry.findMany();
    expect(rows).toEqual([expect.objectContaining({ channel: 'EMAIL', address: suppressionKeyOf(a.email), reason: 'PERMANENT_BOUNCE' })]);

    // 6–7: the next e-mail is suppressed before any provider call.
    const sentBefore = mailer.sent.length;
    const second = await notify(a, admin, 'reactivate');
    expect(mailer.sent).toHaveLength(sentBefore);
    expect(second.job).toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'EMAIL_DESTINATION_SUPPRESSED' });

    // 8–11: the admin sees it — without the address or the full hash — and reads it; no audit.
    const auditBeforeReads = await ctx.prisma.auditLog.count();
    const listed = body(await request(ctx.server).get(BASE).set(...auth(admin.accessToken)).expect(200)) as unknown as { items: Array<Record<string, unknown>>; total: number; page: number; size: number };
    expect(listed).toEqual({
      items: [{ id: rows[0].id, channel: 'EMAIL', reason: 'PERMANENT_BOUNCE', destinationFingerprint: `${rows[0].address.slice(0, 15)}…`, createdAt: rows[0].createdAt.toISOString() }],
      total: 1,
      page: 1,
      size: 20,
    });
    expect(body(await request(ctx.server).get(`${BASE}/${rows[0].id}`).set(...auth(admin.accessToken)).expect(200))).toEqual(listed.items[0]);
    expect(body(await request(ctx.server).get(BASE).query({ reason: 'COMPLAINT' }).set(...auth(admin.accessToken)).expect(200))).toMatchObject({ items: [], total: 0 });
    expect(await ctx.prisma.auditLog.count()).toBe(auditBeforeReads);

    // 12–13: removal, audited once.
    const removed = await request(ctx.server).delete(`${BASE}/${rows[0].id}`).set(...auth(admin.accessToken)).expect(200);
    expect(body(removed)).toEqual(listed.items[0]);
    expect(await ctx.prisma.suppressionEntry.count()).toBe(0);
    const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'ADMIN_NOTIFICATION_SUPPRESSION_REMOVED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: admin.userId, resourceType: 'NotificationSuppression', resourceId: rows[0].id });
    expect(audit[0].context).toEqual({ suppressionId: rows[0].id, channel: 'EMAIL', previousReason: 'PERMANENT_BOUNCE', suppressedAt: rows[0].createdAt.toISOString() });

    // Removing again: 404, no second audit.
    const again = await request(ctx.server).delete(`${BASE}/${rows[0].id}`).set(...auth(admin.accessToken)).expect(404);
    expect(errorOf(again).code).toBe('NOT_FOUND');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_NOTIFICATION_SUPPRESSION_REMOVED' } })).toBe(1);

    // 14–17: the next notification's e-mail goes out.
    const secondJobBefore = await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id: second.job.id } });
    const third = await notify(a, admin, 'suspend');
    expect(third.job).toMatchObject({ status: 'COMPLETED', attemptCount: 1 });
    expect(mailer.sent.at(-1)!.message).toMatchObject({ to: a.email, reference: third.n.id });

    // 18: the old suppressed job is exactly as it was — not reopened, not resent.
    await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
    expect(await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id: second.job.id } })).toEqual(secondJobBefore);
    expect(mailer.sent.filter((s) => s.message.reference === second.n.id)).toEqual([]);

    // 22: nothing returned or stored by the control plane carries the address or the full hash.
    const everything = JSON.stringify([listed, body(removed), audit, await ctx.prisma.deliveryAttempt.findMany(), await ctx.prisma.notificationDeliveryJob.findMany()]);
    for (const secret of [a.email, rows[0].address.slice(7), SECRET]) {
      expect({ secret: secret.slice(0, 10), found: everything.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
  });

  it('unknown id → 404 on read and delete; malformed id → 400; unknown filter → 400', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    for (const [method, path] of [['get', `${BASE}/${randomUUID()}`], ['delete', `${BASE}/${randomUUID()}`]] as const) {
      const res = await request(ctx.server)[method](path).set(...auth(admin.accessToken));
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    await request(ctx.server).get(`${BASE}/not-a-uuid`).set(...auth(admin.accessToken)).expect(400);
    await request(ctx.server).get(BASE).query({ email: 'a@example.com' }).set(...auth(admin.accessToken)).expect(400);
    await request(ctx.server).get(BASE).query({ size: 101 }).set(...auth(admin.accessToken)).expect(400);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_NOTIFICATION_SUPPRESSION_REMOVED' } })).toBe(0);
  });

  it('401 without authentication; 403 for every non-admin role, including a user with the notification permissions', async () => {
    const target = randomUUID();
    for (const [method, path] of [['get', BASE], ['get', `${BASE}/${target}`], ['delete', `${BASE}/${target}`]] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path)).status }).toEqual({ method, path, status: 401 });
    }
    const customer = await registerAndVerify(ctx);
    const tokens: Array<[string, string]> = [['CUSTOMER', (await login(ctx, customer.phone, customer.password)).accessToken]];
    for (const role of ['DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    for (const [role, token] of tokens) {
      for (const [method, path] of [['get', BASE], ['get', `${BASE}/${target}`], ['delete', `${BASE}/${target}`]] as const) {
        const res = await request(ctx.server)[method](path).set(...auth(token));
        expect({ role, method, path, status: res.status }).toEqual({ role, method, path, status: 403 });
      }
    }
  });

  it('the permissions exist with ADMIN as their only holder (SUPER_ADMIN by wildcard)', async () => {
    for (const key of ['suppression:read:any', 'suppression:manage:any']) {
      const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key } }, include: { role: { select: { key: true } } } });
      expect({ key, roles: holders.map((h) => h.role.key) }).toEqual({ key, roles: ['ADMIN'] });
    }
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    await request(ctx.server).get(BASE).set(...auth(superAdmin.accessToken)).expect(200);
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

    it('Module 16 reaches suppressions only through Module 13’s admin port — no Prisma, repositories or persistence', () => {
      const imports = new Set<string>();
      for (const file of sources(join(root, 'admin'))) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /suppressionEntry|suppression_list/.test(source) }).toEqual({ file: rel(file), found: false });
        for (const m of source.matchAll(/from '(?:\.\.\/)+notifications\/([^']+)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual(['application/ports/inbound/notification-suppression-admin.port', 'notifications.module']);
    });

    it('only Module 13’s persistence adapter touches suppression_list; controllers never touch Prisma', () => {
      expect(sources(root).filter((f) => /\.suppressionEntry\b/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([
        'notifications/infrastructure/persistence/prisma-email-webhook.repository.ts',
      ]);
      for (const file of sources(root).filter((f) => /interface\/controllers\/admin-suppressions/.test(f))) {
        expect(/PrismaService|@prisma\/client/.test(readFileSync(file, 'utf8'))).toBe(false);
      }
    });

    it('the suppression port and its domain are provider-independent — no Resend, Svix or transport', () => {
      for (const f of ['notifications/application/ports/inbound/notification-suppression-admin.port.ts', 'notifications/domain/suppression.ts', 'notifications/domain/repositories/suppression-admin.repository.ts']) {
        // Imports only — a doc comment may name the provider that reports bounces.
        expect({ f, found: /from '[^']*(resend|svix|transport|webhook)[^']*'/i.test(readFileSync(join(root, f), 'utf8')) }).toEqual({ f, found: false });
      }
    });
  });
});
