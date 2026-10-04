import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { IdentityEventType } from '../../src/modules/identity/domain/events';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import {
  auth,
  body,
  createUserWithRole,
  DEVICE,
  errorOf,
  grantRoleDirect,
  login,
  registerAndVerify,
  RegisteredUser,
  Tokens,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const ACCOUNTS = '/admin/accounts';

interface UserRow {
  userId: string;
  phone: string | null;
  email: string | null;
  primaryRole: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ListBody {
  items: UserRow[];
  total: number;
  page: number;
  size: number;
}

interface DetailBody extends UserRow {
  preferredLanguage: string;
  phoneVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  faydaVerifiedAt: string | null;
  deletionRequestedAt: string | null;
  deletedAt: string | null;
  roles: Array<{ roleKey: string; roleName: string; organizationId: string | null; createdAt: string }>;
}

interface ChangeBody {
  userId: string;
  previousStatus: string;
  status: string;
  changedAt: string;
}

/**
 * Module 16 Work 03 against real PostgreSQL and the real HTTP stack.
 *
 * What can only be shown here: that a suspension taken through the admin surface is Module 01's
 * suspension (its status write, its credential revocation, its event, its audit entry), that the
 * transitions Module 01 refuses are refused here with no admin audit written, that the list and
 * detail carry nothing that authenticates an account, and that the guards keep everyone but an
 * administrator out — including from Module 01's own `/admin/users` routes, which keep answering
 * exactly as before.
 */
describe('Admin user & account management (e2e)', () => {
  let ctx: TestContext;
  let admin: RegisteredUser & Tokens;

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

  async function plainUser(): Promise<RegisteredUser & Tokens> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }

  const list = (token: string, query: Record<string, string | number> = {}) =>
    request(ctx.server).get(ACCOUNTS).set(...auth(token)).query(query);
  const detail = (token: string, id: string) =>
    request(ctx.server).get(`${ACCOUNTS}/${id}`).set(...auth(token));
  const suspend = (token: string, id: string, payload: Record<string, unknown> = {}) =>
    request(ctx.server).post(`${ACCOUNTS}/${id}/suspend`).set(...auth(token)).send(payload);
  const reinstate = (token: string, id: string, payload: Record<string, unknown> = {}) =>
    request(ctx.server).post(`${ACCOUNTS}/${id}/reinstate`).set(...auth(token)).send(payload);

  const SENSITIVE = ['passwordHash', 'permVersion', 'faydaId', 'storageRef', 'refreshToken', 'guardianId'];

  // -------------------------------------------------------------------------------------------
  // 1. List
  // -------------------------------------------------------------------------------------------

  describe('list', () => {
    it('lists every account for an administrator, newest first', async () => {
      const first = await plainUser();
      const second = await plainUser();

      const page = body(await list(admin.accessToken).expect(200)) as unknown as ListBody;
      // The admin fixture itself plus the two users.
      expect(page.total).toBe(3);
      const ids = page.items.map((i) => i.userId);
      expect(ids.indexOf(second.userId)).toBeLessThan(ids.indexOf(first.userId));
      expect(page.items.find((i) => i.userId === first.userId)).toMatchObject({
        phone: first.phone,
        primaryRole: 'CUSTOMER',
        status: 'ACTIVE',
      });
    });

    it('filters by account status, primary role and exact identifier', async () => {
      const user = await plainUser();
      const driver = await plainUser();
      await ctx.prisma.user.update({ where: { id: driver.userId }, data: { primaryRole: 'DRIVER' } });
      await suspend(admin.accessToken, user.userId, { reason: 'Fraud investigation' }).expect(200);

      const suspended = body(
        await list(admin.accessToken, { status: 'SUSPENDED' }).expect(200),
      ) as unknown as ListBody;
      expect(suspended.items.map((i) => i.userId)).toEqual([user.userId]);

      const drivers = body(
        await list(admin.accessToken, { primaryRole: 'DRIVER' }).expect(200),
      ) as unknown as ListBody;
      expect(drivers.items.map((i) => i.userId)).toEqual([driver.userId]);

      const byPhone = body(
        await list(admin.accessToken, { identifier: driver.phone }).expect(200),
      ) as unknown as ListBody;
      expect(byPhone.items.map((i) => i.userId)).toEqual([driver.userId]);

      const none = body(
        await list(admin.accessToken, { identifier: '+251900000000' }).expect(200),
      ) as unknown as ListBody;
      expect(none.total).toBe(0);
    });

    it('pages deterministically without overlap', async () => {
      await plainUser();
      await plainUser();
      await plainUser();

      const first = body(await list(admin.accessToken, { page: 1, size: 2 }).expect(200)) as unknown as ListBody;
      const second = body(await list(admin.accessToken, { page: 2, size: 2 }).expect(200)) as unknown as ListBody;
      const again = body(await list(admin.accessToken, { page: 1, size: 2 }).expect(200)) as unknown as ListBody;

      expect(first).toMatchObject({ total: 4, page: 1, size: 2 });
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(2);
      const all = [...first.items, ...second.items].map((i) => i.userId);
      expect(new Set(all).size).toBe(4);
      expect(again.items.map((i) => i.userId)).toEqual(first.items.map((i) => i.userId));
    });

    it('refuses a filter over a value Module 01 does not define, and an oversized page', async () => {
      const invalid: Array<Record<string, string | number>> = [
        { status: 'BANNED' },
        { primaryRole: 'ROOT' },
        { size: 101 },
        { page: 0 },
      ];
      for (const query of invalid) {
        const res = await list(admin.accessToken, query).expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });

    it('carries nothing that authenticates an account', async () => {
      await plainUser();
      const res = await list(admin.accessToken).expect(200);
      const raw = JSON.stringify(res.body);
      for (const field of SENSITIVE) {
        expect(raw).not.toContain(field);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Detail
  // -------------------------------------------------------------------------------------------

  describe('detail', () => {
    it('shows an administrator the account and its role assignments', async () => {
      const user = await plainUser();
      const org = await ctx.prisma.organization.create({
        data: { type: 'PHARMACY', name: 'Bole Pharmacy', ownerUserId: user.userId },
      });
      await grantRoleDirect(ctx, user.userId, 'PHARMACY_OWNER', org.id);

      const view = body(await detail(admin.accessToken, user.userId).expect(200)) as unknown as DetailBody;
      expect(view).toMatchObject({
        userId: user.userId,
        phone: user.phone,
        primaryRole: 'CUSTOMER',
        status: 'ACTIVE',
        deletedAt: null,
      });
      expect(view.phoneVerifiedAt).not.toBeNull();
      expect(view.faydaVerifiedAt).toBeNull();
      expect(view.roles.map((r) => [r.roleKey, r.organizationId])).toEqual(
        expect.arrayContaining([
          ['CUSTOMER', null],
          ['PHARMACY_OWNER', org.id],
        ]),
      );
    });

    it('carries nothing that authenticates an account', async () => {
      const user = await plainUser();
      const res = await detail(admin.accessToken, user.userId).expect(200);
      const raw = JSON.stringify(res.body);
      for (const field of SENSITIVE) {
        expect(raw).not.toContain(field);
      }
    });

    it('answers 404 for an unknown user', async () => {
      const res = await detail(admin.accessToken, '00000000-0000-4000-8000-000000000000').expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses an authenticated user without the permission, even for their own account', async () => {
      const user = await plainUser();
      const res = await detail(user.accessToken, user.userId).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Suspend
  // -------------------------------------------------------------------------------------------

  describe('suspend', () => {
    it('is Module 01 suspension: status, revoked credentials, event and audit', async () => {
      const user = await plainUser();

      const res = await suspend(admin.accessToken, user.userId, { reason: 'Fraud investigation' }).expect(200);
      expect(body(res) as unknown as ChangeBody).toMatchObject({
        userId: user.userId,
        previousStatus: 'ACTIVE',
        status: 'SUSPENDED',
      });

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(stored.status).toBe('SUSPENDED');

      // Module 01's credential revocation happened.
      const stale = await request(ctx.server).get('/users/me').set(...auth(user.accessToken)).expect(401);
      expect(errorOf(stale).code).toBe('TOKEN_EXPIRED');
      const loginAttempt = await request(ctx.server)
        .post('/auth/login')
        .send({ identifier: user.phone, password: user.password, deviceInfo: DEVICE })
        .expect(403);
      expect(errorOf(loginAttempt).code).toBe('AUTH_ACCOUNT_SUSPENDED');

      // Module 01's event, with Module 01's payload.
      const events = await ctx.prisma.outbox.findMany({
        where: { eventType: IdentityEventType.AccountSuspended },
      });
      expect(events).toHaveLength(1);
      const envelope = events[0].payload as unknown as { aggregateId: string; payload: Record<string, unknown> };
      expect(envelope.aggregateId).toBe(user.userId);
      expect(envelope.payload).toMatchObject({
        userId: user.userId,
        actorUserId: admin.userId,
        reason: 'Fraud investigation',
      });
      expect(await ctx.prisma.outbox.count({ where: { eventType: { startsWith: 'admin.' } } })).toBe(0);
    });

    it('writes the admin audit entry after Module 01 own, chained', async () => {
      const user = await plainUser();
      await suspend(admin.accessToken, user.userId, { reason: 'Fraud investigation' }).expect(200);

      const entries = await ctx.prisma.auditLog.findMany({
        where: { resourceId: user.userId, action: { in: ['identity.account.suspended', 'ADMIN_USER_SUSPENDED'] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e) => e.action)).toEqual(['identity.account.suspended', 'ADMIN_USER_SUSPENDED']);
      const adminEntry = entries[1];
      expect(adminEntry.actorUserId).toBe(admin.userId);
      expect(adminEntry.resourceType).toBe('user');
      expect(adminEntry.context).toMatchObject({
        targetUserId: user.userId,
        previousStatus: 'ACTIVE',
        status: 'SUSPENDED',
        reason: 'Fraud investigation',
      });
      expect(adminEntry.prevHash).toBe(entries[0].hash);
    });

    it('repeats as Module 01 does — an idempotent no-op reported as an unchanged transition', async () => {
      const user = await plainUser();
      await suspend(admin.accessToken, user.userId, { reason: 'Fraud investigation' }).expect(200);

      const again = body(
        await suspend(admin.accessToken, user.userId, { reason: 'Retry from tooling' }).expect(200),
      ) as unknown as ChangeBody;
      expect(again).toMatchObject({ previousStatus: 'SUSPENDED', status: 'SUSPENDED' });

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(stored.status).toBe('SUSPENDED');
      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_USER_SUSPENDED' } })).toBe(2);
    });

    it('refuses self-suspension through Module 01 rule, with no admin audit', async () => {
      const res = await suspend(admin.accessToken, admin.userId, { reason: 'Testing' }).expect(422);
      expect(errorOf(res).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
      expect(stored.status).toBe('ACTIVE');
      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_USER_SUSPENDED' } })).toBe(0);
    });

    it('refuses a terminal account through Module 01 rule, with no admin audit', async () => {
      const user = await plainUser();
      await ctx.prisma.user.update({ where: { id: user.userId }, data: { status: 'DEACTIVATED' } });

      const res = await suspend(admin.accessToken, user.userId, { reason: 'Fraud investigation' }).expect(422);
      expect(errorOf(res).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(stored.status).toBe('DEACTIVATED');
      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_USER_SUSPENDED' } })).toBe(0);
    });

    it('answers 404 for an unknown user, with no admin audit', async () => {
      const res = await suspend(admin.accessToken, '00000000-0000-4000-8000-000000000000', {
        reason: 'Fraud investigation',
      }).expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_USER_SUSPENDED' } })).toBe(0);
    });

    it('requires a reason and rejects a body that names the actor', async () => {
      const user = await plainUser();
      const other = await createUserWithRole(ctx, 'ADMIN');

      for (const payload of [
        {},
        { reason: '' },
        { reason: 'no' },
        { reason: 'x'.repeat(501) },
        { reason: 'Fraud investigation', actorUserId: other.userId },
        { reason: 'Fraud investigation', targetUserId: other.userId },
      ]) {
        const res = await suspend(admin.accessToken, user.userId, payload).expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(stored.status).toBe('ACTIVE');
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Reinstate
  // -------------------------------------------------------------------------------------------

  describe('reinstate', () => {
    it('is Module 01 reactivation: SUSPENDED -> ACTIVE, login restored, event and audit', async () => {
      const user = await plainUser();
      await suspend(admin.accessToken, user.userId, { reason: 'Fraud investigation' }).expect(200);

      const res = await reinstate(admin.accessToken, user.userId, { reason: 'Appeal upheld' }).expect(200);
      expect(body(res) as unknown as ChangeBody).toMatchObject({
        userId: user.userId,
        previousStatus: 'SUSPENDED',
        status: 'ACTIVE',
      });

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(stored.status).toBe('ACTIVE');
      await login(ctx, user.phone, user.password);

      expect(
        await ctx.prisma.outbox.count({ where: { eventType: IdentityEventType.AccountReactivated } }),
      ).toBe(1);

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'ADMIN_USER_REINSTATED', resourceId: user.userId },
      });
      expect(entry.actorUserId).toBe(admin.userId);
      expect(entry.context).toMatchObject({
        previousStatus: 'SUSPENDED',
        status: 'ACTIVE',
        reason: 'Appeal upheld',
      });
    });

    it('refuses an account that is not suspended, with no admin audit', async () => {
      const user = await plainUser();

      const active = await reinstate(admin.accessToken, user.userId).expect(422);
      expect(errorOf(active).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);

      await ctx.prisma.user.update({ where: { id: user.userId }, data: { status: 'DEACTIVATED' } });
      const deactivated = await reinstate(admin.accessToken, user.userId).expect(422);
      expect(errorOf(deactivated).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);

      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_USER_REINSTATED' } })).toBe(0);
    });

    it('answers 404 for an unknown user, and rejects an actor field', async () => {
      const res = await reinstate(admin.accessToken, '00000000-0000-4000-8000-000000000000').expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);

      const user = await plainUser();
      const bad = await reinstate(admin.accessToken, user.userId, { actorUserId: admin.userId }).expect(400);
      expect(errorOf(bad).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('a second reinstatement is refused because the account is already ACTIVE', async () => {
      const user = await plainUser();
      await suspend(admin.accessToken, user.userId, { reason: 'Fraud investigation' }).expect(200);
      await reinstate(admin.accessToken, user.userId).expect(200);

      const again = await reinstate(admin.accessToken, user.userId).expect(422);
      expect(errorOf(again).code).toBe(ErrorCode.BUSINESS_RULE_VIOLATION);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_USER_REINSTATED' } })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Ownership and boundaries
  // -------------------------------------------------------------------------------------------

  describe('ownership and boundaries', () => {
    it('Module 16 source touches no Module 01 table, repository, entity or command', () => {
      const root = join(__dirname, '..', '..', 'src', 'modules', 'admin');
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
        }
      };
      walk(root);
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'prisma.user',
          'prisma.userRole',
          'prisma.organization',
          'prisma.session',
          'prisma.refreshToken',
          'USER_REPOSITORY',
          'IUserRepository',
          'domain/entities/user.entity',
          'identity/application/commands/',
          'identity/application/queries/',
          'identity/infrastructure/',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({
            file,
            forbidden,
            found: false,
          });
        }
      }
    });

    it('leaves Module 01 own /admin/users routes answering exactly as before', async () => {
      const user = await plainUser();

      await request(ctx.server)
        .post(`/admin/users/${user.userId}/suspend`)
        .set(...auth(admin.accessToken))
        .send({ reason: 'fraud investigation' })
        .expect(204);
      await request(ctx.server)
        .post(`/admin/users/${user.userId}/reactivate`)
        .set(...auth(admin.accessToken))
        .expect(204);
      await request(ctx.server)
        .get(`/admin/users/${user.userId}/roles`)
        .set(...auth(admin.accessToken))
        .expect(200);

      // Module 01's route writes no Module 16 audit — the two surfaces are distinct.
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: { in: ['ADMIN_USER_SUSPENDED', 'ADMIN_USER_REINSTATED'] } },
        }),
      ).toBe(0);
      // And the admin surface sees what Module 01 did.
      const view = body(await detail(admin.accessToken, user.userId).expect(200)) as unknown as DetailBody;
      expect(view.status).toBe('ACTIVE');
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Security
  // -------------------------------------------------------------------------------------------

  describe('security', () => {
    it.each(['CUSTOMER', 'DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER'])(
      'refuses %s on every route',
      async (role) => {
        const target = await plainUser();
        const caller = await createUserWithRole(ctx, role);

        for (const res of [
          await list(caller.accessToken),
          await detail(caller.accessToken, target.userId),
          await suspend(caller.accessToken, target.userId, { reason: 'not allowed' }),
          await reinstate(caller.accessToken, target.userId),
        ]) {
          expect(res.status).toBe(403);
          expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
        }

        const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
        expect(stored.status).toBe('ACTIVE');
      },
    );

    it('refuses an unauthenticated caller', async () => {
      const target = await plainUser();
      await request(ctx.server).get(ACCOUNTS).expect(401);
      await request(ctx.server).post(`${ACCOUNTS}/${target.userId}/suspend`).send({ reason: 'x'.repeat(3) }).expect(401);
    });

    it('admits SUPER_ADMIN through the wildcard', async () => {
      const target = await plainUser();
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');

      await list(superAdmin.accessToken).expect(200);
      await detail(superAdmin.accessToken, target.userId).expect(200);
      await suspend(superAdmin.accessToken, target.userId, { reason: 'Fraud investigation' }).expect(200);
      await reinstate(superAdmin.accessToken, target.userId).expect(200);
    });
  });
});
