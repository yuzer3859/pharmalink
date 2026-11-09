import request from 'supertest';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createPricedProduct, createStockedPharmacy } from '../orders/support';

/**
 * Work 111: the pharmacy portal's inventory read. `GET /inventory/listings` items gain the product
 * name; `GET /inventory/listings/:id` reads one listing with its batches, scoped to the caller's
 * pharmacy.
 */
describe('Inventory listing view (Work 111, e2e)', () => {
  let ctx: TestContext;
  let shop: Awaited<ReturnType<typeof createStockedPharmacy>>;
  let other: Awaited<ReturnType<typeof createStockedPharmacy>>;
  let productId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
    productId = await createPricedProduct(ctx, { price: 2500 });
    shop = await createStockedPharmacy(ctx, productId, 40);
    other = await createStockedPharmacy(ctx, productId, 5);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  const get = (token: string, path: string) => request(ctx.server).get(path).set(...auth(token));

  it('the list carries the product name and keeps the earlier fields', async () => {
    const page = body(await get(shop.accessToken, '/inventory/listings').expect(200)) as {
      items: Array<{ id: string; catalogProductId: string; productName: string | null; onHand: number; sellable: number; price: number }>;
      total: number;
    };
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ catalogProductId: productId, productName: 'Ibuprofen 400mg', onHand: 40, sellable: 40, price: 2500 });
  });

  it('reads one listing with its batches, soonest expiry first', async () => {
    const [listing] = (body(await get(shop.accessToken, '/inventory/listings').expect(200)) as { items: Array<{ id: string }> }).items;
    const expiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    await request(ctx.server)
      .post(`/inventory/listings/${listing.id}/batches`)
      .set(...auth(shop.accessToken))
      .send({ batchNumber: 'B-2', quantity: 10, expiryDate: expiry })
      .expect(201);

    const one = body(await get(shop.accessToken, `/inventory/listings/${listing.id}`).expect(200)) as {
      id: string;
      productName: string;
      onHand: number;
      batches: Array<{ id: string; batchNumber: string; quantity: number; expiryDate: string }>;
    };
    expect(one).toMatchObject({ id: listing.id, productName: 'Ibuprofen 400mg', onHand: 50 });
    expect(one.batches.map((b) => b.batchNumber)).toEqual(['B-2', 'B-1']);
    expect(one.batches.map((b) => b.quantity)).toEqual([10, 40]);

    // The batch id is what an adjustment needs.
    await request(ctx.server)
      .patch(`/inventory/batches/${one.batches[0].id}`)
      .set(...auth(shop.accessToken))
      .send({ quantityDelta: -2, reason: 'Damaged in storage' })
      .expect(200);
    const after = body(await get(shop.accessToken, `/inventory/listings/${listing.id}`).expect(200)) as { onHand: number; batches: Array<{ quantity: number }> };
    expect(after.onHand).toBe(48);
    expect(after.batches[0].quantity).toBe(8);
  });

  it("another pharmacy's listing reads as not found", async () => {
    const [theirs] = (body(await get(other.accessToken, '/inventory/listings').expect(200)) as { items: Array<{ id: string }> }).items;
    const res = await get(shop.accessToken, `/inventory/listings/${theirs.id}`).expect(404);
    expect(errorOf(res).code).toBe('LISTING_NOT_FOUND');
  });
});
