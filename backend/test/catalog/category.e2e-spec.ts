import request from 'supertest';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

describe('Catalog — Category tree, cycle guard and disable (e2e)', () => {
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

  async function admin() {
    return createUserWithRole(ctx, 'ADMIN');
  }

  it('creates a 3-level category tree and returns it correctly nested', async () => {
    const a = await admin();
    const root = body(
      await request(ctx.server)
        .post('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .send({ slug: 'medicines', nameEn: 'Medicines' })
        .expect(201),
    );
    const child = body(
      await request(ctx.server)
        .post('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .send({ slug: 'antibiotics', nameEn: 'Antibiotics', parentId: root.id })
        .expect(201),
    );
    await request(ctx.server)
      .post('/admin/catalog/categories')
      .set(...auth(a.accessToken))
      .send({ slug: 'penicillins', nameEn: 'Penicillins', parentId: child.id })
      .expect(201);

    const tree = body(await request(ctx.server).get('/catalog/categories').expect(200)) as unknown as {
      id: string;
      children: Array<{ id: string; children: Array<{ id: string }> }>;
    }[];
    const rootNode = tree.find((n) => n.id === root.id);
    expect(rootNode).toBeDefined();
    expect(rootNode!.children[0].id).toBe(child.id);
    expect(rootNode!.children[0].children[0]).toBeDefined();
  });

  it('rejects a parentId that would create a cycle', async () => {
    const a = await admin();
    const parent = body(
      await request(ctx.server)
        .post('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .send({ slug: 'parent-cat', nameEn: 'Parent' })
        .expect(201),
    );
    const child = body(
      await request(ctx.server)
        .post('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .send({ slug: 'child-cat', nameEn: 'Child', parentId: parent.id })
        .expect(201),
    );

    const cyclic = await request(ctx.server)
      .patch(`/admin/catalog/categories/${parent.id}`)
      .set(...auth(a.accessToken))
      .send({ parentId: child.id });
    expect(cyclic.status).toBe(422);
    expect(errorOf(cyclic).code).toBe('CATEGORY_CYCLE_DETECTED');
  });

  it('rejects disabling a category with an active product still assigned (409 CATEGORY_HAS_PRODUCTS)', async () => {
    const a = await admin();
    const category = body(
      await request(ctx.server)
        .post('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .send({ slug: 'vitamins', nameEn: 'Vitamins' })
        .expect(201),
    );
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(a.accessToken))
        .send({
          type: 'HEALTH_PRODUCT',
          brandName: 'Vitamin C',
          nameEn: 'Vitamin C',
          categoryIds: [category.id],
        })
        .expect(201),
    );
    await request(ctx.server)
      .post(`/admin/catalog/products/${product.id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);

    const blocked = await request(ctx.server)
      .delete(`/admin/catalog/categories/${category.id}`)
      .set(...auth(a.accessToken));
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked).code).toBe('CATEGORY_HAS_PRODUCTS');
  });

  it('disables a category with no active products (soft-disable, not hard delete)', async () => {
    const a = await admin();
    const category = body(
      await request(ctx.server)
        .post('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .send({ slug: 'empty-cat', nameEn: 'Empty' })
        .expect(201),
    );

    await request(ctx.server)
      .delete(`/admin/catalog/categories/${category.id}`)
      .set(...auth(a.accessToken))
      .expect(204);

    const adminList = body(
      await request(ctx.server)
        .get('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .expect(200),
    ) as unknown as Array<{ id: string; isActive: boolean }>;
    const found = adminList.find((c) => c.id === category.id);
    expect(found?.isActive).toBe(false);

    const publicTree = body(await request(ctx.server).get('/catalog/categories').expect(200)) as unknown as Array<{
      id: string;
    }>;
    expect(publicTree.some((c) => c.id === category.id)).toBe(false);
  });

  it('a product assigned to 2 categories appears under both via GET /categories/:id/products', async () => {
    const a = await admin();
    const catA = body(
      await request(ctx.server)
        .post('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .send({ slug: 'cat-a', nameEn: 'Cat A' })
        .expect(201),
    );
    const catB = body(
      await request(ctx.server)
        .post('/admin/catalog/categories')
        .set(...auth(a.accessToken))
        .send({ slug: 'cat-b', nameEn: 'Cat B' })
        .expect(201),
    );
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(a.accessToken))
        .send({
          type: 'HEALTH_PRODUCT',
          brandName: 'Multivitamin',
          nameEn: 'Multivitamin',
          categoryIds: [catA.id, catB.id],
        })
        .expect(201),
    );
    await request(ctx.server)
      .post(`/admin/catalog/products/${product.id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);

    const inA = body(await request(ctx.server).get(`/catalog/categories/${catA.id}/products`).expect(200)) as {
      items: Array<{ id: string }>;
    };
    const inB = body(await request(ctx.server).get(`/catalog/categories/${catB.id}/products`).expect(200)) as {
      items: Array<{ id: string }>;
    };
    expect(inA.items.some((i) => i.id === product.id)).toBe(true);
    expect(inB.items.some((i) => i.id === product.id)).toBe(true);
  });
});
