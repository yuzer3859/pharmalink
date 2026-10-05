import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { ExpireVerificationsCommand } from '../../src/modules/identity/application/commands/expire-verifications.command';
import { EventBusService } from '../../src/shared/events/event-bus.service';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf, login, registerAndVerify, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { readyToCheckout } from '../orders/support';

type User = RegisteredUser & Tokens;

interface Item {
  id: string;
  type: string | null;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

interface Page {
  items: Item[];
  total: number;
  page: number;
  size: number;
}

const LICENSE_DOCS = [{ kind: 'BUSINESS_LICENSE', storageRef: 'enc://verification/biz-secret-ref' }];

/**
 * Module 13 Work 01 against real PostgreSQL and the real HTTP stack.
 *
 * Every notification here is caused the way production causes it: a real Module 01 or Module 06
 * command writes its event to the outbox, the relay publishes it on the shared bus, and Module
 * 13's handler records it. What can only be shown here: that the six events arrive and render in
 * the language Module 01 holds, that redelivery leaves one row (the database's unique
 * `dedupeKey` deciding), and that the routes serve each user their own inbox and nobody else's.
 */
describe('In-app notification center (e2e)', () => {
  let ctx: TestContext;
  let admin: User;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  // -------------------------------------------------------------------------------------------
  // Helpers — every cause goes through the owning module's own surface
  // -------------------------------------------------------------------------------------------

  async function newUser(): Promise<User> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }

  /** Module 01's own `PATCH /users/me` — the preference stays Module 01's. */
  async function setLanguage(user: User, preferredLanguage: 'am' | 'en'): Promise<void> {
    await request(ctx.server).patch('/users/me').set(...auth(user.accessToken)).send({ preferredLanguage }).expect(200);
  }

  async function submitLicence(user: User): Promise<string> {
    const res = await request(ctx.server)
      .post('/verification/documents')
      .set(...auth(user.accessToken))
      .send({ type: 'PHARMACY_LICENSE', documents: LICENSE_DOCS })
      .expect(202);
    return body(res).requestId as string;
  }

  const approve = (requestId: string, expiresAt?: string) =>
    request(ctx.server)
      .post(`/admin/verification/${requestId}/approve`)
      .set(...auth(admin.accessToken))
      .send(expiresAt ? { expiresAt } : {})
      .expect(204);

  const suspend = (userId: string, reason = 'Repeated chargebacks under review') =>
    request(ctx.server).post(`/admin/users/${userId}/suspend`).set(...auth(admin.accessToken)).send({ reason });

  const reactivate = (userId: string) =>
    request(ctx.server).post(`/admin/users/${userId}/reactivate`).set(...auth(admin.accessToken)).send({});

  const inbox = (token: string, query: Record<string, unknown> = {}) =>
    request(ctx.server).get('/notifications').query(query).set(...auth(token));
  const readInbox = async (token: string, query: Record<string, unknown> = {}) =>
    body(await inbox(token, query).expect(200)) as unknown as Page;
  const unread = async (token: string) =>
    (body(await request(ctx.server).get('/notifications/unread-count').set(...auth(token)).expect(200)) as { unread: number })
      .unread;
  const markRead = (token: string, id: string) =>
    request(ctx.server).post(`/notifications/${id}/read`).set(...auth(token)).send({});
  const markAll = (token: string) => request(ctx.server).post('/notifications/read-all').set(...auth(token)).send({});

  /** A customer with a real `order.placed` from Module 06's `POST /checkout`, delivered. */
  async function placeOrderAs(language: 'am' | 'en'): Promise<{ customer: User; orderId: string }> {
    const { user, addressId } = await readyToCheckout(ctx);
    await setLanguage(user, language);
    const res = await request(ctx.server)
      .post('/checkout')
      .set(...auth(user.accessToken))
      .send({ addressId, idempotencyKey: randomUUID() })
      .expect(201);
    await ctx.drainOutbox();
    return { customer: user, orderId: body(res).orderId as string };
  }

  /** Two notifications for `owner` (approved + reactivated) and none for anyone else. */
  async function ownerWithTwo(): Promise<User> {
    const owner = await newUser();
    await approve(await submitLicence(owner));
    await suspend(owner.userId).expect(204);
    await reactivate(owner.userId).expect(204);
    await ctx.drainOutbox();
    const fresh = { ...owner, ...(await login(ctx, owner.phone, owner.password)) };
    // Approved, suspended, reactivated — three. Read the suspension so two remain unread.
    const items = (await readInbox(fresh.accessToken)).items;
    await markRead(fresh.accessToken, items.find((i) => i.type === 'ACCOUNT_SUSPENDED')!.id).expect(200);
    return fresh;
  }

  // ===========================================================================================
  // 1. The six events, caused for real
  // ===========================================================================================

  describe('events', () => {
    it('order.placed → the customer’s order confirmation, in Amharic, with the order’s own total', async () => {
      const { customer, orderId } = await placeOrderAs('am');
      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });

      const page = await readInbox(customer.accessToken);
      expect(page.total).toBe(1);
      expect(page.items[0]).toEqual({
        id: expect.any(String),
        type: 'ORDER_PLACED',
        category: 'TRANSACTIONAL',
        title: 'ትዕዛዝዎ ደርሶናል',
        body: expect.stringContaining('ETB'),
        data: { orderId, grandTotal: order.grandTotal, currency: 'ETB' },
        read: false,
        createdAt: expect.any(String),
      });
      const stored = await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: customer.userId } });
      expect(stored).toMatchObject({ channel: 'IN_APP', status: 'SENT', eventType: 'order.placed' });
      const envelope = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'order.placed', aggregateId: orderId } });
      expect(stored.dedupeKey).toBe(`${(envelope.payload as unknown as DomainEvent).id}:${customer.userId}`);
    });

    it('identity.provider.approved → the applicant, in English by default', async () => {
      const owner = await newUser();
      const requestId = await submitLicence(owner);
      await approve(requestId);
      await ctx.drainOutbox();

      expect((await readInbox(owner.accessToken)).items).toEqual([
        expect.objectContaining({
          type: 'PROVIDER_VERIFICATION_APPROVED',
          category: 'SYSTEM',
          title: 'Verification approved',
          data: { verificationRequestId: requestId, verificationType: 'PHARMACY_LICENSE' },
          read: false,
        }),
      ]);
    });

    it('identity.provider.rejected → the applicant, in Amharic, with the reason Module 01 reports to them', async () => {
      const owner = await newUser();
      await setLanguage(owner, 'am');
      const requestId = await submitLicence(owner);
      await request(ctx.server)
        .post(`/admin/verification/${requestId}/reject`)
        .set(...auth(admin.accessToken))
        .send({ reason: 'Licence photo is unreadable' })
        .expect(204);
      await ctx.drainOutbox();

      const [n] = (await readInbox(owner.accessToken)).items;
      expect(n).toMatchObject({
        type: 'PROVIDER_VERIFICATION_REJECTED',
        title: 'ማረጋገጫዎ አልጸደቀም',
        body: 'የማረጋገጫ ጥያቄዎ አልጸደቀም። ምክንያት፦ Licence photo is unreadable',
        data: { verificationRequestId: requestId, verificationType: 'PHARMACY_LICENSE', reason: 'Licence photo is unreadable' },
      });
    });

    it('identity.account.suspended and .reactivated → the account holder, without the administrator’s reason', async () => {
      const user = await newUser();
      await suspend(user.userId, 'Internal fraud note 7731').expect(204);
      await reactivate(user.userId).expect(204);
      await ctx.drainOutbox();
      const fresh = await login(ctx, user.phone, user.password);

      const page = await readInbox(fresh.accessToken);
      expect(page.items.map((i) => [i.type, i.category, i.data])).toEqual([
        ['ACCOUNT_REACTIVATED', 'SECURITY', {}],
        ['ACCOUNT_SUSPENDED', 'SECURITY', {}],
      ]);
      expect(JSON.stringify(page)).not.toContain('7731');
      expect(JSON.stringify(page)).not.toContain(admin.userId);
    });

    it('identity.license.expired → the provider, alongside the suspension the expiry sweep causes', async () => {
      const owner = await newUser();
      const requestId = await submitLicence(owner);
      await approve(requestId, '2027-01-01T00:00:00.000Z');
      await ctx.app.get(ExpireVerificationsCommand).execute(new Date('2027-01-02T00:00:00.000Z'));
      await reactivate(owner.userId).expect(204);
      await ctx.drainOutbox();
      const fresh = await login(ctx, owner.phone, owner.password);

      const types = (await readInbox(fresh.accessToken)).items.map((i) => i.type).sort();
      expect(types).toEqual(
        ['ACCOUNT_REACTIVATED', 'ACCOUNT_SUSPENDED', 'PROVIDER_LICENSE_EXPIRED', 'PROVIDER_VERIFICATION_APPROVED'].sort(),
      );
      const expired = (await readInbox(fresh.accessToken)).items.find((i) => i.type === 'PROVIDER_LICENSE_EXPIRED')!;
      expect(expired).toMatchObject({
        title: 'Licence expired',
        data: { verificationRequestId: requestId, verificationType: 'PHARMACY_LICENSE', expiredAt: '2027-01-02T00:00:00.000Z' },
      });
    });

    it('notifies nobody the event does not name — not the administrator who acted', async () => {
      const owner = await newUser();
      await approve(await submitLicence(owner));
      await suspend(owner.userId).expect(204);
      await ctx.drainOutbox();
      expect((await readInbox(admin.accessToken)).total).toBe(0);
      expect(await ctx.prisma.notification.count({ where: { recipientUserId: { not: owner.userId } } })).toBe(0);
    });
  });

  // ===========================================================================================
  // 2. Idempotency — the database's unique dedupeKey is the last word
  // ===========================================================================================

  describe('idempotency', () => {
    it('a redelivered outbox event writes no second notification', async () => {
      const { customer, orderId } = await placeOrderAs('en');
      // The relay is at-least-once: un-publish the event and let it run again, twice.
      for (let i = 0; i < 2; i += 1) {
        await ctx.prisma.outbox.updateMany({ where: { eventType: 'order.placed', aggregateId: orderId }, data: { publishedAt: null } });
        await ctx.drainOutbox();
      }
      expect(await ctx.prisma.notification.count({ where: { recipientUserId: customer.userId } })).toBe(1);
    });

    it('concurrent deliveries of one event write one notification', async () => {
      const { customer, orderId } = await placeOrderAs('en');
      const envelope = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'order.placed', aggregateId: orderId } });
      const event = envelope.payload as unknown as DomainEvent;
      const bus = ctx.app.get(EventBusService);
      await Promise.all(Array.from({ length: 5 }, () => bus.publish(event)));
      expect(await ctx.prisma.notification.count({ where: { recipientUserId: customer.userId } })).toBe(1);
    });

    it('the unique index holds even against a direct duplicate insert', async () => {
      const { customer } = await placeOrderAs('en');
      const row = await ctx.prisma.notification.findFirstOrThrow({ where: { recipientUserId: customer.userId } });
      await expect(
        ctx.prisma.notification.create({
          data: { recipientUserId: customer.userId, category: 'TRANSACTIONAL', channel: 'IN_APP', dedupeKey: row.dedupeKey },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // ===========================================================================================
  // 3. Inbox: list, count, read, read-all — persisted
  // ===========================================================================================

  describe('inbox', () => {
    it('lists newest first, filters by read state, counts unread, and pages', async () => {
      const owner = await ownerWithTwo();
      const all = await readInbox(owner.accessToken);
      expect(all.total).toBe(3);
      const times = all.items.map((i) => Date.parse(i.createdAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(await unread(owner.accessToken)).toBe(2);
      expect((await readInbox(owner.accessToken, { unread: 'true' })).items.every((i) => !i.read)).toBe(true);
      expect((await readInbox(owner.accessToken, { unread: 'false' })).items.map((i) => i.type)).toEqual(['ACCOUNT_SUSPENDED']);
      const p1 = await readInbox(owner.accessToken, { size: 2, page: 1 });
      const p2 = await readInbox(owner.accessToken, { size: 2, page: 2 });
      expect([...p1.items, ...p2.items].map((i) => i.id)).toEqual(all.items.map((i) => i.id));
      expect([p1.size, p2.items.length]).toEqual([2, 1]);
    });

    it('marks one read — persisted as READ — and answers the same when repeated', async () => {
      const owner = await ownerWithTwo();
      const target = (await readInbox(owner.accessToken, { unread: 'true' })).items[0];
      const first = body(await markRead(owner.accessToken, target.id).expect(200));
      expect(first).toMatchObject({ id: target.id, read: true });
      expect(body(await markRead(owner.accessToken, target.id).expect(200))).toEqual(first);
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('READ');
      expect(await unread(owner.accessToken)).toBe(1);
    });

    it('read-all marks every unread notification READ, persisted, and is idempotent', async () => {
      const owner = await ownerWithTwo();
      expect(body(await markAll(owner.accessToken).expect(200))).toEqual({ updated: 2 });
      expect(body(await markAll(owner.accessToken).expect(200))).toEqual({ updated: 0 });
      expect(await ctx.prisma.notification.count({ where: { recipientUserId: owner.userId, status: { not: 'READ' } } })).toBe(0);
      expect(await unread(owner.accessToken)).toBe(0);
    });
  });

  // ===========================================================================================
  // 4. Ownership, validation, authorization, privacy, audit, routes, boundaries
  // ===========================================================================================

  describe('ownership', () => {
    it('another user cannot see, read or read-all someone else’s notifications', async () => {
      const owner = await ownerWithTwo();
      const intruder = await newUser();
      const ownersItem = (await readInbox(owner.accessToken, { unread: 'true' })).items[0];

      expect((await readInbox(intruder.accessToken)).total).toBe(0);
      expect(await unread(intruder.accessToken)).toBe(0);
      const res = await markRead(intruder.accessToken, ownersItem.id).expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
      expect(body(await markAll(intruder.accessToken).expect(200))).toEqual({ updated: 0 });

      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: ownersItem.id } })).status).toBe('SENT');
      expect(await unread(owner.accessToken)).toBe(2);
    });

    it('an unknown id is the same 404', async () => {
      const user = await newUser();
      const res = await markRead(user.accessToken, randomUUID()).expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  describe('validation', () => {
    it.each([
      ['unread=yes', { unread: 'yes' }],
      ['page 0', { page: 0 }],
      ['a non-numeric page', { page: 'one' }],
      ['size 101', { size: 101 }],
      ['a recipientUserId', { recipientUserId: randomUUID() }],
      ['a userId', { userId: randomUUID() }],
      ['an actorUserId', { actorUserId: randomUUID() }],
    ])('GET /notifications rejects %s with 400', async (_label, query) => {
      const user = await newUser();
      const res = await inbox(user.accessToken, query).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('POST /notifications/:id/read rejects a malformed id with 400', async () => {
      const user = await newUser();
      const res = await markRead(user.accessToken, 'not-a-uuid').expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('authorization', () => {
    it('refuses an unauthenticated caller on every route', async () => {
      for (const [method, path] of [
        ['get', '/notifications'],
        ['get', '/notifications/unread-count'],
        ['post', `/notifications/${randomUUID()}/read`],
        ['post', '/notifications/read-all'],
      ] as const) {
        const res = await request(ctx.server)[method](path).send({});
        expect({ path, status: res.status }).toEqual({ path, status: 401 });
      }
    });

    it('refuses a caller whose roles do not carry notification:read:own', async () => {
      const user = await registerAndVerify(ctx);
      await ctx.prisma.userRole.deleteMany({ where: { userId: user.userId } });
      const { accessToken } = await login(ctx, user.phone, user.password);
      const res = await inbox(accessToken).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    });

    it('grants notification:read:own to every role, and SUPER_ADMIN reaches it by wildcard', async () => {
      const permission = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'notification:read:own' } });
      expect(permission).toMatchObject({ resource: 'notification', action: 'read', scope: 'own' });
      const holders = await ctx.prisma.rolePermission.findMany({
        where: { permissionId: permission.id },
        include: { role: { select: { key: true } } },
      });
      const roles = await ctx.prisma.role.findMany({ where: { key: { not: 'SUPER_ADMIN' } } });
      expect(holders.map((h) => h.role.key).sort()).toEqual(roles.map((r) => r.key).sort());
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      await inbox(superAdmin.accessToken).expect(200);
      expect(await ctx.prisma.permission.count({ where: { resource: 'notification' } })).toBe(1);
    });
  });

  describe('privacy', () => {
    it('carries no recipient, contact detail, credential, document reference, dedupe key or source event in the raw body', async () => {
      const owner = await newUser();
      await approve(await submitLicence(owner));
      await ctx.drainOutbox();
      const raw = JSON.stringify((await inbox(owner.accessToken).expect(200)).body);
      for (const forbidden of [
        owner.userId, owner.phone, admin.userId, 'recipientUserId', 'reviewerId', 'organizationId', 'dedupeKey', 'eventType',
        'identity.provider', 'storageRef', 'enc://', 'passwordHash', 'accessToken', 'faydaId', 'payload',
      ]) {
        expect({ forbidden, found: raw.includes(forbidden) }).toEqual({ forbidden, found: false });
      }
    });
  });

  describe('audit', () => {
    it('reads, the unread count, read and read-all append no audit entry', async () => {
      const owner = await ownerWithTwo();
      const target = (await readInbox(owner.accessToken, { unread: 'true' })).items[0];
      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      await readInbox(owner.accessToken);
      await unread(owner.accessToken);
      await markRead(owner.accessToken, target.id).expect(200);
      await markAll(owner.accessToken).expect(200);
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before);
    });
  });

  describe('routes', () => {
    it('serves the four routes and nothing else under /notifications', async () => {
      const user = await newUser();
      for (const [method, path] of [
        ['post', '/notifications'],
        ['get', `/notifications/${randomUUID()}`],
        ['patch', `/notifications/${randomUUID()}`],
        ['delete', `/notifications/${randomUUID()}`],
        ['get', '/notifications/preferences'],
        ['post', '/notifications/devices'],
        ['get', '/admin/notifications'],
      ] as const) {
        const res = await request(ctx.server)[method](path).set(...auth(user.accessToken)).send({});
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
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

    it('Module 13 touches no Module 01 or 06 table, repository, entity, command, query or infrastructure', () => {
      const files = sources();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          '$queryRaw',
          '$executeRaw',
          // Module 01
          'prisma.user',
          'prisma.verificationRequest',
          'prisma.session',
          'USER_REPOSITORY',
          'VERIFICATION_REPOSITORY',
          'identity/domain/entities',
          'identity/domain/repositories',
          'identity/domain/enums',
          'identity/infrastructure/',
          'identity/application/commands/',
          'identity/application/queries/',
          // Module 06
          'prisma.order',
          'prisma.fulfillment',
          'prisma.cart',
          'ORDER_REPOSITORY',
          'orders/domain/entities',
          'orders/domain/repositories',
          'orders/infrastructure/',
          'orders/application/',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Module 13 reaches other modules only through Module 01’s language port, the event contracts and @CurrentUser', () => {
      const imports = new Set<string>();
      for (const file of sources()) {
        for (const m of readFileSync(file, 'utf8').matchAll(/from '((?:\.\.\/)+(?!shared\/)[^.'][^']*)'/g)) {
          const target = m[1].replace(/^(\.\.\/)+/, '');
          if (!target.startsWith('notifications/') && /^(identity|profiles|catalog|pharmacy-inventory|prescription-matching|orders|payment|delivery|admin)\//.test(target)) {
            imports.add(target);
          }
        }
      }
      expect([...imports].sort()).toEqual([
        'identity/application/ports/inbound/identity-language-read.port',
        'identity/domain/events',
        'identity/identity.module',
        'identity/interface/decorators/current-user.decorator',
        'orders/domain/events',
      ]);
    });
  });
});
