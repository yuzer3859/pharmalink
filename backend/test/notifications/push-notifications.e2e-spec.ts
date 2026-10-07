import { generateKeyPairSync } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import http from 'http';
import https from 'https';
import { join } from 'path';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { PUSH_TRANSPORT } from '../../src/modules/notifications/application/ports/outbound/push-transport.port';
import { NotificationDeliveryDispatcher } from '../../src/modules/notifications/application/services/notification-delivery.dispatcher';
import { FCM_TOKEN_URL, FcmHttpV1Transport } from '../../src/modules/notifications/infrastructure/push/fcm-http-v1.transport';
import { FCM_CONFIG_KEYS, FcmConfig } from '../../src/modules/notifications/infrastructure/push/fcm.config';
import { NOTIFICATION_DELIVERY_INTERVAL } from '../../src/modules/notifications/infrastructure/scheduling/notification-delivery.scheduler';
import { IConfigPort } from '../../src/shared/config/config.port';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { AppLogger } from '../../src/shared/logging/app-logger.service';
import { auth, body, createUserWithRole, errorOf, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Script = 'OK' | 'UNREGISTERED' | 'UNAVAILABLE' | 'TIMEOUT';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ACCESS_TOKEN = 'ya29.e2e-ACCESS-TOKEN-SECRET';
const FCM_ENV = {
  [FCM_CONFIG_KEYS.projectId]: 'pharmalink-e2e',
  [FCM_CONFIG_KEYS.clientEmail]: 'push@pharmalink-e2e.iam.gserviceaccount.com',
  [FCM_CONFIG_KEYS.privateKey]: PEM.replace(/\n/g, '\\n'),
};

/**
 * Stands in for the network only. Everything above it is production code: the registry factory
 * (which binds PUSH because these credentials are present), `PushNotificationProvider`,
 * `PrismaDeviceTokenRepository`, the dispatcher, and `FcmHttpV1Transport` — its JWT exchange,
 * request shape, timeouts and error mapping.
 */
class FakeFcm {
  sends: Array<{ token: string; title: string; body: string; data: Record<string, string>; authorization: string }> = [];
  tokenExchanges = 0;
  script = new Map<string, Script>();
  fetch = (async (url: string, init: RequestInit) => {
    if (url === FCM_TOKEN_URL) {
      this.tokenExchanges++;
      return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }), { status: 200 });
    }
    const { message } = JSON.parse(String(init.body));
    this.sends.push({ token: message.token, ...message.notification, data: message.data, authorization: (init.headers as Record<string, string>).authorization });
    const fcmError = (status: number, errorCode: string) =>
      new Response(
        JSON.stringify({ error: { code: status, message: `body mentions ${message.token} and ${ACCESS_TOKEN}`, details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } }),
        { status },
      );
    switch (this.script.get(message.token) ?? 'OK') {
      case 'OK':
        return new Response(JSON.stringify({ name: `projects/pharmalink-e2e/messages/msg-${this.sends.length}` }), { status: 200 });
      case 'UNREGISTERED':
        return fcmError(404, 'UNREGISTERED');
      case 'UNAVAILABLE':
        return fcmError(503, 'UNAVAILABLE');
      case 'TIMEOUT':
        // What AbortSignal.timeout does to fetch once the request timeout passes.
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
  }) as unknown as typeof fetch;
  forUser(tokens: string[]) {
    return this.sends.filter((s) => tokens.includes(s.token));
  }
}

