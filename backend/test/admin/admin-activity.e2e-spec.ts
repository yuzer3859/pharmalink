import request from 'supertest';
import { AuditService } from '../../src/shared/audit/audit.service';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const BASE = '/admin/admins/activity';

interface Report {
  from: string;
  to: string;
  truncated: boolean;
  staff: Array<{
    userId: string;
    roles: string[];
    total: number;
    byAction: Array<{ action: string; count: number }>;
    flags: Array<{ rule: string; count: number; exampleIds: string[] }>;
  }>;
}

/**
 * Work 88 against real PostgreSQL and the real HTTP stack: staff from Module 01's role
 * assignments, their entries from the hash-chained audit trail, the rules on top
 * (backend/docs/admin-activity.md).
 */
describe('Admin activity monitoring (e2e)', () => {
  let ctx: TestContext;
  let audit: AuditService;
  let superAdmin: Awaited<ReturnType<typeof createUserWithRole>>;
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;

  beforeAll(async () => {
    ctx = await createTestApp();
    audit = ctx.app.get(AuditService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  const report = async (query: Record<string, string> = {}) =>
    body(await request(ctx.server).get(BASE).query(query).set(...auth(superAdmin.accessToken)).expect(200)) as unknown as Report;
  const row = (r: Report, userId: string) => r.staff.find((s) => s.userId === userId);

  it('lists holders of platform roles, never plain customers, with their audited actions', async () => {
    const finance = await createUserWithRole(ctx, 'FINANCE_OFFICER');
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await audit.record({ actorUserId: admin.userId, action: 'CONFIG_CHANGED', resourceType: 'PlatformConfig', resourceId: 'orders.x', context: { secret: 'context-is-never-served' } });
    await audit.record({ actorUserId: admin.userId, action: 'CONFIG_CHANGED', resourceType: 'PlatformConfig', resourceId: 'orders.y' });
    await audit.record({ actorUserId: customer.userId, action: 'ORDER_PLACED', resourceType: 'Order', resourceId: 'o1' });

    const res = await request(ctx.server).get(BASE).set(...auth(superAdmin.accessToken)).expect(200);
    const r = body(res) as unknown as Report;
    expect(row(r, admin.userId)).toMatchObject({ roles: ['ADMIN'], byAction: expect.arrayContaining([{ action: 'CONFIG_CHANGED', count: 2 }]) });
    expect(row(r, finance.userId)?.roles).toEqual(['FINANCE_OFFICER']);
    expect(row(r, superAdmin.userId)?.roles).toEqual(['SUPER_ADMIN']);
    expect(row(r, customer.userId)).toBeUndefined();
    expect(r.truncated).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('context-is-never-served');
  });

  it('flags ten sensitive actions in a day and a sensitive action on one’s own account', async () => {
    for (let i = 0; i < 10; i++) {
      await audit.record({ actorUserId: admin.userId, action: 'identity.account.suspended', resourceType: 'user', resourceId: `00000000-0000-4000-8000-00000000000${i}` });
    }
    await audit.record({ actorUserId: admin.userId, action: 'rbac.user_role.assigned', resourceType: 'user', resourceId: admin.userId });

    const flags = row(await report(), admin.userId)!.flags;
    const rules = flags.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['SENSITIVE_VOLUME', 'SELF_TARGETED']));
    const volume = flags.find((f) => f.rule === 'SENSITIVE_VOLUME')!;
    expect(volume.count).toBe(11);
    // The examples are real audit entries.
    const examples = await ctx.prisma.auditLog.findMany({ where: { id: { in: volume.exampleIds } } });
    expect(examples).toHaveLength(5);
    expect(examples.every((e) => e.actorUserId === admin.userId)).toBe(true);
  });

  it('puts flagged staff first', async () => {
    await audit.record({ actorUserId: admin.userId, action: 'rbac.user_role.revoked', resourceType: 'user', resourceId: admin.userId });
    expect((await report()).staff[0].userId).toBe(admin.userId);
  });

  it('audits every read', async () => {
    await report();
    await request(ctx.server).get(`${BASE}/${admin.userId}`).set(...auth(superAdmin.accessToken)).expect(200);
    const reads = await ctx.prisma.auditLog.findMany({ where: { action: 'ADMIN_ACTIVITY_VIEWED' }, orderBy: { createdAt: 'asc' } });
    expect(reads.map((r) => [r.actorUserId, r.resourceId])).toEqual([[superAdmin.userId, null], [superAdmin.userId, admin.userId]]);
  });

  it('pages one staff member’s entries, newest first, and 404s anyone else', async () => {
    await audit.record({ actorUserId: admin.userId, action: 'FIRST', resourceType: 'X' });
    await audit.record({ actorUserId: admin.userId, action: 'SECOND', resourceType: 'X' });
    const page = body(await request(ctx.server).get(`${BASE}/${admin.userId}`).query({ size: '1' }).set(...auth(superAdmin.accessToken)).expect(200)) as {
      items: Array<{ action: string }>;
      total: number;
    };
    expect(page.items.map((i) => i.action)).toEqual(['SECOND']);
    expect(page.total).toBeGreaterThanOrEqual(2);

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const res = await request(ctx.server).get(`${BASE}/${customer.userId}`).set(...auth(superAdmin.accessToken)).expect(404);
    expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
    await request(ctx.server).get(`${BASE}/not-a-uuid`).set(...auth(superAdmin.accessToken)).expect(400);
  });

  it.each([
    ['a window over 31 days', { from: '2026-01-01T00:00:00Z', to: '2026-02-15T00:00:00Z' }],
    ['from after to', { from: '2026-02-02T00:00:00Z', to: '2026-02-01T00:00:00Z' }],
    ['a malformed time', { from: 'yesterday' }],
    ['an unknown field', { actor: 'x' }],
  ])('refuses %s with 400', async (_label, query) => {
    const res = await request(ctx.server).get(BASE).query(query).set(...auth(superAdmin.accessToken)).expect(400);
    expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it.each(['ADMIN', 'FINANCE_OFFICER', 'CUSTOMER_SUPPORT', 'CUSTOMER'] as const)('refuses %s', async (role) => {
    const caller = role === 'ADMIN' ? admin : await createUserWithRole(ctx, role);
    await request(ctx.server).get(BASE).set(...auth(caller.accessToken)).expect(403);
    await request(ctx.server).get(`${BASE}/${superAdmin.userId}`).set(...auth(caller.accessToken)).expect(403);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ADMIN_ACTIVITY_VIEWED' } })).toBe(0);
  });

  it('refuses an unauthenticated caller', async () => {
    await request(ctx.server).get(BASE).expect(401);
  });
});
