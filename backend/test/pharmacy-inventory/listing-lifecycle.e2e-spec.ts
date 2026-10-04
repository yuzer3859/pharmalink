import request from 'supertest';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

async function activeCatalogProduct(ctx: TestContext) {
  const admin = await createUserWithRole(ctx, 'ADMIN');
  const mfr = body(
    await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(admin.accessToken))
      .send({ name: 'Acme Pharma' })
      .expect(201),
  );
  const product = body(
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({
        type: 'MEDICINE',
        genericName: 'Paracetamol',
        manufacturerId: mfr.id,
        dosageForm: 'TABLET',
        strengthValue: 500,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn: 'Paracetamol 500mg',
      })
      .expect(201),
  );
  await request(ctx.server)
    .post(`/admin/catalog/products/${product.id as string}/status`)
    .set(...auth(admin.accessToken))
    .send({ status: 'ACTIVE' })
    .expect(200);
  return product.id as string;
}

/**
 * Reconciliation invariant (module-04 §3.10.4/§17.3): `onHand` is the derived sum of the
 * movements that actually change physical on-hand stock — `RECEIPT`/`ADJUST`/`DISPATCH`.
 * `RESERVE`/`RELEASE` movements track the `reserved`/`sellable` dimension, not `onHand` (§8:
 * a reservation never touches `onHand`, only `DISPATCH` does), so they are intentionally
 * excluded here — including them would double-count stock already reflected by `DISPATCH`.
 */
async function reconcileLedger(ctx: TestContext, listingId: string) {
  const listing = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
  const sum = await ctx.prisma.stockMovement.aggregate({
    where: { listingId, type: { in: ['RECEIPT', 'ADJUST', 'DISPATCH'] } },
    _sum: { quantityDelta: true },
  });
  expect(sum._sum.quantityDelta ?? 0).toBe(listing.onHand);
}

describe('Inventory listing lifecycle (e2e)', () => {
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

  it('create -> visible in availability; add batch increases sellable; disable hides from availability but keeps it in the listings list; soft-delete excludes everywhere', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );

    const listing = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 1500,
          batchNumber: 'B-1',
          initialQuantity: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    await reconcileLedger(ctx, listing.listingId as string);

    let availability = body(
      await request(ctx.server).get(`/availability/product/${productId}`).expect(200),
    ) as unknown as Array<{ listingId: string; sellable: number }>;
    expect(availability.some((r) => r.listingId === listing.listingId)).toBe(true);
    expect(availability.find((r) => r.listingId === listing.listingId)?.sellable).toBe(10);

    await request(ctx.server)
      .post(`/inventory/listings/${listing.listingId as string}/batches`)
      .set(...auth(pharmacy.accessToken))
      .send({
        batchNumber: 'B-2',
        quantity: 5,
        expiryDate: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201);
    await reconcileLedger(ctx, listing.listingId as string);

    availability = body(
      await request(ctx.server).get(`/availability/product/${productId}`).expect(200),
    ) as unknown as Array<{ listingId: string; sellable: number }>;
    expect(availability.find((r) => r.listingId === listing.listingId)?.sellable).toBe(15);

    await request(ctx.server)
      .patch(`/inventory/listings/${listing.listingId as string}`)
      .set(...auth(pharmacy.accessToken))
      .send({ isEnabled: false })
      .expect(200);

    availability = body(
      await request(ctx.server).get(`/availability/product/${productId}`).expect(200),
    ) as unknown as Array<{ listingId: string; sellable: number }>;
    expect(availability.some((r) => r.listingId === listing.listingId)).toBe(false);

    const stillListed = body(
      await request(ctx.server)
        .get('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .expect(200),
    ) as unknown as { items: Array<{ id: string }> };
    expect(stillListed.items.some((i) => i.id === listing.listingId)).toBe(true);

    await request(ctx.server)
      .delete(`/inventory/listings/${listing.listingId as string}`)
      .set(...auth(pharmacy.accessToken))
      .expect(204);

    const afterDelete = body(
      await request(ctx.server)
        .get('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .expect(200),
    ) as unknown as { items: Array<{ id: string }> };
    expect(afterDelete.items.some((i) => i.id === listing.listingId)).toBe(false);
  });

  it('rejects a batch adjustment without a reason and applies one with a reason (ledgered)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const listing = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 1500,
          batchNumber: 'B-1',
          initialQuantity: 10,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    const batches = await ctx.prisma.stockBatch.findMany({ where: { listingId: listing.listingId as string } });
    const batchId = batches[0].id;

    const missingReason = await request(ctx.server)
      .patch(`/inventory/batches/${batchId}`)
      .set(...auth(pharmacy.accessToken))
      .send({ quantityDelta: -2 });
    expect(missingReason.status).toBe(400);
    expect(errorOf(missingReason).code).toBe('VALIDATION_ERROR');

    await request(ctx.server)
      .patch(`/inventory/batches/${batchId}`)
      .set(...auth(pharmacy.accessToken))
      .send({ quantityDelta: -2, reason: 'Damaged in storage' })
      .expect(200);

    await reconcileLedger(ctx, listing.listingId as string);
    const updated = await ctx.prisma.inventoryListing.findUniqueOrThrow({
      where: { id: listing.listingId as string },
    });
    expect(updated.onHand).toBe(8);
  });

  it('two simultaneous ADJUST calls on the same batch: no lost update, no negative quantities ' +
    '(proves the fix — reads are re-locked inside the transaction, not taken before it)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const listing = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 1500,
          batchNumber: 'B-1',
          initialQuantity: 20,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    const batches = await ctx.prisma.stockBatch.findMany({ where: { listingId: listing.listingId as string } });
    const batchId = batches[0].id;

    const [a, b] = await Promise.all([
      request(ctx.server)
        .patch(`/inventory/batches/${batchId}`)
        .set(...auth(pharmacy.accessToken))
        .send({ quantityDelta: -5, reason: 'concurrent adjustment A' }),
      request(ctx.server)
        .patch(`/inventory/batches/${batchId}`)
        .set(...auth(pharmacy.accessToken))
        .send({ quantityDelta: -5, reason: 'concurrent adjustment B' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const batchRow = await ctx.prisma.stockBatch.findUniqueOrThrow({ where: { id: batchId } });
    // Both -5 deltas must be reflected — a lost update would leave this at 15 instead of 10.
    expect(batchRow.quantity).toBe(10);
    expect(batchRow.quantity).toBeGreaterThanOrEqual(0);

    const updated = await ctx.prisma.inventoryListing.findUniqueOrThrow({
      where: { id: listing.listingId as string },
    });
    expect(updated.onHand).toBe(10);
    expect(updated.onHand).toBeGreaterThanOrEqual(0);
    await reconcileLedger(ctx, listing.listingId as string);

    const adjustMovements = await ctx.prisma.stockMovement.count({
      where: { listingId: listing.listingId as string, type: 'ADJUST' },
    });
    expect(adjustMovements).toBe(2);
  });

  it('rejects a duplicate (branch, product) listing with 409 DUPLICATE_LISTING', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const dto = {
      catalogProductId: productId,
      branchId: branch.branchId,
      price: 1500,
      batchNumber: 'B-1',
      initialQuantity: 10,
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send(dto)
      .expect(201);

    const dup = await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(pharmacy.accessToken))
      .send(dto);
    expect(dup.status).toBe(409);
    expect(errorOf(dup).code).toBe('DUPLICATE_LISTING');
  });
});