/** Module 13 Work 14 against real PostgreSQL: device registration and push delivery through FCM. */
describe('Push notifications (e2e)', () => {
  let ctx: TestContext;
  let dispatcher: NotificationDeliveryDispatcher;
  const fcm = new FakeFcm();
  const configPort = { get: (k: string) => (FCM_ENV as Record<string, string>)[k], getOrThrow: () => '', isFeatureEnabled: () => false } as unknown as IConfigPort;

  beforeAll(async () => {
    const transport = new FcmHttpV1Transport(new FcmConfig(configPort), new AppLogger(), fcm.fetch);
    ctx = await createTestApp([{ provide: PUSH_TRANSPORT, useValue: transport }]);
    dispatcher = ctx.app.get(NotificationDeliveryDispatcher);
    ctx.app.get(SchedulerRegistry).deleteInterval(NOTIFICATION_DELIVERY_INTERVAL);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    fcm.sends = [];
    fcm.script.clear();
  });

  const A1 = 'e2e-fcm-token-userA-phone-AAAA0001';
  const A2 = 'e2e-fcm-token-userA-tablet-AAAA0002';
  const B1 = 'e2e-fcm-token-userB-phone-BBBB0001';

  async function newUser(): Promise<User> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }
  const register = (u: User, token: string, platform = 'ANDROID') =>
    request(ctx.server).post('/notification-devices').set(...auth(u.accessToken)).send({ token, platform });
  const listDevices = async (u: User) =>
    (body(await request(ctx.server).get('/notification-devices').set(...auth(u.accessToken)).expect(200)) as unknown as { items: Array<{ id: string; maskedToken: string; platform: string }> }).items;
  const setPush = (u: User, enabled: boolean) =>
    request(ctx.server).put('/notification-preferences/SECURITY').set(...auth(u.accessToken)).send({ channels: [{ channel: 'PUSH', enabled }] }).expect(200);

  /** Module 01's own suspend → reactivate: two real SECURITY notifications for the user. */
  async function cycle(u: User): Promise<{ user: User; suspended: string; reactivated: string }> {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const before = await ctx.prisma.notification.findMany({ where: { recipientUserId: u.userId }, select: { id: true } });
    await request(ctx.server).post(`/admin/users/${u.userId}/suspend`).set(...auth(admin.accessToken)).send({ reason: 'Review' }).expect(204);
    await request(ctx.server).post(`/admin/users/${u.userId}/reactivate`).set(...auth(admin.accessToken)).send({}).expect(204);
    await ctx.drainOutbox();
    const fresh = await ctx.prisma.notification.findMany({ where: { recipientUserId: u.userId, id: { notIn: before.map((b) => b.id) } } });
    return {
      user: { ...u, ...(await login(ctx, u.phone, u.password)) },
      suspended: fresh.find((n) => n.templateCode === 'ACCOUNT_SUSPENDED')!.id,
      reactivated: fresh.find((n) => n.templateCode === 'ACCOUNT_REACTIVATED')!.id,
    };
  }
  const pushJob = (notificationId: string) => ctx.prisma.notificationDeliveryJob.findUnique({ where: { notificationId_channel: { notificationId, channel: 'PUSH' } } });
  const pushAttempts = (notificationId: string) => ctx.prisma.deliveryAttempt.findMany({ where: { notificationId, channel: 'PUSH' }, orderBy: { attemptNumber: 'asc' } });
  const soon = () => new Date(Date.now() + 1_000);
  const inboxIds = async (u: User) =>
    ((body(await request(ctx.server).get('/notifications').set(...auth(u.accessToken)).expect(200)) as unknown as { items: Array<{ id: string }> }).items).map((i) => i.id);

  describe('device registration', () => {
    it('A registers two devices and B one; each sees only their own, masked; duplicates refresh; revoke is owner-only', async () => {
      const a = await newUser();
      const b = await newUser();
      const a1 = body(await register(a, A1).expect(201));
      await register(a, A2, 'IOS').expect(201);
      const b1 = body(await register(b, B1).expect(201));
      expect(a1).toEqual({ id: expect.any(String), platform: 'ANDROID', maskedToken: '…AA0001', lastSeenAt: expect.any(String), createdAt: expect.any(String) });

      // Re-registering is idempotent.
      expect(body(await register(a, A1).expect(201)).id).toBe(a1.id);
      expect(await ctx.prisma.deviceToken.count({ where: { userId: a.userId } })).toBe(2);

      expect((await listDevices(a)).map((d) => d.maskedToken).sort()).toEqual(['…AA0001', '…AA0002']);
      expect((await listDevices(b)).map((d) => d.id)).toEqual([b1.id]);

      // B cannot revoke A's device; unknown is the same 404; a malformed id is 400.
      const denied = await request(ctx.server).delete(`/notification-devices/${a1.id}`).set(...auth(b.accessToken)).expect(404);
      expect(errorOf(denied).code).toBe(ErrorCode.NOT_FOUND);
      await request(ctx.server).delete('/notification-devices/00000000-0000-4000-8000-000000000000').set(...auth(a.accessToken)).expect(404);
      await request(ctx.server).delete('/notification-devices/not-a-uuid').set(...auth(a.accessToken)).expect(400);
      expect(await ctx.prisma.deviceToken.findUniqueOrThrow({ where: { id: a1.id as string } })).toMatchObject({ isActive: true });

      await request(ctx.server).delete(`/notification-devices/${a1.id}`).set(...auth(a.accessToken)).expect(204);
      expect((await listDevices(a)).map((d) => d.maskedToken)).toEqual(['…AA0002']);
      expect(await ctx.prisma.deviceToken.findUniqueOrThrow({ where: { id: a1.id as string } })).toMatchObject({ isActive: false, userId: a.userId });
    });

    it.each([
      ['userId', { token: A1, platform: 'ANDROID', userId: '00000000-0000-4000-8000-000000000000' }],
      ['actorUserId', { token: A1, platform: 'ANDROID', actorUserId: 'x' }],
      ['an unknown platform', { token: A1, platform: 'SYMBIAN' }],
      ['a numeric token', { token: 1234567890123456, platform: 'ANDROID' }],
      ['no token', { platform: 'ANDROID' }],
    ])('refuses %s with 400 and stores nothing', async (_l, payload) => {
      const a = await newUser();
      const res = await request(ctx.server).post('/notification-devices').set(...auth(a.accessToken)).send(payload).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(await ctx.prisma.deviceToken.count()).toBe(0);
    });

    it('401 without authentication; 403 without the notification permissions', async () => {
      for (const [method, path] of [['get', '/notification-devices'], ['post', '/notification-devices'], ['delete', '/notification-devices/00000000-0000-4000-8000-000000000000']] as const) {
        expect((await request(ctx.server)[method](path).send({ token: A1, platform: 'ANDROID' })).status).toBe(401);
      }
      const u = await registerAndVerify(ctx);
      await ctx.prisma.userRole.deleteMany({ where: { userId: u.userId } });
      const { accessToken } = await login(ctx, u.phone, u.password);
      expect((await request(ctx.server).get('/notification-devices').set(...auth(accessToken))).status).toBe(403);
      expect((await request(ctx.server).post('/notification-devices').set(...auth(accessToken)).send({ token: A1, platform: 'ANDROID' })).status).toBe(403);
    });
  });

  describe('delivery', () => {
    it('pushes A’s notification to A’s two devices — never B’s — with the rendered text, and completes the job', async () => {
      const a = await newUser();
      const b = await newUser();
      await register(a, A1).expect(201);
      await register(a, A2, 'IOS').expect(201);
      await register(b, B1).expect(201);
      const { user, reactivated } = await cycle(a);
      expect(await pushJob(reactivated)).toMatchObject({ status: 'PENDING', attemptCount: 0 });
      expect(await ctx.prisma.notificationDeliveryJob.count({ where: { notificationId: reactivated, channel: 'IN_APP' } })).toBe(0);

      await dispatcher.dispatchDue(soon());
      const n = await ctx.prisma.notification.findUniqueOrThrow({ where: { id: reactivated } });
      const toA = fcm.sends.filter((s) => s.data.notificationId === reactivated);
      expect(toA.map((s) => s.token).sort()).toEqual([A1, A2].sort());
      expect(toA[0]).toMatchObject({ title: n.renderedTitle, body: n.renderedBody, data: { notificationId: reactivated }, authorization: `Bearer ${ACCESS_TOKEN}` });
      expect(fcm.sends.some((s) => s.token === B1)).toBe(false);
      expect(await pushJob(reactivated)).toMatchObject({ status: 'COMPLETED', attemptCount: 1, leaseExpiresAt: null });
      const [attempt, ...more] = await pushAttempts(reactivated);
      expect(more).toEqual([]);
      expect(attempt).toMatchObject({ attemptNumber: 1, status: 'SENT', provider: 'fcm', providerMsgId: expect.stringMatching(/^msg-\d+$/), errorCode: null, errorDetail: null });
      // In-app unchanged and visible.
      expect(n).toMatchObject({ channel: 'IN_APP', status: 'SENT' });
      expect(await inboxIds(user)).toContain(reactivated);
    });

    it('PUSH disabled before creation → no job; disabled after creation → SUPPRESSED with no FCM call; re-enabling resurrects nothing', async () => {
      const a = await newUser();
      await register(a, A1).expect(201);
      await setPush(a, false);
      const first = await cycle(a);
      expect(await pushJob(first.reactivated)).toBeNull();

      await setPush(first.user, true);
      const second = await cycle(first.user);
      expect(await pushJob(second.reactivated)).toMatchObject({ status: 'PENDING' });
      await setPush(second.user, false);
      await dispatcher.dispatchDue(soon());
      expect(await pushJob(second.reactivated)).toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'PREFERENCE_DISABLED' });
      expect((await pushAttempts(second.reactivated)).map((x) => [x.status, x.errorCode])).toEqual([['SUPPRESSED', 'PREFERENCE_DISABLED']]);
      expect(fcm.sends).toEqual([]);

      await setPush(second.user, true);
      await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
      expect(fcm.forUser([A1]).filter((s) => s.data.notificationId === second.reactivated)).toEqual([]);
      expect(await pushJob(second.reactivated)).toMatchObject({ status: 'SUPPRESSED' });
    });

    it('a transient FCM failure retries on the backoff schedule; a timeout is a bounded, retryable failure', async () => {
      const a = await newUser();
      await register(a, A1).expect(201);
      const { reactivated } = await cycle(a);
      fcm.script.set(A1, 'UNAVAILABLE');
      const t0 = soon();
      await dispatcher.dispatchDue(t0);
      let job = (await pushJob(reactivated))!;
      expect(job).toMatchObject({ status: 'PENDING', attemptCount: 1, lastErrorCode: 'FCM_UNAVAILABLE' });
      expect(+job.nextAttemptAt - +t0).toBe(30_000);

      fcm.script.set(A1, 'TIMEOUT');
      await dispatcher.dispatchDue(job.nextAttemptAt);
      job = (await pushJob(reactivated))!;
      expect(job).toMatchObject({ status: 'PENDING', attemptCount: 2, lastErrorCode: 'FCM_TIMEOUT' });

      fcm.script.set(A1, 'OK');
      await dispatcher.dispatchDue(job.nextAttemptAt);
      expect(await pushJob(reactivated)).toMatchObject({ status: 'COMPLETED', attemptCount: 3 });
      expect((await pushAttempts(reactivated)).map((x) => [x.attemptNumber, x.status, x.errorCode, x.errorDetail])).toEqual([
        [1, 'FAILED', 'FCM_UNAVAILABLE', null],
        [2, 'FAILED', 'FCM_TIMEOUT', null],
        [3, 'SENT', null, null],
      ]);
    });

    it('an invalid token is deactivated; with one valid device still there the push is SENT; with none left it stops at once', async () => {
      const a = await newUser();
      await register(a, A1).expect(201);
      await register(a, A2, 'IOS').expect(201);
      fcm.script.set(A1, 'UNREGISTERED');
      const first = await cycle(a);
      await dispatcher.dispatchDue(soon());
      expect(await pushJob(first.reactivated)).toMatchObject({ status: 'COMPLETED' });
      expect((await ctx.prisma.deviceToken.findMany({ where: { userId: a.userId }, orderBy: { token: 'asc' } })).map((t) => [t.token, t.isActive])).toEqual([
        [A1, false],
        [A2, true],
      ]);
      expect((await listDevices(first.user)).map((d) => d.maskedToken)).toEqual(['…AA0002']);

      // The dead token is never tried again; when the last one dies too, the job ends after one
      // attempt. (A cycle is two notifications: the first to go out finds A2 dead and deactivates it,
      // the second then finds no device at all.)
      const sendsToA1 = fcm.forUser([A1]).length;
      fcm.script.set(A2, 'UNREGISTERED');
      const second = await cycle(first.user);
      await dispatcher.dispatchDue(soon());
      expect(fcm.forUser([A1])).toHaveLength(sendsToA1);
      const ends = [await pushJob(second.suspended), await pushJob(second.reactivated)];
      expect(ends.map((j) => [j!.status, j!.attemptCount])).toEqual([
        ['EXHAUSTED', 1],
        ['EXHAUSTED', 1],
      ]);
      expect(ends.map((j) => j!.lastErrorCode).sort()).toEqual(['FCM_UNREGISTERED', 'NO_ACTIVE_DEVICE']);
      expect(await ctx.prisma.deviceToken.count({ where: { userId: a.userId, isActive: true } })).toBe(0);

      // No device at all: one NO_ACTIVE_DEVICE attempt, no retries.
      const third = await cycle(second.user);
      await dispatcher.dispatchDue(soon());
      await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
      expect((await pushAttempts(third.reactivated)).map((x) => [x.attemptNumber, x.status, x.errorCode])).toEqual([[1, 'FAILED', 'NO_ACTIVE_DEVICE']]);
      expect(await pushJob(third.reactivated)).toMatchObject({ status: 'EXHAUSTED' });
    });

    it('five transient failures exhaust the job; no sixth FCM call', async () => {
      const a = await newUser();
      await register(a, A1).expect(201);
      const { reactivated } = await cycle(a);
      fcm.script.set(A1, 'UNAVAILABLE');
      let now = soon();
      for (let i = 0; i < 6; i++) {
        await dispatcher.dispatchDue(now);
        const j = (await pushJob(reactivated))!;
        now = new Date(Math.max(+j.nextAttemptAt, +now) + 1);
      }
      expect(await pushJob(reactivated)).toMatchObject({ status: 'EXHAUSTED', attemptCount: 5 });
      expect(fcm.sends.filter((s) => s.data.notificationId === reactivated)).toHaveLength(5);
    });

    it('SMS and EMAIL jobs still wait PENDING with no attempt — no provider pretends to send them', async () => {
      const a = await newUser();
      await register(a, A1).expect(201);
      const { reactivated } = await cycle(a);
      await dispatcher.dispatchDue(new Date(Date.now() + 86_400_000));
      const others = await ctx.prisma.notificationDeliveryJob.findMany({ where: { notificationId: reactivated, channel: { in: ['SMS', 'EMAIL'] } } });
      expect(others.map((j) => [j.status, j.attemptCount])).toEqual([
        ['PENDING', 0],
        ['PENDING', 0],
      ]);
      expect(await ctx.prisma.deliveryAttempt.count({ where: { channel: { in: ['SMS', 'EMAIL'] } } })).toBe(0);
    });
  });

  describe('privacy and side effects', () => {
    it('no raw token, access token or key in HTTP responses, captured output, attempts, jobs or audit; no audit rows; no real network', async () => {
      const out: string[] = [];
      const capture = (stream: NodeJS.WriteStream) =>
        jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
          out.push(String(chunk));
          return true;
        }) as never);
      const spies = [capture(process.stdout), capture(process.stderr)];
      try {
        const a = await newUser();
        const responses: unknown[] = [];
        responses.push((await register(a, A1).expect(201)).body);
        responses.push((await register(a, A2, 'IOS').expect(201)).body);
        responses.push((await request(ctx.server).get('/notification-devices').set(...auth(a.accessToken))).body);
        fcm.script.set(A1, 'UNREGISTERED');
        fcm.script.set(A2, 'UNAVAILABLE');
        const auditBefore = await ctx.prisma.auditLog.count();
        const { user, reactivated } = await cycle(a);
        const auditAfterCycle = await ctx.prisma.auditLog.count();
        // supertest itself uses `http`, so the network spies wrap the delivery alone.
        const network = [jest.spyOn(http, 'request'), jest.spyOn(https, 'request')];
        try {
          await dispatcher.dispatchDue(soon());
          for (const spy of network) expect(spy).not.toHaveBeenCalled();
        } finally {
          for (const spy of network) spy.mockRestore();
        }
        responses.push((await request(ctx.server).get('/notifications').set(...auth(user.accessToken))).body);
        await request(ctx.server).post(`/notifications/${reactivated}/read`).set(...auth(user.accessToken)).send({}).expect(200);
        await request(ctx.server).delete(`/notification-devices/${(responses[1] as { data: { id: string } }).data.id}`).set(...auth(user.accessToken)).expect(204);
        // Only Module 01's suspend/reactivate audit; nothing from devices, delivery or reads.
        expect(await ctx.prisma.auditLog.count()).toBe(auditAfterCycle);
        expect(auditAfterCycle - auditBefore).toBeGreaterThan(0);

        const persisted = JSON.stringify([
          responses,
          await ctx.prisma.deliveryAttempt.findMany(),
          await ctx.prisma.notificationDeliveryJob.findMany(),
          await ctx.prisma.auditLog.findMany(),
          await ctx.prisma.notification.findMany(),
          out,
        ]);
        for (const secret of [A1, A2, ACCESS_TOKEN, 'PRIVATE KEY', FCM_ENV.FCM_CLIENT_EMAIL, 'body mentions']) {
          expect({ secret: secret.slice(0, 14), found: persisted.includes(secret) }).toEqual({ secret: secret.slice(0, 14), found: false });
        }
        expect((await pushAttempts(reactivated))[0]).toMatchObject({ status: 'FAILED', errorCode: 'FCM_UNAVAILABLE', errorDetail: null });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
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

    it('only the device-token adapter touches device_tokens; controllers, providers, the transport and ports never touch Prisma', () => {
      expect(sources().filter((f) => /\.deviceToken\b/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual(['infrastructure/persistence/prisma-device-token.repository.ts']);
      for (const file of sources().filter((f) => /^(interface|application|domain|infrastructure\/providers|infrastructure\/push)\//.test(rel(f)))) {
        expect({ file: rel(file), prisma: /PrismaService|@prisma\/client|prisma\.\w+/.test(readFileSync(file, 'utf8')) }).toEqual({ file: rel(file), prisma: false });
      }
    });

    it('no credential literal anywhere in Module 13; credentials are read only by FcmConfig', () => {
      for (const file of sources()) {
        const source = readFileSync(file, 'utf8');
        expect({ file: rel(file), found: /BEGIN (RSA )?PRIVATE KEY|ya29\.|AAAA[A-Za-z0-9_-]{30,}/.test(source) }).toEqual({ file: rel(file), found: false });
      }
      expect(sources().filter((f) => /'FCM_(PRIVATE_KEY|CLIENT_EMAIL|PROJECT_ID)'/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual(['infrastructure/push/fcm.config.ts']);
    });

    it('Module 13 never reaches Module 01 or 02 persistence, the deprecated preference table, or raw SQL', () => {
      for (const file of sources()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [/prisma\.(device|user|session|notificationPreference)\b/, /identity\/infrastructure\//, /modules\/profiles\//, /\$queryRaw|\$executeRaw/]) {
          expect({ file: rel(file), forbidden: String(forbidden), found: forbidden.test(source) }).toEqual({ file: rel(file), forbidden: String(forbidden), found: false });
        }
      }
    });
  });
});
