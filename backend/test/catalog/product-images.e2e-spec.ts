import request from 'supertest';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createPricedProduct, createStockedPharmacy } from '../orders/support';

/**
 * Work 145: products carry images. An admin sets them in order (the first is the main one); the
 * public product page, the catalogue list and search all return them.
 */
describe('Catalog — product images (Work 145, e2e)', () => {
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

  const patch = async (token: string, id: string, images: unknown) =>
    request(ctx.server).patch(`/admin/catalog/products/${id}`).set(...auth(token)).send({ images });

  it('sets images in order, and the product page, the list and search return them', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const productId = await createPricedProduct(ctx, { kind: 'OTC' });
    await createStockedPharmacy(ctx, productId, 5);

    const res = await patch(admin.accessToken, productId, ['/products/ibuprofen-front.jpg', 'https://cdn.example.et/ibuprofen-back.jpg']);
    expect(res.status).toBe(200);
    expect(body(res)).toEqual(
      expect.objectContaining({
        images: ['/products/ibuprofen-front.jpg', 'https://cdn.example.et/ibuprofen-back.jpg'],
        imageUrl: '/products/ibuprofen-front.jpg',
      }),
    );

    const detail = body(await request(ctx.server).get(`/catalog/products/${productId}`).expect(200));
    expect(detail.images).toEqual(['/products/ibuprofen-front.jpg', 'https://cdn.example.et/ibuprofen-back.jpg']);
    expect(detail.imageUrl).toBe('/products/ibuprofen-front.jpg');

    const list = body(await request(ctx.server).get('/catalog/products').expect(200)).items as Array<Record<string, unknown>>;
    expect(list.find((p) => p.id === productId)?.imageUrl).toBe('/products/ibuprofen-front.jpg');

    await ctx.drainOutbox();
    const hits = body(await request(ctx.server).get('/search/medicines?q=ibup').expect(200)).items as Array<Record<string, unknown>>;
    expect(hits.find((h) => h.productId === productId)?.imageUrl).toBe('/products/ibuprofen-front.jpg');
  });

  it('replaces the images, and an empty list removes them', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const productId = await createPricedProduct(ctx, { kind: 'OTC' });

    await patch(admin.accessToken, productId, ['/products/a.jpg', '/products/b.jpg']).then((r) => expect(r.status).toBe(200));
    const replaced = body(await patch(admin.accessToken, productId, ['/products/b.jpg']));
    expect(replaced.images).toEqual(['/products/b.jpg']);
    expect(await ctx.prisma.productImage.count({ where: { productId } })).toBe(1);

    const cleared = body(await patch(admin.accessToken, productId, []));
    expect(cleared).toEqual(expect.objectContaining({ images: [], imageUrl: null }));
    const listed = body(await request(ctx.server).get('/catalog/products').expect(200)).items as Array<Record<string, unknown>>;
    expect(listed.find((p) => p.id === productId)?.imageUrl).toBeNull();
  });

  it('refuses an image that is not an https URL or a site path, and writes nothing', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const productId = await createPricedProduct(ctx, { kind: 'OTC' });
    for (const bad of ['http://plain.example/x.jpg', '//evil.example/x.jpg', 'javascript:alert(1)', '/a b.jpg', 'x.jpg']) {
      const res = await patch(admin.accessToken, productId, [bad]);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    const tooMany = await patch(admin.accessToken, productId, Array.from({ length: 9 }, (_, i) => `/products/${i}.jpg`));
    expect(tooMany.status).toBe(400);
    expect(await ctx.prisma.productImage.count({ where: { productId } })).toBe(0);
  });

  it('only a catalogue manager can set images', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const productId = await createPricedProduct(ctx, { kind: 'OTC' });
    expect((await patch(customer.accessToken, productId, ['/products/a.jpg'])).status).toBe(403);
  });
});
