import request from 'supertest';
import {
  auth,
  body,
  createUserWithRole,
  errorOf,
  login,
  registerAndVerify,
} from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Scenarios 5-6: assigning a role grants a permission-gated endpoint; removing the grant (either
 * from the role's catalog or the user's assignment) rejects the same request afterwards.
 */
describe('RBAC role and permission enforcement (e2e)', () => {
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

  it('grants access to a permission-gated endpoint once ADMIN is assigned', async () => {
    const target = await registerAndVerify(ctx);

    // rbac:read is required by GET /admin/rbac/roles; a fresh CUSTOMER cannot reach it.
    const before = await login(ctx, target.phone, target.password);
    const denied = await request(ctx.server)
      .get('/admin/rbac/roles')
      .set(...auth(before.accessToken))
      .expect(403);
    expect(errorOf(denied).code).toBe('FORBIDDEN');

    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    const assign = await request(ctx.server)
      .post(`/admin/users/${target.userId}/roles`)
      .set(...auth(superAdmin.accessToken))
      .send({ roleKey: 'ADMIN' })
      .expect(201);
    expect(body(assign)).toMatchObject({ userId: target.userId, roleKey: 'ADMIN' });

    // The permission set is embedded in the access token, so a new login is required to see it.
    const after = await login(ctx, target.phone, target.password);
    const roles = await request(ctx.server)
      .get('/admin/rbac/roles')
      .set(...auth(after.accessToken))
      .expect(200);
    expect((body(roles) as unknown as unknown[]).length).toBeGreaterThan(0);
  });

  it('rejects a stale token immediately after a role is revoked (permVersion enforcement)', async () => {
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    const target = await createUserWithRole(ctx, 'ADMIN');

    // Confirm access before revocation.
    await request(ctx.server)
      .get('/admin/rbac/roles')
      .set(...auth(target.accessToken))
      .expect(200);

    const assignments = body(
      await request(ctx.server)
        .get(`/admin/users/${target.userId}/roles`)
        .set(...auth(superAdmin.accessToken))
        .expect(200),
    ) as unknown as Array<{ assignmentId: string; roleKey: string }>;
    const adminAssignment = assignments.find((a) => a.roleKey === 'ADMIN');
    expect(adminAssignment).toBeDefined();

    await request(ctx.server)
      .delete(`/admin/users/${target.userId}/roles/${adminAssignment!.assignmentId}`)
      .set(...auth(superAdmin.accessToken))
      .expect(204);

    // The old access token still parses, but its permVersion no longer matches — the guard
    // must reject it rather than let a revoked grant coast to the end of its 15-minute TTL.
    const staleAttempt = await request(ctx.server)
      .get('/admin/rbac/roles')
      .set(...auth(target.accessToken))
      .expect(401);
    expect(errorOf(staleAttempt).code).toBe('TOKEN_EXPIRED');

    // And a fresh token confirms the permission is genuinely gone, not just the old token stale.
    const fresh = await login(ctx, target.phone, target.password);
    const freshAttempt = await request(ctx.server)
      .get('/admin/rbac/roles')
      .set(...auth(fresh.accessToken))
      .expect(403);
    expect(errorOf(freshAttempt).code).toBe('FORBIDDEN');
  });

  it('rejects previously authorized access after the permission is removed from the role', async () => {
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    const admin = await createUserWithRole(ctx, 'ADMIN');

    await request(ctx.server)
      .get('/admin/rbac/roles')
      .set(...auth(admin.accessToken))
      .expect(200);

    const roles = body(
      await request(ctx.server)
        .get('/admin/rbac/roles')
        .set(...auth(superAdmin.accessToken))
        .expect(200),
    ) as unknown as Array<{ id: string; key: string; permissions: string[] }>;
    const adminRole = roles.find((r) => r.key === 'ADMIN')!;
    const remaining = adminRole.permissions.filter((p) => p !== 'rbac:read');
    expect(remaining.length).toBeLessThan(adminRole.permissions.length);

    await request(ctx.server)
      .post(`/admin/rbac/roles/${adminRole.id}/permissions`)
      .set(...auth(superAdmin.accessToken))
      .send({ permissions: remaining })
      .expect(201);

    const staleAttempt = await request(ctx.server)
      .get('/admin/rbac/roles')
      .set(...auth(admin.accessToken))
      .expect(401);
    expect(errorOf(staleAttempt).code).toBe('TOKEN_EXPIRED');

    const fresh = await login(ctx, admin.phone, admin.password);
    const freshAttempt = await request(ctx.server)
      .get('/admin/rbac/roles')
      .set(...auth(fresh.accessToken))
      .expect(403);
    expect(errorOf(freshAttempt).code).toBe('FORBIDDEN');
  });

  it('enforces the ORG-scope contract when assigning a role', async () => {
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    const target = await registerAndVerify(ctx);

    const missingOrg = await request(ctx.server)
      .post(`/admin/users/${target.userId}/roles`)
      .set(...auth(superAdmin.accessToken))
      .send({ roleKey: 'PHARMACIST' })
      .expect(400);
    expect(errorOf(missingOrg).code).toBe('VALIDATION_ERROR');
  });

  it('refuses to edit the SUPER_ADMIN role', async () => {
    const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
    const roles = body(
      await request(ctx.server)
        .get('/admin/rbac/roles')
        .set(...auth(superAdmin.accessToken))
        .expect(200),
    ) as unknown as Array<{ id: string; key: string }>;
    const superAdminRole = roles.find((r) => r.key === 'SUPER_ADMIN')!;

    const res = await request(ctx.server)
      .post(`/admin/rbac/roles/${superAdminRole.id}/permissions`)
      .set(...auth(superAdmin.accessToken))
      .send({ permissions: [] })
      .expect(422);
    expect(errorOf(res).code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('bootstraps: a plain CUSTOMER cannot self-grant any admin role', async () => {
    const target = await registerAndVerify(ctx);
    const tokens = await login(ctx, target.phone, target.password);

    const res = await request(ctx.server)
      .post(`/admin/users/${target.userId}/roles`)
      .set(...auth(tokens.accessToken))
      .send({ roleKey: 'SUPER_ADMIN' })
      .expect(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });
});
