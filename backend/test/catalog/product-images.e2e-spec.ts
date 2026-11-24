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

  // ---- Work 150: pictures uploaded by catalogue staff -------------------------------------
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex');
  const pathOf = (url: string) => new URL(url, 'http://local').pathname;
  const askUpload = (token: string, id: string, body: Record<string, unknown>) =>
    request(ctx.server).post(`/admin/catalog/products/${id}/images/uploads`).set(...auth(token)).send(body);

  async function uploaded(token: string, productId: string) {
    const issued = body(await askUpload(token, productId, { contentType: 'image/png', bytes: PNG.length }).expect(201)) as { imageUrl: string; upload: { url: string } };
    await request(ctx.server).put(pathOf(issued.upload.url)).set('Content-Type', 'image/png').send(PNG).expect(200);
    return issued.imageUrl as string;
  }

  it('uploads a picture, saves it, and serves it publicly through a short-lived redirect (Work 150)', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const productId = await createPricedProduct(ctx, { kind: 'OTC' });
    const imageUrl = await uploaded(admin.accessToken, productId);
    expect(imageUrl).toMatch(new RegExp(`^/media/catalog/${productId}/[0-9a-f-]{36}$`));

    const saved = body(await patch(admin.accessToken, productId, [imageUrl, '/products/ibuprofen-front.jpg']));
    expect(saved).toEqual(expect.objectContaining({ images: [imageUrl, '/products/ibuprofen-front.jpg'], imageUrl }));

    const served = await request(ctx.server).get(imageUrl).expect(302);
    expect(served.headers['cache-control']).toBe('public, max-age=300');
    const picture = await request(ctx.server).get(pathOf(served.headers.location)).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(picture.headers['content-type']).toMatch(/image\/png/);
    expect(Buffer.compare(picture.body as Buffer, PNG)).toBe(0);

    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'CATALOG_IMAGE_UPLOAD_ISSUED', resourceId: productId } });
    expect(audit?.actorUserId).toBe(admin.userId);
  });

  it('refuses a stored picture that is not uploaded yet, or belongs to another product (Work 150)', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const productId = await createPricedProduct(ctx, { kind: 'OTC' });
    const other = await createPricedProduct(ctx, { kind: 'OTC' });

    const notUploaded = body(await askUpload(admin.accessToken, productId, { contentType: 'image/png', bytes: PNG.length }).expect(201)).imageUrl as string;
    const res = await patch(admin.accessToken, productId, [notUploaded]);
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toMatch(/not been uploaded/);

    const othersPicture = await uploaded(admin.accessToken, other);
    expect((await patch(admin.accessToken, productId, [othersPicture])).status).toBe(400);
    expect(await ctx.prisma.productImage.count({ where: { productId } })).toBe(0);
    await request(ctx.server).get(notUploaded).expect(404);
  });

  it('accepts only jpeg, png or webp up to 5 MB, for an existing product, from catalogue staff (Work 150)', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const productId = await createPricedProduct(ctx, { kind: 'OTC' });
    expect((await askUpload(admin.accessToken, productId, { contentType: 'application/pdf', bytes: 10 })).status).toBe(400);
    expect((await askUpload(admin.accessToken, productId, { contentType: 'image/png', bytes: 5 * 1024 * 1024 + 1 })).status).toBe(400);
    expect((await askUpload(admin.accessToken, '00000000-0000-4000-8000-000000000000', { contentType: 'image/png', bytes: 10 })).status).toBe(404);
    expect((await askUpload(customer.accessToken, productId, { contentType: 'image/png', bytes: 10 })).status).toBe(403);
    await request(ctx.server).get('/media/catalog/not-a-uuid/also-not').expect(404);
  });
});
