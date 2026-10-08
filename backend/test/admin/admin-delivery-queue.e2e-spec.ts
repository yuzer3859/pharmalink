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
type User = RegisteredUser & Tokens;
type Job = { id: string; notificationId: string; channel: string; status: string; attemptCount: number; nextAttemptAt: string; leaseExpiresAt: string | null; lastErrorCode: string | null; completedAt: string | null; createdAt: string; updatedAt: string };

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
 * Module 16 Work 20 against real PostgreSQL: read-only admin visibility into Module 13's delivery
 * queue. The queue is filled by the real path — Module 01 events, Work 11 preferences, the Work 13
 * dispatcher — with the non-production in-memory channel providers (PUSH sends, EMAIL fails, SMS has
 * none). No real provider is called.
 */
describe('Admin notification delivery queue (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const registry = new ScriptedRegistry();
  let admin: User;
  let seeded: { pushDone: string; smsPending: string; emailSuppressed: string; emailExhausted: string; processing: string; emailPending: string; failingNotification: string };

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: NOTIFICATION_CHANNEL_PROVIDER_REGISTRY, useValue: registry }]);
    dispatcher = ctx.app.get(NotificationDeliveryDispatcher);
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

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    registry.use(new InMemoryNotificationChannelProvider(NotificationChannel.PUSH), new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL, 'FAILED', 'EMAIL_UNAVAILABLE'));

    // U1: PUSH completes, EMAIL fails five times (EXHAUSTED), SMS waits (no provider).
    const u1 = await newUser();
    const n1 = await suspend(u1);
    let now = new Date(Date.now() + 1_000);
    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatchDue(now);
      now = new Date(Math.max(+(await jobOf(n1, 'EMAIL')).nextAttemptAt, +now) + 1);
    }
    // U2: e-mail disabled after the job was queued → SUPPRESSED.
    const u2 = await newUser();
    const n2 = await suspend(u2);
    // A suspended account cannot call the API: reactivate it (one more queued notification) and log in again.
    await request(ctx.server).post(`/admin/users/${u2.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    const u2Again = { ...u2, ...(await login(ctx, u2.phone, u2.password)) };
    await request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(u2Again.accessToken)).send({ channels: [{ channel: 'EMAIL', enabled: false }] }).expect(200);
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    // U3: queued, never dispatched → PENDING everywhere; one job claimed by a "worker" → PROCESSING.
    const u3 = await newUser();
    const n3 = await suspend(u3);
    await ctx.prisma.notificationDeliveryJob.update({
      where: { notificationId_channel: { notificationId: n3, channel: 'PUSH' } },
      data: { status: 'PROCESSING', leaseExpiresAt: new Date(Date.now() + 120_000) },
    });
    // A provider free-text detail the API must never show.
    await ctx.prisma.deliveryAttempt.updateMany({ where: { notificationId: n1, channel: 'EMAIL' }, data: { errorDetail: `raw provider text ${u1.phone} sk_live_SECRET` } });

    seeded = {
      pushDone: (await jobOf(n1, 'PUSH')).id,
      smsPending: (await jobOf(n1, 'SMS')).id,
      emailExhausted: (await jobOf(n1, 'EMAIL')).id,
      emailSuppressed: (await jobOf(n2, 'EMAIL')).id,
      processing: (await jobOf(n3, 'PUSH')).id,
      emailPending: (await jobOf(n3, 'EMAIL')).id,
      failingNotification: n1,
    };
  });

  const get = (path: string, token = admin.accessToken) => request(ctx.server).get(path).set(...auth(token));
  const list = async (query: Record<string, string | number> = {}) => body(await get(BASE).query(query).expect(200)) as unknown as { items: Job[]; total: number; page: number; size: number };

  it('the seeded queue holds every state, produced by the real delivery path', async () => {
    const states = Object.fromEntries(await Promise.all(Object.entries(seeded).filter(([k]) => k !== 'failingNotification').map(async ([k, id]) => [k, (await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id } })).status])));
    expect(states).toEqual({ pushDone: 'COMPLETED', smsPending: 'PENDING', emailExhausted: 'EXHAUSTED', emailSuppressed: 'SUPPRESSED', processing: 'PROCESSING', emailPending: 'PENDING' });
    expect((await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id: seeded.emailExhausted } })).attemptCount).toBe(5);
  });

  it('lists newest first (id tie-break) and filters by status, channel, notification and date range; counts match the database', async () => {
    const all = await list({ size: 100 });
    const db = await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    expect(all.total).toBe(db.length);
    expect(all.items.map((j) => j.id)).toEqual(db.map((j) => j.id));
    expect((await list({ size: 100 })).items.map((j) => j.id)).toEqual(all.items.map((j) => j.id));

    for (const status of ['PENDING', 'PROCESSING', 'COMPLETED', 'SUPPRESSED', 'EXHAUSTED']) {
      const res = await list({ status, size: 100 });
      expect({ status, total: res.total, ok: res.items.every((j) => j.status === status) }).toEqual({ status, total: db.filter((j) => j.status === status).length, ok: true });
    }
    const sms = await list({ channel: 'SMS', size: 100 });
    expect(sms.total).toBe(db.filter((j) => j.channel === 'SMS').length);
    expect((await list({ notificationId: seeded.failingNotification })).items.map((j) => j.channel).sort()).toEqual(['EMAIL', 'PUSH', 'SMS']);
    expect((await list({ createdFrom: new Date(Date.now() + 3_600_000).toISOString() })).total).toBe(0);
    expect((await list({ createdTo: new Date().toISOString(), size: 100 })).total).toBe(db.length);
    const exhausted = db.find((j) => j.id === seeded.emailExhausted)!;
    expect((await list({ nextAttemptFrom: exhausted.nextAttemptAt.toISOString(), nextAttemptTo: exhausted.nextAttemptAt.toISOString() })).items.map((j) => j.id)).toContain(exhausted.id);
    const page2 = await list({ page: 2, size: 2 });
    expect(page2.items.map((j) => j.id)).toEqual(db.slice(2, 4).map((j) => j.id));
  });

  it('detail and attempt history: exact fields, oldest first, no errorDetail, only a message-id suffix; unknown → 404, malformed → 400', async () => {
    const detail = body(await get(`${BASE}/${seeded.emailExhausted}`).expect(200)) as unknown as Job;
    const row = await ctx.prisma.notificationDeliveryJob.findUniqueOrThrow({ where: { id: seeded.emailExhausted } });
    expect(detail).toEqual({
      id: row.id,
      notificationId: row.notificationId,
      channel: 'EMAIL',
      status: 'EXHAUSTED',
      attemptCount: 5,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      leaseExpiresAt: null,
      lastErrorCode: 'EMAIL_UNAVAILABLE',
      completedAt: row.completedAt!.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    const history = (body(await get(`${BASE}/${seeded.emailExhausted}/attempts`).expect(200)) as unknown as { items: Array<Record<string, unknown>> }).items;
    expect(history.map((a) => [a.attemptNumber, a.status, a.errorCode, a.provider, a.channel])).toEqual([1, 2, 3, 4, 5].map((n) => [n, 'FAILED', 'EMAIL_UNAVAILABLE', 'in-memory-email', 'EMAIL']));
    expect(Object.keys(history[0])).toEqual(['id', 'attemptNumber', 'channel', 'provider', 'providerMessageIdSuffix', 'status', 'errorCode', 'attemptedAt']);

    const pushHistory = (body(await get(`${BASE}/${seeded.pushDone}/attempts`).expect(200)) as unknown as { items: Array<Record<string, unknown>> }).items;
    const pushAttempt = await ctx.prisma.deliveryAttempt.findFirstOrThrow({ where: { channel: 'PUSH', status: 'SENT', notificationId: seeded.failingNotification } });
    expect(pushHistory).toEqual([expect.objectContaining({ status: 'SENT', providerMessageIdSuffix: `…${pushAttempt.providerMsgId!.slice(-8)}` })]);
    expect(JSON.stringify(pushHistory)).not.toContain(pushAttempt.providerMsgId!);

    expect((body(await get(`${BASE}/${seeded.smsPending}/attempts`).expect(200)) as unknown as { items: unknown[] }).items).toEqual([]);
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/${randomUUID()}/attempts`).expect(404);
    await get(`${BASE}/not-a-uuid`).expect(400);
  });

  it('summary: exact counts from the database — total, every status, every channel', async () => {
    const s = body(await get(`${BASE}/summary`).expect(200)) as unknown as { generatedAt: string; jobs: { total: number; byStatus: Record<string, number>; byChannel: Record<string, number> } };
    const db = await ctx.prisma.notificationDeliveryJob.findMany();
    const count = (k: 'status' | 'channel', v: string) => db.filter((j) => j[k] === v).length;
    expect(s.jobs).toEqual({
      total: db.length,
      byStatus: Object.fromEntries(['PENDING', 'PROCESSING', 'COMPLETED', 'SUPPRESSED', 'EXHAUSTED'].map((v) => [v, count('status', v)])),
      byChannel: Object.fromEntries(['PUSH', 'SMS', 'EMAIL'].map((v) => [v, count('channel', v)])),
    });
    expect(Number.isNaN(Date.parse(s.generatedAt))).toBe(false);
  });

  it('no recipient phone, rendered text, errorDetail, raw provider id or secret in any response; GETs write no audit row', async () => {
    const auditBefore = await ctx.prisma.auditLog.count();
    const responses = [
      (await get(BASE).query({ size: 100 })).body,
      (await get(`${BASE}/summary`)).body,
      ...(await Promise.all(Object.values(seeded).filter((v) => v !== seeded.failingNotification).flatMap((id) => [get(`${BASE}/${id}`), get(`${BASE}/${id}/attempts`)]))).map((r) => r.body),
    ];
    expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
    const raw = JSON.stringify(responses);
    const notifications = await ctx.prisma.notification.findMany();
    const users = await ctx.prisma.user.findMany({ select: { phone: true } });
    const attempts = await ctx.prisma.deliveryAttempt.findMany({ where: { providerMsgId: { not: null } } });
    for (const secret of [
      ...users.map((u) => u.phone).filter((p): p is string => !!p),
      ...notifications.flatMap((n) => [n.renderedTitle!, n.renderedBody!]),
      ...attempts.map((a) => a.providerMsgId!),
      'raw provider text', 'sk_live_SECRET', 'errorDetail', 'renderedBody', 'payload', 'recipientUserId',
    ]) {
      expect({ secret: secret.slice(0, 16), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 16), found: false });
    }
  });

  it('401 without authentication; 403 for every other role, including notification:read:own holders', async () => {
    for (const path of [BASE, `${BASE}/summary`, `${BASE}/${seeded.pushDone}`, `${BASE}/${seeded.pushDone}/attempts`]) {
      expect({ path, status: (await request(ctx.server).get(path)).status }).toEqual({ path, status: 401 });
    }
    const tokens: Array<[string, string]> = [['CUSTOMER', (await newUser()).accessToken]];
    for (const role of ['DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    for (const [role, token] of tokens) {
      for (const path of [BASE, `${BASE}/summary`, `${BASE}/${seeded.pushDone}`, `${BASE}/${seeded.pushDone}/attempts`]) {
        expect({ role, path, status: (await get(path, token)).status }).toEqual({ role, path, status: 403 });
      }
    }
    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'notification:queue:read' } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
    await get(BASE, (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
  });

  it('no mutation route exists; the queue is unchanged after trying, and delivery still runs normally', async () => {
    const before = await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } });
    const attemptsBefore = await ctx.prisma.deliveryAttempt.count();
    for (const [method, path] of [
      ['post', BASE], ['post', `${BASE}/${seeded.emailExhausted}/retry`], ['post', `${BASE}/${seeded.emailExhausted}/replay`],
      ['put', `${BASE}/${seeded.emailExhausted}`], ['patch', `${BASE}/${seeded.emailExhausted}`], ['delete', `${BASE}/${seeded.emailExhausted}`],
      ['delete', `${BASE}/${seeded.emailExhausted}/attempts`], ['post', `${BASE}/summary`],
    ] as const) {
      const res = await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({});
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
    expect(await ctx.prisma.notificationDeliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await ctx.prisma.deliveryAttempt.count()).toBe(attemptsBefore);

    // Module 13 delivery is unaffected: the pending PUSH job of a new notification goes out.
    const u = await newUser();
    const n = await suspend(u);
    await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
    expect((await jobOf(n, 'PUSH')).status).toBe('COMPLETED');
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

    it('Module 16 reaches the queue only through Module 13’s inbound ports — no Prisma, tables, repositories, entities or infrastructure', () => {
      const imports = new Set<string>();
      for (const file of sources(join(root, 'admin'))) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /notificationDeliveryJob|deliveryAttempt\b|notification_delivery_jobs|delivery_attempts|DELIVERY_ADMIN_REPOSITORY/.test(source) }).toEqual({ file: rel(file), found: false });
        for (const m of source.matchAll(/from '(?:\.\.\/)+notifications\/([^']+)'/g)) imports.add(m[1]);
      }
      expect([...imports].sort()).toEqual([
        'application/ports/inbound/notification-delivery-admin.port',
        'application/ports/inbound/notification-suppression-admin.port',
        'notifications.module',
      ]);
    });

    it('the queue controller and queries never import Prisma or a persistence adapter', () => {
      for (const file of sources(join(root, 'admin')).filter((f) => /delivery-queue/.test(f))) {
        expect({ file: rel(file), found: /PrismaService|@prisma\/client|infrastructure\/persistence/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), found: false });
      }
    });
  });
});
