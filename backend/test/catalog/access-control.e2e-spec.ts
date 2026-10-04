import request from 'supertest';
import { auth, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

describe('Catalog — access control (e2e)', () => {
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

  it('unauthenticated GET /catalog/products and /catalog/categories both succeed with no token', async () => {
    await request(ctx.server).get('/catalog/products').expect(200);
    await request(ctx.server).get('/catalog/categories').expect(200);
  });

  it('unauthenticated request to any /admin/catalog/* route is 401 UNAUTHENTICATED', async () => {
    const res = await request(ctx.server).post('/admin/catalog/products').send({ type: 'HEALTH_PRODUCT' });
    expect(res.status).toBe(401);
  });

  it('an authenticated CUSTOMER (no catalog:manage:any) gets 403 on admin writes', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(customer.accessToken))
      .send({ type: 'HEALTH_PRODUCT', brandName: 'Vitamin C', nameEn: 'Vitamin C' });
    expect(res.status).toBe(403);
  });

  it('an ADMIN (catalog:manage:any) can create a product', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({ type: 'HEALTH_PRODUCT', brandName: 'Vitamin C', nameEn: 'Vitamin C' })
      .expect(201);
  });

  it('the existing catalog:manage:org permission is untouched (not granted any-scope capability)', async () => {
    // PHARMACY_OWNER holds catalog:manage:org (the deferred Slice 3 key), not catalog:manage:any
    // (§7.1) — it must not satisfy Slice 1's admin-only product master writes.
    const owner = await createUserWithRole(ctx, 'PHARMACY_OWNER');
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(owner.accessToken))
      .send({ type: 'HEALTH_PRODUCT', brandName: 'Vitamin C', nameEn: 'Vitamin C' });
    expect(res.status).toBe(403);
  });
});
