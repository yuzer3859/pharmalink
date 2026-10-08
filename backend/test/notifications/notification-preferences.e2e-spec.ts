import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;

interface ChannelView {
  channel: string;
  enabled: boolean;
  digestFrequency: string;
  configurable: boolean;
  source: string;
}

interface CategoryView {
  category: string;
  channels: ChannelView[];
}

/**
 * Module 13 Work 11 against real PostgreSQL and the real HTTP stack: notification preferences on
 * `channel_preferences`, the single authority, read and written only through the caller's own
 * routes. Module 02's deprecated `notification_preferences` is never touched.
 */
describe('Notification preferences (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  async function newUser(): Promise<User> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }

  const getAll = (token: string) => request(ctx.server).get('/notification-preferences').set(...auth(token));
  const getOne = (token: string, category: string) =>
    request(ctx.server).get(`/notification-preferences/${category}`).set(...auth(token));
  const put = (token: string, category: string, payload: unknown) =>
    request(ctx.server).put(`/notification-preferences/${category}`).set(...auth(token)).send(payload as object);

  const readAll = async (token: string) =>
    (body(await getAll(token).expect(200)) as unknown as { categories: CategoryView[] }).categories;
  const readOne = async (token: string, category: string) =>
    body(await getOne(token, category).expect(200)) as unknown as CategoryView;
  const channel = (view: CategoryView, name: string) => view.channels.find((c) => c.channel === name)!;

  const DEFAULT_CHANNELS: ChannelView[] = [
    { channel: 'IN_APP', enabled: true, digestFrequency: 'IMMEDIATE', configurable: false, source: 'POLICY' },
    { channel: 'PUSH', enabled: true, digestFrequency: 'IMMEDIATE', configurable: true, source: 'DEFAULT' },
    { channel: 'SMS', enabled: true, digestFrequency: 'IMMEDIATE', configurable: true, source: 'DEFAULT' },
    { channel: 'EMAIL', enabled: true, digestFrequency: 'IMMEDIATE', configurable: true, source: 'DEFAULT' },
  ];

  describe('defaults', () => {
    it('with no rows, serves every category at the documented defaults — and the read writes no row', async () => {
      const a = await newUser();
      expect(await readAll(a.accessToken)).toEqual(
        ['TRANSACTIONAL', 'SECURITY', 'SYSTEM'].map((category) => ({ category, channels: DEFAULT_CHANNELS })),
      );
      expect(await readOne(a.accessToken, 'SECURITY')).toEqual({ category: 'SECURITY', channels: DEFAULT_CHANNELS });
      expect(await ctx.prisma.channelPreference.count()).toBe(0);
    });
  });

  describe('own preferences', () => {
    it('user A creates a preference, reads it back, updates it, and it persists across requests', async () => {
      const a = await newUser();
      const created = body(
        await put(a.accessToken, 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: false, digestFrequency: 'DAILY' }] }).expect(200),
      ) as unknown as CategoryView;
      expect(channel(created, 'SMS')).toEqual({ channel: 'SMS', enabled: false, digestFrequency: 'DAILY', configurable: true, source: 'STORED' });

      // The canonical table, directly.
      expect(
        await ctx.prisma.channelPreference.findMany({ select: { userId: true, category: true, channel: true, enabled: true, digestFrequency: true } }),
      ).toEqual([{ userId: a.userId, category: 'TRANSACTIONAL', channel: 'SMS', enabled: false, digestFrequency: 'DAILY' }]);

      // A second request sees it; the untouched channels and categories stay at their defaults.
      const again = await readOne(a.accessToken, 'TRANSACTIONAL');
      expect(again.channels.map((c) => [c.channel, c.enabled, c.digestFrequency, c.source])).toEqual([
        ['IN_APP', true, 'IMMEDIATE', 'POLICY'],
        ['PUSH', true, 'IMMEDIATE', 'DEFAULT'],
        ['SMS', false, 'DAILY', 'STORED'],
        ['EMAIL', true, 'IMMEDIATE', 'DEFAULT'],
      ]);
      expect(await readOne(a.accessToken, 'SECURITY')).toEqual({ category: 'SECURITY', channels: DEFAULT_CHANNELS });

      // Update: re-enable, digest omitted → kept; add EMAIL in the same request.
      await put(a.accessToken, 'TRANSACTIONAL', {
        channels: [{ channel: 'SMS', enabled: true }, { channel: 'EMAIL', enabled: false, digestFrequency: 'WEEKLY' }],
      }).expect(200);
      const updated = await readOne(a.accessToken, 'TRANSACTIONAL');
      expect(channel(updated, 'SMS')).toMatchObject({ enabled: true, digestFrequency: 'DAILY', source: 'STORED' });
      expect(channel(updated, 'EMAIL')).toMatchObject({ enabled: false, digestFrequency: 'WEEKLY', source: 'STORED' });
      expect(await ctx.prisma.channelPreference.count({ where: { userId: a.userId } })).toBe(2);

      // Repeating a PUT changes nothing.
      const before = await readAll(a.accessToken);
      await put(a.accessToken, 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: true }] }).expect(200);
      expect(await readAll(a.accessToken)).toEqual(before);
      expect(await ctx.prisma.channelPreference.count({ where: { userId: a.userId } })).toBe(2);
    });

    it('concurrent first writes of the same preference leave one row', async () => {
      const a = await newUser();
      const results = await Promise.all(
        [true, false, true, false, false].map((enabled) => put(a.accessToken, 'SYSTEM', { channels: [{ channel: 'PUSH', enabled }] })),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await ctx.prisma.channelPreference.count({ where: { userId: a.userId, category: 'SYSTEM', channel: 'PUSH' } })).toBe(1);
    });

    it('user B can neither read nor change user A’s preferences — there is no way to name them', async () => {
      const a = await newUser();
      const b = await newUser();
      await put(a.accessToken, 'SECURITY', { channels: [{ channel: 'PUSH', enabled: false }] }).expect(200);

      // B sees only B's own (defaults), never A's stored row.
      expect(await readOne(b.accessToken, 'SECURITY')).toEqual({ category: 'SECURITY', channels: DEFAULT_CHANNELS });
      expect(JSON.stringify(await readAll(b.accessToken))).not.toContain('STORED');

      // B naming A, in the body or the query string, is refused or ignored — never applied to A.
      const smuggled = await put(b.accessToken, 'SECURITY', { userId: a.userId, channels: [{ channel: 'PUSH', enabled: true }] }).expect(400);
      expect(errorOf(smuggled).code).toBe(ErrorCode.VALIDATION_ERROR);
      await request(ctx.server)
        .put('/notification-preferences/SECURITY')
        .query({ userId: a.userId })
        .set(...auth(b.accessToken))
        .send({ channels: [{ channel: 'PUSH', enabled: true }] });
      await getAll(b.accessToken).query({ userId: a.userId });
      await request(ctx.server).get(`/notification-preferences/${a.userId}`).set(...auth(b.accessToken)).expect(400);

      expect(channel(await readOne(a.accessToken, 'SECURITY'), 'PUSH')).toMatchObject({ enabled: false, source: 'STORED' });
      expect(
        await ctx.prisma.channelPreference.findFirst({ where: { userId: a.userId, category: 'SECURITY', channel: 'PUSH' } }),
      ).toMatchObject({ enabled: false });
    });
  });

  describe('validation', () => {
    it.each([
      ['an unknown category', 'MARKETING', { channels: [{ channel: 'SMS', enabled: false }] }],
      ['a category with no template', 'REMINDER', { channels: [{ channel: 'SMS', enabled: false }] }],
      ['a lowercase category', 'transactional', { channels: [{ channel: 'SMS', enabled: false }] }],
      ['the IN_APP channel', 'TRANSACTIONAL', { channels: [{ channel: 'IN_APP', enabled: false }] }],
      ['an unknown channel', 'TRANSACTIONAL', { channels: [{ channel: 'FAX', enabled: false }] }],
      ['an invalid digest frequency', 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: false, digestFrequency: 'MONTHLY' }] }],
      ['a string boolean', 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: 'false' }] }],
      ['a duplicated channel', 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: false }, { channel: 'SMS', enabled: true }] }],
      ['an empty list', 'TRANSACTIONAL', { channels: [] }],
      ['an unknown top-level field', 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: false }], quietHours: '22:00' }],
      ['actorUserId', 'TRANSACTIONAL', { actorUserId: 'x', channels: [{ channel: 'SMS', enabled: false }] }],
      ['createdBy', 'TRANSACTIONAL', { createdBy: 'x', channels: [{ channel: 'SMS', enabled: false }] }],
      ['an internal id in a channel', 'TRANSACTIONAL', { channels: [{ id: 'row-1', channel: 'SMS', enabled: false }] }],
      ['arbitrary JSON in a channel', 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: false, extra: { a: 1 } }] }],
    ])('refuses %s with 400 and stores nothing', async (_label, category, payload) => {
      const a = await newUser();
      const res = await put(a.accessToken, category, payload).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(await ctx.prisma.channelPreference.count()).toBe(0);
    });

    it('refuses an unknown category on read with 400', async () => {
      const a = await newUser();
      for (const category of ['MARKETING', 'REMINDER', 'nope']) {
        expect({ category, status: (await getOne(a.accessToken, category)).status }).toEqual({ category, status: 400 });
      }
    });
  });

  describe('authorization', () => {
    it('refuses an unauthenticated caller on every route with 401', async () => {
      for (const [method, path] of [
        ['get', '/notification-preferences'],
        ['get', '/notification-preferences/TRANSACTIONAL'],
        ['put', '/notification-preferences/TRANSACTIONAL'],
      ] as const) {
        const res = await request(ctx.server)[method](path).send({ channels: [{ channel: 'SMS', enabled: false }] });
        expect({ path, method, status: res.status }).toEqual({ path, method, status: 401 });
      }
    });

    it('refuses a caller with no notification permission with 403 on every route', async () => {
      const user = await registerAndVerify(ctx);
      await ctx.prisma.userRole.deleteMany({ where: { userId: user.userId } });
      const { accessToken } = await login(ctx, user.phone, user.password);
      for (const res of [
        await getAll(accessToken),
        await getOne(accessToken, 'TRANSACTIONAL'),
        await put(accessToken, 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: false }] }),
      ]) {
        expect(res.status).toBe(403);
        expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      }
    });

    it('a caller who may read but not manage can read and is refused the write with 403', async () => {
      const permission = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'notification:manage:own' } });
      const customer = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'CUSTOMER' } });
      await ctx.prisma.rolePermission.deleteMany({ where: { permissionId: permission.id, roleId: customer.id } });
      const a = await newUser();
      await getAll(a.accessToken).expect(200);
      const res = await put(a.accessToken, 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: false }] }).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      expect(await ctx.prisma.channelPreference.count()).toBe(0);
    });

    it('notification:manage:own is own-scoped and held by exactly the roles holding notification:read:own', async () => {
      const permission = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'notification:manage:own' } });
      expect(permission).toMatchObject({ resource: 'notification', action: 'manage', scope: 'own' });
      const holdersOf = async (key: string) =>
        (
          await ctx.prisma.rolePermission.findMany({
            where: { permission: { key } },
            include: { role: { select: { key: true } } },
          })
        )
          .map((h) => h.role.key)
          .sort();
      expect(await holdersOf('notification:manage:own')).toEqual(await holdersOf('notification:read:own'));
      expect(await ctx.prisma.permission.findMany({ where: { resource: 'notification' }, select: { key: true }, orderBy: { key: 'asc' } })).toEqual([
        { key: 'notification:manage:own' },
        // Work 21: the ADMIN-only delivery retry (test/admin/admin-delivery-retry.e2e-spec.ts).
        { key: 'notification:queue:manage' },
        // Work 20: the ADMIN-only delivery-queue read (test/admin/admin-delivery-queue.e2e-spec.ts).
        { key: 'notification:queue:read' },
        { key: 'notification:read:own' },
      ]);
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      await put(superAdmin.accessToken, 'SYSTEM', { channels: [{ channel: 'EMAIL', enabled: false }] }).expect(200);
    });
  });

  describe('side effects', () => {
    it('reads and writes create no notification, no audit row, no outbox event — and never touch Module 02’s table', async () => {
      const a = await newUser();
      await ctx.drainOutbox();
      const counts = async () => ({
        notifications: await ctx.prisma.notification.count(),
        audit: await ctx.prisma.auditLog.count(),
        outbox: await ctx.prisma.outbox.count(),
        legacy: await ctx.prisma.notificationPreference.count(),
      });
      const before = await counts();
      expect(before.legacy).toBe(0);

      await readAll(a.accessToken);
      await readOne(a.accessToken, 'TRANSACTIONAL');
      await put(a.accessToken, 'TRANSACTIONAL', { channels: [{ channel: 'SMS', enabled: false }] }).expect(200);
      await put(a.accessToken, 'SECURITY', { channels: [{ channel: 'EMAIL', enabled: false, digestFrequency: 'HOURLY' }] }).expect(200);
      await put(a.accessToken, 'TRANSACTIONAL', { channels: [{ channel: 'IN_APP', enabled: false }] }).expect(400);
      await ctx.drainOutbox();

      expect(await counts()).toEqual(before);
      expect(await ctx.prisma.channelPreference.count()).toBe(2);
    });

    it('the response carries no row id, owner or timestamp', async () => {
      const a = await newUser();
      const res = await put(a.accessToken, 'SYSTEM', { channels: [{ channel: 'PUSH', enabled: false }] }).expect(200);
      const row = await ctx.prisma.channelPreference.findFirstOrThrow({ where: { userId: a.userId } });
      const raw = JSON.stringify(res.body) + JSON.stringify((await getAll(a.accessToken)).body);
      for (const forbidden of [row.id, a.userId, a.phone, 'userId', 'updatedAt', '"id"']) {
        expect({ forbidden, found: raw.includes(forbidden) }).toEqual({ forbidden, found: false });
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

    it('Module 13 never reaches Module 02 — its module, repositories, infrastructure or its preference table', () => {
      for (const file of sources()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [/modules\/profiles\//, /'(?:\.\.\/)+profiles\//, /prisma\.notificationPreference\b/, /ProfilesModule/, /PROFILE_REPOSITORY|ADDRESS_REPOSITORY/]) {
          expect({ file, forbidden: String(forbidden), found: forbidden.test(source) }).toEqual({ file, forbidden: String(forbidden), found: false });
        }
      }
    });

    it('only the preference adapter touches channel_preferences; controllers and application code never import Prisma', () => {
      const touching = sources().filter((f) => /prisma\.channelPreference\b/.test(readFileSync(f, 'utf8')));
      expect(touching.map((f) => f.replace(/\\/g, '/').split('/notifications/')[1])).toEqual([
        'infrastructure/persistence/prisma-notification-preference.repository.ts',
      ]);
      for (const file of sources().filter((f) => /[\\/](interface|application|domain)[\\/]/.test(f))) {
        const source = readFileSync(file, 'utf8');
        expect({ file, prisma: /PrismaService|@prisma\/client|infrastructure\//.test(source) }).toEqual({ file, prisma: false });
      }
    });
  });
});
