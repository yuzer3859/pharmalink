import request from 'supertest';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createPricedProduct, createStockedPharmacy } from '../orders/support';

/**
 * Work 151 (owner decision 2026-11-24): a pharmacy suggests pictures for a product it stocks, from
 * its own listing. Product pictures are shared by every pharmacy, so customers see a suggestion
 * only once catalogue staff approve it; a rejection tells the pharmacy why.
 */
describe('Catalog — pictures suggested by pharmacies (Work 151, e2e)', () => {
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

  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex');
  const pathOf = (url: string) => new URL(url, 'http://local').pathname;

  async function stocked() {
    const productId = await createPricedProduct(ctx, { kind: 'OTC' });
    const pharmacy = await createStockedPharmacy(ctx, productId, 5);
    const listing = await ctx.prisma.inventoryListing.findFirstOrThrow({ where: { catalogProductId: productId } });
    return { productId, pharmacy, listingId: listing.id };
  }

  async function upload(token: string, listingId: string) {
    const issued = body(
      await request(ctx.server)
        .post(`/inventory/listings/${listingId}/pictures/uploads`)
        .set(...auth(token))
        .send({ contentType: 'image/png', bytes: PNG.length })
        .expect(201),
    ) as { imageUrl: string; upload: { url: string } };
    await request(ctx.server).put(pathOf(issued.upload.url)).set('Content-Type', 'image/png').send(PNG).expect(200);
    return issued.imageUrl;
  }

  const suggest = (token: string, listingId: string, imageUrl: string) =>
    request(ctx.server).post(`/inventory/listings/${listingId}/pictures/suggestions`).set(...auth(token)).send({ imageUrl });
  const pictures = async (token: string, listingId: string) =>
    body(await request(ctx.server).get(`/inventory/listings/${listingId}/pictures`).set(...auth(token)).expect(200)) as {
      images: string[];
      suggestions: Array<Record<string, unknown>>;
    };
  const queue = async (token: string, status = 'PENDING') =>
    body(await request(ctx.server).get(`/admin/catalog/picture-suggestions?status=${status}`).set(...auth(token)).expect(200)) as {
      items: Array<Record<string, unknown>>;
      meta: { total: number };
    };
  const customerImages = async (productId: string) =>
    (body(await request(ctx.server).get(`/catalog/products/${productId}`).expect(200)).images as string[]);

  it('a pharmacy suggests a picture; customers see it only after staff approve it', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const { productId, pharmacy, listingId } = await stocked();
    await request(ctx.server).patch(`/admin/catalog/products/${productId}`).set(...auth(admin.accessToken)).send({ images: ['/products/a.webp'] }).expect(200);

    const imageUrl = await upload(pharmacy.accessToken, listingId);
    const suggested = await suggest(pharmacy.accessToken, listingId, imageUrl);
    expect(suggested.status).toBe(201);
    expect(body(suggested)).toEqual(expect.objectContaining({ productId, imageUrl, status: 'PENDING', reason: null }));

    expect(await customerImages(productId)).toEqual(['/products/a.webp']);
    const mine = await pictures(pharmacy.accessToken, listingId);
    expect(mine.images).toEqual(['/products/a.webp']);
    expect(mine.suggestions.map((s) => s.status)).toEqual(['PENDING']);

    const waiting = await queue(admin.accessToken);
    expect(waiting.meta.total).toBe(1);
    expect(waiting.items[0]).toEqual(expect.objectContaining({ imageUrl, productId, productPictureCount: 1, pharmacyName: expect.any(String) }));

    const approved = await request(ctx.server)
      .post(`/admin/catalog/picture-suggestions/${waiting.items[0].id as string}/approve`)
      .set(...auth(admin.accessToken))
      .expect(200);
    expect(body(approved)).toEqual(expect.objectContaining({ status: 'APPROVED', images: ['/products/a.webp', imageUrl] }));
    expect(await customerImages(productId)).toEqual(['/products/a.webp', imageUrl]);
    expect((await pictures(pharmacy.accessToken, listingId)).suggestions[0].status).toBe('APPROVED');
    expect((await queue(admin.accessToken)).meta.total).toBe(0);

    // Deciding twice is refused.
    const again = await request(ctx.server).post(`/admin/catalog/picture-suggestions/${waiting.items[0].id as string}/approve`).set(...auth(admin.accessToken));
    expect(again.status).toBe(409);

    const actions = (await ctx.prisma.auditLog.findMany({ where: { resourceId: productId }, select: { action: true, actorUserId: true } }));
    expect(actions).toEqual(expect.arrayContaining([
      { action: 'CATALOG_IMAGE_SUGGESTED', actorUserId: pharmacy.userId },
      { action: 'CATALOG_IMAGE_SUGGESTION_APPROVED', actorUserId: admin.userId },
    ]));
  });

  it('a rejection keeps the picture off the product and tells the pharmacy why', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const { productId, pharmacy, listingId } = await stocked();
    const suggested = body(await suggest(pharmacy.accessToken, listingId, await upload(pharmacy.accessToken, listingId)).expect(201));

    const noReason = await request(ctx.server).post(`/admin/catalog/picture-suggestions/${suggested.id as string}/reject`).set(...auth(admin.accessToken)).send({ reason: ' ' });
    expect(noReason.status).toBe(400);

    await request(ctx.server)
      .post(`/admin/catalog/picture-suggestions/${suggested.id as string}/reject`)
      .set(...auth(admin.accessToken))
      .send({ reason: 'Shows a brand logo.' })
      .expect(200);
    expect(await customerImages(productId)).toEqual([]);
    expect((await pictures(pharmacy.accessToken, listingId)).suggestions[0]).toEqual(expect.objectContaining({ status: 'REJECTED', reason: 'Shows a brand logo.' }));
    expect((await queue(admin.accessToken, 'REJECTED')).meta.total).toBe(1);
  });

  it('only for its own listings, only uploaded pictures, at most 3 waiting', async () => {
    const { listingId, pharmacy } = await stocked();
    const other = await stocked();

    // Another pharmacy's listing reads as not found.
    const foreign = await request(ctx.server).post(`/inventory/listings/${other.listingId}/pictures/uploads`).set(...auth(pharmacy.accessToken)).send({ contentType: 'image/png', bytes: 10 });
    expect(foreign.status).toBe(404);
    // A picture uploaded for another product cannot be suggested here.
    const othersPicture = await upload(other.pharmacy.accessToken, other.listingId);
    expect((await suggest(pharmacy.accessToken, listingId, othersPicture)).status).toBe(400);
    // Only uploaded pictures, never an outside address.
    expect((await suggest(pharmacy.accessToken, listingId, 'https://cdn.example.et/a.jpg')).status).toBe(400);

    for (let i = 0; i < 3; i++) await suggest(pharmacy.accessToken, listingId, await upload(pharmacy.accessToken, listingId)).expect(201);
    const fourth = await request(ctx.server).post(`/inventory/listings/${listingId}/pictures/uploads`).set(...auth(pharmacy.accessToken)).send({ contentType: 'image/png', bytes: 10 });
    expect(fourth.status).toBe(400);
    expect(errorOf(fourth).message).toMatch(/3 pictures waiting/);

    // Pharmacies cannot review; customers cannot suggest.
    expect((await request(ctx.server).get('/admin/catalog/picture-suggestions').set(...auth(pharmacy.accessToken))).status).toBe(403);
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    expect((await request(ctx.server).get(`/inventory/listings/${listingId}/pictures`).set(...auth(customer.accessToken))).status).toBe(403);
  });
});
