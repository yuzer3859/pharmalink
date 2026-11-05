import request from 'supertest';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 81: what the finance portal can reach, proven against the real HTTP stack with a real
 * FINANCE_OFFICER token (the RBAC seed's grants, no administrator MFA). Every finance read the
 * portal makes is allowed; every other admin read the admin portals make is refused, so the
 * portal's "finance and nothing else" is the server's rule too, not only its navigation.
 */
describe('Finance Officer access (e2e)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
    token = (await createUserWithRole(ctx, 'FINANCE_OFFICER')).accessToken;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const get = (path: string) => request(ctx.server).get(path).set(...auth(token));

  it('identifies as a Finance Officer with the finance grants the portal maps', async () => {
    const me = body(await get('/users/me').expect(200));
    const roles = (me.roles as Array<{ roleKey: string }>).map((r) => r.roleKey);
    expect(roles).toContain('FINANCE_OFFICER');
    expect(me.permissions).toEqual(expect.arrayContaining(['finance:report:any', 'finance:settlement:any']));
    expect(me.permissions).not.toEqual(expect.arrayContaining(['analytics:read']));
  });

  it.each([
    '/admin/finance/overview',
    '/admin/finance/payments?page=1&size=20',
    '/admin/finance/refunds?page=1&size=20',
    '/admin/finance/settlements?page=1&size=20',
    '/admin/cod-disputes?page=1&size=20',
  ])('may read %s', async (path) => {
    await get(path).expect(200);
  });

  it.each([
    '/admin/analytics/overview',
    '/admin/audit?page=1&size=20',
    '/admin/accounts?page=1&size=20',
    '/admin/roles',
    '/admin/operations/pharmacies?page=1&size=20',
    '/admin/operations/orders?page=1&size=20',
    '/admin/operations/inventory/listings?page=1&size=20',
    '/admin/verifications?page=1&size=20',
    '/admin/catalog/review?page=1&size=20',
    '/admin/config',
    '/admin/feature-flags',
  ])('is refused %s', async (path) => {
    const res = await get(path).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
