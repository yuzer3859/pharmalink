import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  login,
  registerAndVerify,
  RegisteredUser,
  Tokens,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const ROLES = '/admin/roles';
const ACCOUNTS = '/admin/accounts';

interface RoleRow {
  id: string;
  key: string;
  name: string;
  scope: string;
  isSystem: boolean;
  description: string | null;
  permissions: string[];
}

interface AssignmentRow {
  assignmentId: string;
  roleKey: string;
  roleName: string;
  organizationId: string | null;
  createdAt: string;
}

interface ChangeBody {
  assignmentId: string;
  userId: string;
  roleKey: string;
  organizationId: string | null;
  roles: Array<{ roleKey: string; organizationId: string | null }>;
}

/**
 * Module 16 Work 04 against real PostgreSQL and the real HTTP stack.
 *
 * What can only be shown here: that an assignment made through the admin surface is Module
 * 01's assignment (its row, its permVersion bump, its audit entry), that every refusal is
 * Module 01's own and leaves no admin audit, and — the part that matters most — what the
 * repository's actual escalation policy is: `rbac:manage` is the whole of it, `SUPER_ADMIN`
 * alone holds it, and nothing narrower exists in Module 01 to be preserved or bypassed.
 */
describe('Admin role management (e2e)', () => {
  let ctx: TestContext;
  let superAdmin: RegisteredUser & Tokens;
  let admin: RegisteredUser & Tokens;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  async function plainUser(): Promise<RegisteredUser & Tokens> {
    const registered = await registerAndVerify(ctx);
    return { ...registered, ...(await login(ctx, registered.phone, registered.password)) };
  }

  async function organization(owner: RegisteredUser): Promise<string> {
    const org = await ctx.prisma.organization.create({
      data: { type: 'PHARMACY', name: 'Bole Pharmacy', ownerUserId: owner.userId },
    });
    return org.id;
  }

  const listRoles = (token: string) => request(ctx.server).get(ROLES).set(...auth(token));
  const userRoles = (token: string, id: string) =>
    request(ctx.server).get(`${ACCOUNTS}/${id}/roles`).set(...auth(token));
  const assign = (token: string, id: string, payload: Record<string, unknown>) =>
    request(ctx.server).post(`${ACCOUNTS}/${id}/roles`).set(...auth(token)).send(payload);
  const revoke = (token: string, id: string, assignmentId: string) =>
    request(ctx.server).delete(`${ACCOUNTS}/${id}/roles/${assignmentId}`).set(...auth(token));

  const adminAudits = () =>
    ctx.prisma.auditLog.count({ where: { action: { in: ['ADMIN_ROLE_ASSIGNED', 'ADMIN_ROLE_REVOKED'] } } });

  // -------------------------------------------------------------------------------------------
  // 1. Catalogue
  // -------------------------------------------------------------------------------------------

  describe('role catalogue', () => {
    it('lists exactly Module 01 seeded roles, with their permission keys', async () => {
      const roles = body(await listRoles(admin.accessToken).expect(200)) as unknown as RoleRow[];
      const seeded = await ctx.prisma.role.findMany({ select: { key: true } });
      expect(roles.map((r) => r.key).sort()).toEqual(seeded.map((r) => r.key).sort());

      const superRole = roles.find((r) => r.key === 'SUPER_ADMIN')!;
      expect(superRole.scope).toBe('PLATFORM');
      expect(superRole.permissions).toEqual(['*']);
      const owner = roles.find((r) => r.key === 'PHARMACY_OWNER')!;
      expect(owner.scope).toBe('ORG');
      expect(owner.permissions).toContain('pharmacy:manage:org');
    });

    it('is the same catalogue Module 01 own route returns', async () => {
      const ours = body(await listRoles(admin.accessToken).expect(200)) as unknown as RoleRow[];
      const theirs = body(
        await request(ctx.server).get('/admin/rbac/roles').set(...auth(admin.accessToken)).expect(200),
      ) as unknown as RoleRow[];
      expect(ours).toEqual(theirs);
    });

    it('offers no way to create, edit or delete a role', async () => {
      await request(ctx.server).post(ROLES).set(...auth(superAdmin.accessToken)).send({ key: 'X' }).expect(404);
      await request(ctx.server).delete(`${ROLES}/ADMIN`).set(...auth(superAdmin.accessToken)).expect(404);
      expect(await ctx.prisma.role.count({ where: { key: 'X' } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. A user's roles
  // -------------------------------------------------------------------------------------------

  describe('user roles', () => {
    it('lists the assignments Module 01 holds, including the organization of an ORG role', async () => {
      const user = await plainUser();
      const orgId = await organization(user);
      await assign(superAdmin.accessToken, user.userId, { roleKey: 'PHARMACY_OWNER', organizationId: orgId }).expect(201);

      const roles = body(await userRoles(admin.accessToken, user.userId).expect(200)) as unknown as AssignmentRow[];
      expect(roles.map((r) => [r.roleKey, r.organizationId])).toEqual(
        expect.arrayContaining([
          ['CUSTOMER', null],
          ['PHARMACY_OWNER', orgId],
        ]),
      );
      for (const row of roles) {
        expect(row.assignmentId).toMatch(/^[0-9a-f-]{36}$/);
      }
      const raw = JSON.stringify(roles);
      for (const field of ['passwordHash', 'permVersion', 'roleId', 'assignedBy', 'refreshToken']) {
        expect(raw).not.toContain(field);
      }
    });

    it('answers 404 for an unknown user', async () => {
      const res = await userRoles(admin.accessToken, '00000000-0000-4000-8000-000000000000').expect(404);
      expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Assign
  // -------------------------------------------------------------------------------------------

  describe('assign', () => {
    it('is Module 01 assignment: row, permVersion bump, Module 01 audit, then the admin audit', async () => {
      const user = await plainUser();
      const before = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });

      const res = await assign(superAdmin.accessToken, user.userId, { roleKey: 'DRIVER' }).expect(201);
      const change = body(res) as unknown as ChangeBody;
      expect(change).toMatchObject({ userId: user.userId, roleKey: 'DRIVER', organizationId: null });
      expect(change.roles).toEqual(
        expect.arrayContaining([
          { roleKey: 'CUSTOMER', organizationId: null },
          { roleKey: 'DRIVER', organizationId: null },
        ]),
      );

      const row = await ctx.prisma.userRole.findUniqueOrThrow({ where: { id: change.assignmentId } });
      expect(row.userId).toBe(user.userId);
      expect(row.assignedBy).toBe(superAdmin.userId);

      // Module 01 invalidated the target's outstanding tokens so the grant takes effect.
      const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
      expect(after.permVersion).toBeGreaterThan(before.permVersion);
      const stale = await request(ctx.server).get('/users/me').set(...auth(user.accessToken)).expect(401);
      expect(errorOf(stale).code).toBe('TOKEN_EXPIRED');

      const entries = await ctx.prisma.auditLog.findMany({
        where: { resourceId: user.userId, action: { in: ['rbac.user_role.assigned', 'ADMIN_ROLE_ASSIGNED'] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries.map((e) => e.action)).toEqual(['rbac.user_role.assigned', 'ADMIN_ROLE_ASSIGNED']);
      expect(entries[1].actorUserId).toBe(superAdmin.userId);
      expect(entries[1].context).toMatchObject({
        targetUserId: user.userId,
        roleKey: 'DRIVER',
        organizationId: null,
        assignmentId: change.assignmentId,
        rolesBefore: [{ roleKey: 'CUSTOMER', organizationId: null }],
      });
      expect(entries[1].prevHash).toBe(entries[0].hash);
      expect(await ctx.prisma.outbox.count({ where: { eventType: { startsWith: 'admin.' } } })).toBe(0);
    });

    it('applies Module 01 role-scope contract for ORG roles', async () => {
      const user = await plainUser();
      const orgId = await organization(user);

      // ORG role without an organization.
      const missing = await assign(superAdmin.accessToken, user.userId, { roleKey: 'PHARMACY_OWNER' }).expect(400);
      expect(errorOf(missing).code).toBe(ErrorCode.VALIDATION_ERROR);

      // ORG role with an organization that does not exist.
      const unknownOrg = await assign(superAdmin.accessToken, user.userId, {
        roleKey: 'PHARMACY_OWNER',
        organizationId: '00000000-0000-4000-8000-000000000000',
      }).expect(404);
      expect(errorOf(unknownOrg).code).toBe(ErrorCode.NOT_FOUND);

      // PLATFORM role with an organization.
      const extra = await assign(superAdmin.accessToken, user.userId, {
        roleKey: 'CUSTOMER_SUPPORT',
        organizationId: orgId,
      }).expect(400);
      expect(errorOf(extra).code).toBe(ErrorCode.VALIDATION_ERROR);

      // Correct: ORG role with its organization.
      await assign(superAdmin.accessToken, user.userId, { roleKey: 'PHARMACY_OWNER', organizationId: orgId }).expect(201);
      expect(await adminAudits()).toBe(1);
    });

    it('refuses a duplicate as Module 01 does, with no admin audit for the refusal', async () => {
      const user = await plainUser();
      await assign(superAdmin.accessToken, user.userId, { roleKey: 'DRIVER' }).expect(201);

      const dup = await assign(superAdmin.accessToken, user.userId, { roleKey: 'DRIVER' }).expect(409);
      expect(errorOf(dup).code).toBe(ErrorCode.CONFLICT);
      // The default role the account already holds is a duplicate too.
      await assign(superAdmin.accessToken, user.userId, { roleKey: 'CUSTOMER' }).expect(409);

      expect(await ctx.prisma.userRole.count({ where: { userId: user.userId } })).toBe(2);
      expect(await adminAudits()).toBe(1);
    });

    it('refuses an unknown role and an unknown user, with no admin audit', async () => {
      const user = await plainUser();
      const role = await assign(superAdmin.accessToken, user.userId, { roleKey: 'WIZARD' }).expect(404);
      expect(errorOf(role).code).toBe(ErrorCode.NOT_FOUND);
      const who = await assign(superAdmin.accessToken, '00000000-0000-4000-8000-000000000000', { roleKey: 'DRIVER' }).expect(404);
      expect(errorOf(who).code).toBe(ErrorCode.NOT_FOUND);
      expect(await adminAudits()).toBe(0);
    });

    it('rejects a body carrying anything but the role key and organization', async () => {
      const user = await plainUser();
      for (const payload of [
        {},
        { roleKey: '' },
        { roleKey: 'DRIVER', actorUserId: admin.userId },
        { roleKey: 'DRIVER', permissions: ['*'] },
        { roleKey: 'DRIVER', role: { key: 'SUPER_ADMIN' } },
        { roleKey: 'DRIVER', assignedBy: admin.userId },
        { roleKey: 'DRIVER', organizationId: 'not-a-uuid' },
      ]) {
        const res = await assign(superAdmin.accessToken, user.userId, payload).expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }
      expect(await ctx.prisma.userRole.count({ where: { userId: user.userId } })).toBe(1);
    });

    /**
     * Sequential, deliberately. Two concurrent grants — to one account or to two — are not
     * asserted, because the shared hash-chained `AuditService` appends each entry in its own
     * Serializable transaction with no retry (ADR-012's "no fork" guarantee), and two admin
     * mutations landing in the same instant can lose that race with a write conflict through
     * Module 01's own route just as through this one. That is a platform audit property, reported
     * with this work rather than masked by it.
     */
    it('lets several roles be granted to one account, and to several accounts', async () => {
      const one = await plainUser();
      const two = await plainUser();
      await assign(superAdmin.accessToken, one.userId, { roleKey: 'DRIVER' }).expect(201);
      await assign(superAdmin.accessToken, one.userId, { roleKey: 'CUSTOMER_SUPPORT' }).expect(201);
      await assign(superAdmin.accessToken, two.userId, { roleKey: 'FINANCE_OFFICER' }).expect(201);

      const roles = body(await userRoles(admin.accessToken, one.userId).expect(200)) as unknown as AssignmentRow[];
      expect(roles.map((r) => r.roleKey).sort()).toEqual(['CUSTOMER', 'CUSTOMER_SUPPORT', 'DRIVER']);
      expect(await ctx.prisma.userRole.count({ where: { userId: two.userId } })).toBe(2);
      expect(await adminAudits()).toBe(3);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Revoke
  // -------------------------------------------------------------------------------------------

  describe('revoke', () => {
    it('is Module 01 revocation: row gone, permVersion bumped, both audits', async () => {
      const user = await plainUser();
      const granted = body(
        await assign(superAdmin.accessToken, user.userId, { roleKey: 'DRIVER' }).expect(201),
      ) as unknown as ChangeBody;

      const res = await revoke(superAdmin.accessToken, user.userId, granted.assignmentId).expect(200);
      const change = body(res) as unknown as ChangeBody;
      expect(change).toMatchObject({ assignmentId: granted.assignmentId, roleKey: 'DRIVER' });
      expect(change.roles).toEqual([{ roleKey: 'CUSTOMER', organizationId: null }]);

      expect(await ctx.prisma.userRole.findUnique({ where: { id: granted.assignmentId } })).toBeNull();

      const entry = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'ADMIN_ROLE_REVOKED', resourceId: user.userId },
      });
      expect(entry.actorUserId).toBe(superAdmin.userId);
      expect(entry.context).toMatchObject({
        roleKey: 'DRIVER',
        assignmentId: granted.assignmentId,
        rolesAfter: [{ roleKey: 'CUSTOMER', organizationId: null }],
      });
      expect(await ctx.prisma.auditLog.count({ where: { action: 'rbac.user_role.revoked' } })).toBe(1);
    });

    it('refuses an assignment that belongs to another user, and one already gone', async () => {
      const user = await plainUser();
      const other = await plainUser();
      const granted = body(
        await assign(superAdmin.accessToken, user.userId, { roleKey: 'DRIVER' }).expect(201),
      ) as unknown as ChangeBody;

      const wrongUser = await revoke(superAdmin.accessToken, other.userId, granted.assignmentId).expect(404);
      expect(errorOf(wrongUser).code).toBe(ErrorCode.NOT_FOUND);
      expect(await ctx.prisma.userRole.findUnique({ where: { id: granted.assignmentId } })).not.toBeNull();

      await revoke(superAdmin.accessToken, user.userId, granted.assignmentId).expect(200);
      const again = await revoke(superAdmin.accessToken, user.userId, granted.assignmentId).expect(404);
      expect(errorOf(again).code).toBe(ErrorCode.NOT_FOUND);

      expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_ROLE_REVOKED' } })).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Escalation — the repository's actual policy
  // -------------------------------------------------------------------------------------------

  describe('privilege escalation', () => {
    it('an ADMIN cannot grant any role to anyone, including themselves — rbac:manage is the gate', async () => {
      const user = await plainUser();
      for (const [target, roleKey] of [
        [user.userId, 'DRIVER'],
        [user.userId, 'ADMIN'],
        [admin.userId, 'SUPER_ADMIN'],
        [superAdmin.userId, 'CUSTOMER'],
      ]) {
        const res = await assign(admin.accessToken, target, { roleKey }).expect(403);
        expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      }
      expect(await ctx.prisma.userRole.count({ where: { userId: admin.userId } })).toBe(2);
      expect(await adminAudits()).toBe(0);
    });

    it('an ADMIN cannot revoke anything either, not even their own role', async () => {
      const own = await ctx.prisma.userRole.findFirstOrThrow({
        where: { userId: admin.userId, role: { key: 'ADMIN' } },
      });
      const res = await revoke(admin.accessToken, admin.userId, own.id).expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      expect(await ctx.prisma.userRole.findUnique({ where: { id: own.id } })).not.toBeNull();
    });

    /**
     * Not a protection — a documented limitation. Module 01 has no rule refusing the grant of
     * `SUPER_ADMIN` or `ADMIN`; the only gate is `rbac:manage`, which `SUPER_ADMIN` holds through
     * `'*'`. This test pins the actual behaviour so a future Module 01 rule shows up as a change.
     */
    it('a SUPER_ADMIN can grant SUPER_ADMIN and ADMIN — Module 01 refuses neither', async () => {
      const user = await plainUser();
      await assign(superAdmin.accessToken, user.userId, { roleKey: 'ADMIN' }).expect(201);
      await assign(superAdmin.accessToken, user.userId, { roleKey: 'SUPER_ADMIN' }).expect(201);

      // The grant is real: after re-login the account reaches a SUPER_ADMIN-only route.
      const tokens = await login(ctx, user.phone, user.password);
      await request(ctx.server).get('/admin/config').set(...auth(tokens.accessToken)).expect(200);
      expect(await adminAudits()).toBe(2);
    });

    it('a SUPER_ADMIN can revoke their own SUPER_ADMIN role — Module 01 refuses nothing here', async () => {
      const own = await ctx.prisma.userRole.findFirstOrThrow({
        where: { userId: superAdmin.userId, role: { key: 'SUPER_ADMIN' } },
      });
      await revoke(superAdmin.accessToken, superAdmin.userId, own.id).expect(200);

      // Effective immediately: the permVersion bump invalidates the token that did it.
      const next = await listRoles(superAdmin.accessToken).expect(401);
      expect(errorOf(next).code).toBe('TOKEN_EXPIRED');
      expect(await ctx.prisma.userRole.findUnique({ where: { id: own.id } })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Boundaries and security
  // -------------------------------------------------------------------------------------------

  describe('boundaries and security', () => {
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
          'prisma.userRole',
          'prisma.role',
          'prisma.permission',
          'RBAC_REPOSITORY',
          'IRbacRepository',
          'ROLE_ASSIGNMENT_REPOSITORY',
          'identity/application/commands/',
          'identity/application/queries/',
          'identity/infrastructure/',
          'prisma/rbac-catalog',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('leaves Module 01 own role routes answering exactly as before', async () => {
      const user = await plainUser();
      const created = await request(ctx.server)
        .post(`/admin/users/${user.userId}/roles`)
        .set(...auth(superAdmin.accessToken))
        .send({ roleKey: 'DRIVER' })
        .expect(201);
      const assignmentId = body(created).assignmentId as string;
      await request(ctx.server)
        .delete(`/admin/users/${user.userId}/roles/${assignmentId}`)
        .set(...auth(superAdmin.accessToken))
        .expect(204);
      expect(await adminAudits()).toBe(0);
    });

    it.each(['CUSTOMER', 'DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER'])(
      'refuses %s on every route',
      async (role) => {
        const target = await plainUser();
        const caller = await createUserWithRole(ctx, role);
        const own = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: target.userId } });

        for (const res of [
          await listRoles(caller.accessToken),
          await userRoles(caller.accessToken, target.userId),
          await assign(caller.accessToken, target.userId, { roleKey: 'DRIVER' }),
          await revoke(caller.accessToken, target.userId, own.id),
        ]) {
          expect(res.status).toBe(403);
          expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
        }
        expect(await ctx.prisma.userRole.count({ where: { userId: target.userId } })).toBe(1);
      },
    );

    it('refuses an unauthenticated caller', async () => {
      const target = await plainUser();
      await request(ctx.server).get(ROLES).expect(401);
      await request(ctx.server).get(`${ACCOUNTS}/${target.userId}/roles`).expect(401);
      await request(ctx.server).post(`${ACCOUNTS}/${target.userId}/roles`).send({ roleKey: 'DRIVER' }).expect(401);
    });
  });
});
