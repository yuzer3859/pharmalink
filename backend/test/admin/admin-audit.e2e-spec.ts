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

const AUDIT = '/admin/audit';

interface EntryRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  context: unknown;
  ip: string | null;
  createdAt: string;
  chain: { prevHash: string | null; hash: string; hashValid?: boolean };
}

interface ListBody {
  items: EntryRow[];
  total: number;
  page: number;
  size: number;
}

const FAYDA_ID = '123456789012';

/**
 * Module 16 Work 05 against real PostgreSQL and the real HTTP stack.
 *
 * What can only be shown here: that the entries Works 01–04 write are the entries the explorer
 * returns, in a stable order, with their chain metadata exactly as stored; that reading writes
 * nothing; that a row altered after the fact is reported as such; and that there is no verb on
 * this surface but `GET`.
 */
describe('Admin audit explorer (e2e)', () => {
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

  const list = (token: string, query: Record<string, string | number> = {}) =>
    request(ctx.server).get(AUDIT).set(...auth(token)).query(query);
  const detail = (token: string, id: string) =>
    request(ctx.server).get(`${AUDIT}/${id}`).set(...auth(token));

  /** One admin action from each of Works 01–04, so the trail holds every Module 16 entry kind. */
  async function seedAdminActivity(): Promise<{ user: RegisteredUser & Tokens; requestId: string }> {
    const registered = await registerAndVerify(ctx);
    const user = { ...registered, ...(await login(ctx, registered.phone, registered.password)) };

    // Work 01 — CONFIG_CHANGED
    await request(ctx.server)
      .put('/admin/config/delivery/offerTtlSeconds')
      .set(...auth(superAdmin.accessToken))
      .send({ valueType: 'INTEGER', value: 45, reason: 'tuning' })
      .expect(200);

    // Work 02 — ADMIN_VERIFICATION_APPROVED (on a Fayda request, so the trail has one nearby)
    const submitted = await request(ctx.server)
      .post('/verification/fayda')
      .set(...auth(user.accessToken))
      .send({ faydaId: FAYDA_ID, consentGranted: true })
      .expect(202);
    const requestId = body(submitted).requestId as string;
    await request(ctx.server)
      .post(`/admin/verifications/${requestId}/approve`)
      .set(...auth(admin.accessToken))
      .send({ reason: 'Registry match' })
      .expect(200);

    // Work 04 — ADMIN_ROLE_ASSIGNED
    await request(ctx.server)
      .post(`/admin/accounts/${user.userId}/roles`)
      .set(...auth(superAdmin.accessToken))
      .send({ roleKey: 'DRIVER' })
      .expect(201);

    // Work 03 — ADMIN_USER_SUSPENDED
    await request(ctx.server)
      .post(`/admin/accounts/${user.userId}/suspend`)
      .set(...auth(admin.accessToken))
      .send({ reason: 'Fraud investigation' })
      .expect(200);

    return { user, requestId };
  }

  // -------------------------------------------------------------------------------------------
  // 1. List
  // -------------------------------------------------------------------------------------------

  describe('list', () => {
    it('shows the entries Works 01–04 wrote, newest first, with chain metadata as stored', async () => {
      await seedAdminActivity();

      const page = body(await list(admin.accessToken, { size: 100 }).expect(200)) as unknown as ListBody;
      const stored = await ctx.prisma.auditLog.count();
      expect(page.total).toBe(stored);

      const actions = page.items.map((i) => i.action);
      for (const expected of [
        'CONFIG_CHANGED',
        'identity.verification.approved',
        'ADMIN_VERIFICATION_APPROVED',
        'rbac.user_role.assigned',
        'ADMIN_ROLE_ASSIGNED',
        'identity.account.suspended',
        'ADMIN_USER_SUSPENDED',
      ]) {
        expect(actions).toContain(expected);
      }

      // Newest first, and the chain runs the other way: each entry's prevHash is the hash of the
      // one after it in this listing.
      for (let i = 0; i < page.items.length - 1; i += 1) {
        expect(page.items[i].createdAt >= page.items[i + 1].createdAt).toBe(true);
        expect(page.items[i].chain.prevHash).toBe(page.items[i + 1].chain.hash);
      }
      expect(page.items[page.items.length - 1].chain.prevHash).toBeNull();

      // Exactly what the table holds — no recomputation, no rewriting.
      const rows = await ctx.prisma.auditLog.findMany();
      for (const item of page.items) {
        const row = rows.find((r) => r.id === item.id)!;
        expect(item.chain).toEqual({ prevHash: row.prevHash, hash: row.hash });
        expect(item.createdAt).toBe(row.createdAt.toISOString());
      }
    });

    it('filters by action, actor, resource type and resource id', async () => {
      const { user, requestId } = await seedAdminActivity();

      const byAction = body(
        await list(admin.accessToken, { action: 'ADMIN_USER_SUSPENDED' }).expect(200),
      ) as unknown as ListBody;
      expect(byAction.total).toBe(1);
      expect(byAction.items[0]).toMatchObject({
        action: 'ADMIN_USER_SUSPENDED',
        actorUserId: admin.userId,
        resourceType: 'user',
        resourceId: user.userId,
      });

      const byActor = body(
        await list(admin.accessToken, { actorUserId: superAdmin.userId }).expect(200),
      ) as unknown as ListBody;
      expect(byActor.items.every((i) => i.actorUserId === superAdmin.userId)).toBe(true);
      expect(byActor.items.map((i) => i.action)).toEqual(
        expect.arrayContaining(['CONFIG_CHANGED', 'ADMIN_ROLE_ASSIGNED', 'rbac.user_role.assigned']),
      );

      const byResource = body(
        await list(admin.accessToken, {
          resourceType: 'verification_request',
          resourceId: requestId,
        }).expect(200),
      ) as unknown as ListBody;
      expect(byResource.items.map((i) => i.action).sort()).toEqual(
        ['ADMIN_VERIFICATION_APPROVED', 'identity.verification.approved', 'identity.verification.submitted'].sort(),
      );

      const config = body(
        await list(admin.accessToken, { resourceType: 'PlatformConfig' }).expect(200),
      ) as unknown as ListBody;
      expect(config.items.map((i) => i.action)).toEqual(['CONFIG_CHANGED']);
    });

    it('applies the time window as [from, to)', async () => {
      await seedAdminActivity();
      const all = body(await list(admin.accessToken, { size: 100 }).expect(200)) as unknown as ListBody;
      const pivot = all.items[Math.floor(all.items.length / 2)];

      const fromPivot = body(
        await list(admin.accessToken, { from: pivot.createdAt, size: 100 }).expect(200),
      ) as unknown as ListBody;
      expect(fromPivot.items.map((i) => i.id)).toContain(pivot.id);
      expect(fromPivot.items.every((i) => i.createdAt >= pivot.createdAt)).toBe(true);

      const toPivot = body(
        await list(admin.accessToken, { to: pivot.createdAt, size: 100 }).expect(200),
      ) as unknown as ListBody;
      expect(toPivot.items.map((i) => i.id)).not.toContain(pivot.id);
      expect(toPivot.items.every((i) => i.createdAt < pivot.createdAt)).toBe(true);

      expect(fromPivot.total + toPivot.total).toBe(all.total);
    });

    it('pages deterministically without overlap', async () => {
      await seedAdminActivity();
      const all = body(await list(admin.accessToken, { size: 100 }).expect(200)) as unknown as ListBody;
      expect(all.total).toBeGreaterThan(4);

      const pages: string[][] = [];
      for (let p = 1; p <= Math.ceil(all.total / 3); p += 1) {
        const page = body(await list(admin.accessToken, { page: p, size: 3 }).expect(200)) as unknown as ListBody;
        expect(page).toMatchObject({ page: p, size: 3, total: all.total });
        pages.push(page.items.map((i) => i.id));
      }
      const flat = pages.flat();
      expect(new Set(flat).size).toBe(all.total);
      expect(flat).toEqual(all.items.map((i) => i.id));

      const again = body(await list(admin.accessToken, { page: 1, size: 3 }).expect(200)) as unknown as ListBody;
      expect(again.items.map((i) => i.id)).toEqual(pages[0]);
    });

    it('refuses malformed filters', async () => {
      const invalid: Array<Record<string, string | number>> = [
        { actorUserId: 'not-a-uuid' },
        { from: 'yesterday' },
        { size: 101 },
        { page: 0 },
        { action: 'x'.repeat(129) },
        { context: '{"$gt":1}' },
      ];
      for (const query of invalid) {
        const res = await list(admin.accessToken, query).expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });

    it('carries no secret, document reference or Fayda number', async () => {
      await seedAdminActivity();
      const res = await list(admin.accessToken, { size: 100 }).expect(200);
      const raw = JSON.stringify(res.body);
      for (const forbidden of [FAYDA_ID, 'passwordHash', 'storageRef', 'refreshToken', 'accessToken', 'faydaIdEncrypted']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Detail
  // -------------------------------------------------------------------------------------------

  describe('detail', () => {
    it('returns the stored entry with its own-link integrity', async () => {
      const { user } = await seedAdminActivity();
      const row = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'ADMIN_USER_SUSPENDED' } });

      const view = body(await detail(admin.accessToken, row.id).expect(200)) as unknown as EntryRow;
      expect(view).toEqual({
        id: row.id,
        action: 'ADMIN_USER_SUSPENDED',
        resourceType: 'user',
        resourceId: user.userId,
        actorUserId: admin.userId,
        context: row.context,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
        chain: { prevHash: row.prevHash, hash: row.hash, hashValid: true },
      });
      expect((view.context as Record<string, unknown>).reason).toBe('Fraud investigation');
    });

    it('reports a row altered after writing as hashValid=false, without touching it', async () => {
      await seedAdminActivity();
      const row = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'CONFIG_CHANGED' } });
      // Test-only tampering, the thing the chain exists to detect.
      await ctx.prisma.auditLog.update({
        where: { id: row.id },
        data: { context: { ...(row.context as object), reason: 'rewritten' } },
      });

      const view = body(await detail(admin.accessToken, row.id).expect(200)) as unknown as EntryRow;
      expect(view.chain.hashValid).toBe(false);
      expect(view.chain.hash).toBe(row.hash);

      const after = await ctx.prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.hash).toBe(row.hash);
      expect(after.prevHash).toBe(row.prevHash);
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      const unknown = await detail(admin.accessToken, '00000000-0000-4000-8000-000000000000').expect(404);
      expect(errorOf(unknown).code).toBe(ErrorCode.NOT_FOUND);
      const malformed = await detail(admin.accessToken, 'not-an-id').expect(400);
      expect(errorOf(malformed).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Read-only
  // -------------------------------------------------------------------------------------------

  describe('read-only', () => {
    it('reading the trail appends nothing to it', async () => {
      await seedAdminActivity();
      const before = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });

      const page = body(await list(admin.accessToken, { size: 100 }).expect(200)) as unknown as ListBody;
      await detail(admin.accessToken, page.items[0].id).expect(200);
      await list(superAdmin.accessToken, { action: 'CONFIG_CHANGED' }).expect(200);

      const after = await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
      expect(after).toEqual(before);
    });

    it('has no verb but GET', async () => {
      await seedAdminActivity();
      const row = await ctx.prisma.auditLog.findFirstOrThrow();
      const token = superAdmin.accessToken;

      await request(ctx.server).post(AUDIT).set(...auth(token)).send({ action: 'X' }).expect(404);
      await request(ctx.server).put(`${AUDIT}/${row.id}`).set(...auth(token)).send({ action: 'X' }).expect(404);
      await request(ctx.server).patch(`${AUDIT}/${row.id}`).set(...auth(token)).send({ action: 'X' }).expect(404);
      await request(ctx.server).delete(`${AUDIT}/${row.id}`).set(...auth(token)).expect(404);

      const still = await ctx.prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect(still.hash).toBe(row.hash);
    });

    it('Module 16 reads the trail only through the shared read port', () => {
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
        for (const forbidden of ['prisma.auditLog', 'prisma-audit-read', 'PrismaAuditReadAdapter', 'auditLog.']) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Security
  // -------------------------------------------------------------------------------------------

  describe('security', () => {
    it.each(['CUSTOMER', 'DRIVER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER'])(
      'refuses %s',
      async (role) => {
        await seedAdminActivity();
        const row = await ctx.prisma.auditLog.findFirstOrThrow();
        const caller = await createUserWithRole(ctx, role);

        for (const res of [await list(caller.accessToken), await detail(caller.accessToken, row.id)]) {
          expect(res.status).toBe(403);
          expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
        }
      },
    );

    it('refuses an unauthenticated caller', async () => {
      await request(ctx.server).get(AUDIT).expect(401);
      await request(ctx.server).get(`${AUDIT}/00000000-0000-4000-8000-000000000000`).expect(401);
    });

    it('admits ADMIN and SUPER_ADMIN, the holders of audit:read:any', async () => {
      await seedAdminActivity();
      const row = await ctx.prisma.auditLog.findFirstOrThrow();
      await list(admin.accessToken).expect(200);
      await list(superAdmin.accessToken).expect(200);
      await detail(superAdmin.accessToken, row.id).expect(200);
    });
  });
});
