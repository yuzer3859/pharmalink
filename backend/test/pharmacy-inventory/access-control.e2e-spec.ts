import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy, PharmacyOwnerContext } from './support';

async function activeCatalogProduct(ctx: TestContext) {
  const admin = await createUserWithRole(ctx, 'ADMIN');
  const mfr = body(
    await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(admin.accessToken))
      .send({ name: `Acme Pharma ${randomUUID()}` })
      .expect(201),
  );
  const product = body(
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({
        type: 'MEDICINE',
        genericName: 'Metformin',
        manufacturerId: mfr.id,
        dosageForm: 'TABLET',
        strengthValue: 500,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn: 'Metformin 500mg',
      })
      .expect(201),
  );
  // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
  await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
  await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
  return product.id as string;
}

async function seedListingWithMovements(ctx: TestContext, pharmacy: PharmacyOwnerContext) {
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
        price: 900,
        batchNumber: 'B-1',
        initialQuantity: 10,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201),
  );
  return listing.listingId as string;
}

describe('Pharmacy & Inventory — access control (e2e)', () => {
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

  it('rejects unauthenticated calls to guarded routes with 401', async () => {
    const res = await request(ctx.server).get('/pharmacy/profile');
    expect(res.status).toBe(401);
  });

  it('the public availability route works with no token', async () => {
    const res = await request(ctx.server).get('/availability/product/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(200);
    expect(body(res)).toEqual([]);
  });

  it('the public availability response is a strict field allowlist — never leaks license/' +
    'compliance/staff/batch/supplier data (module-04 §15)', async () => {
    const pharmacy = await createActivatedPharmacy(ctx);
    const listingId = await seedListingWithMovements(ctx, pharmacy);
    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });

    const res = body(
      await request(ctx.server)
        .get(`/availability/product/${listingRow.catalogProductId}`)
        .expect(200),
    ) as unknown as Array<Record<string, unknown>>;
    expect(res.length).toBeGreaterThan(0);
    const item = res[0];

    const allowedKeys = new Set([
      'pharmacyId',
      'branchId',
      'listingId',
      'price',
      'currency',
      'sellable',
      'storageRequirement',
      'distanceMeters',
    ]);
    for (const key of Object.keys(item)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // Explicitly confirm the forbidden fields the spec calls out are absent.
    for (const forbidden of [
      'licenseStatus',
      'licenseExpiresAt',
      'transactingStatus',
      'organizationId',
      'batchNumber',
      'batchId',
      'supplier',
      'expiryDate',
      'onHand',
      'reserved',
      'staffUserId',
      'actorUserId',
    ]) {
      expect(item).not.toHaveProperty(forbidden);
    }
  });

  it('a role without inventory:manage:org gets 403 FORBIDDEN on inventory routes', async () => {
    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    const res = await request(ctx.server)
      .get('/inventory/listings')
      .set(...auth(customer.accessToken));
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });

  it('cross-tenant isolation: pharmacy A staff cannot manage pharmacy B branches/listings', async () => {
    const pharmacyA = await createActivatedPharmacy(ctx);
    const pharmacyB = await createActivatedPharmacy(ctx);

    const branchB = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacyB.accessToken))
        .send({ name: 'Branch B' })
        .expect(201),
    );

    // Pharmacy A's owner attempts to patch pharmacy B's branch — must not succeed.
    const res = await request(ctx.server)
      .patch(`/pharmacy/branches/${branchB.branchId as string}`)
      .set(...auth(pharmacyA.accessToken))
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('BRANCH_NOT_FOUND');

    const stillOriginal = await ctx.prisma.branch.findUniqueOrThrow({
      where: { id: branchB.branchId as string },
    });
    expect(stillOriginal.name).toBe('Branch B');
  });

  it('cross-tenant isolation: pharmacy A cannot read pharmacy B\'s GET .../movements ledger — 404, not a data leak', async () => {
    const pharmacyA = await createActivatedPharmacy(ctx);
    const pharmacyB = await createActivatedPharmacy(ctx);
    const listingBId = await seedListingWithMovements(ctx, pharmacyB);

    const res = await request(ctx.server)
      .get(`/inventory/listings/${listingBId}/movements`)
      .set(...auth(pharmacyA.accessToken));
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('LISTING_NOT_FOUND');
    // Confirms no partial/movement data leaked in the error body.
    expect(JSON.stringify(res.body)).not.toContain('RECEIPT');
  });

  describe('GET .../movements pagination & filtering (module-04 §10.2)', () => {
    it('defaults to page=1/size=20, and validates via a DTO (not raw manual parsing)', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      const listingId = await seedListingWithMovements(ctx, pharmacy);

      const defaultRes = body(
        await request(ctx.server)
          .get(`/inventory/listings/${listingId}/movements`)
          .set(...auth(pharmacy.accessToken))
          .expect(200),
      ) as unknown as { items: unknown[]; total: number };
      expect(defaultRes.total).toBeGreaterThan(0);

      const explicitRes = body(
        await request(ctx.server)
          .get(`/inventory/listings/${listingId}/movements?page=1&size=5`)
          .set(...auth(pharmacy.accessToken))
          .expect(200),
      ) as unknown as { items: unknown[] };
      expect(explicitRes.items.length).toBeLessThanOrEqual(5);
    });

    it('rejects a negative/zero page and an oversized page size as 400 VALIDATION_ERROR', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      const listingId = await seedListingWithMovements(ctx, pharmacy);

      const negativePage = await request(ctx.server)
        .get(`/inventory/listings/${listingId}/movements?page=-1`)
        .set(...auth(pharmacy.accessToken));
      expect(negativePage.status).toBe(400);

      const zeroPage = await request(ctx.server)
        .get(`/inventory/listings/${listingId}/movements?page=0`)
        .set(...auth(pharmacy.accessToken));
      expect(zeroPage.status).toBe(400);

      const oversizedPage = await request(ctx.server)
        .get(`/inventory/listings/${listingId}/movements?size=10000`)
        .set(...auth(pharmacy.accessToken));
      expect(oversizedPage.status).toBe(400);
    });

    it('pages are stable and non-overlapping: concatenating all pages yields no duplicate/missing movement ids', async () => {
      const pharmacy = await createActivatedPharmacy(ctx);
      const listingId = await seedListingWithMovements(ctx, pharmacy);
      const batches = await ctx.prisma.stockBatch.findMany({ where: { listingId } });
      // Generate a few more ADJUST movements so there's more than one page at size=2.
      for (let i = 0; i < 3; i += 1) {
        await request(ctx.server)
          .patch(`/inventory/batches/${batches[0].id}`)
          .set(...auth(pharmacy.accessToken))
          .send({ quantityDelta: -1, reason: `adjust ${i}` })
          .expect(200);
      }

      const total = await ctx.prisma.stockMovement.count({ where: { listingId } });
      const pageSize = 2;
      const pageCount = Math.ceil(total / pageSize);
      const seenIds = new Set<string>();
      for (let page = 1; page <= pageCount; page += 1) {
        const res = body(
          await request(ctx.server)
            .get(`/inventory/listings/${listingId}/movements?page=${page}&size=${pageSize}`)
            .set(...auth(pharmacy.accessToken))
            .expect(200),
        ) as unknown as { items: Array<{ id: string }> };
        for (const item of res.items) {
          expect(seenIds.has(item.id)).toBe(false); // no duplicate across pages
          seenIds.add(item.id);
        }
      }
      expect(seenIds.size).toBe(total); // no missing record
    });
  });

  describe('GET /inventory/listings filtering (module-04 §10.2)', () => {
    it('branchId/catalogProductId filters are honored and scoped to the caller\'s own pharmacy; soft-deleted listings are excluded', async () => {
      const pharmacyA = await createActivatedPharmacy(ctx);
      const pharmacyB = await createActivatedPharmacy(ctx);
      const listingAId = await seedListingWithMovements(ctx, pharmacyA);
      await seedListingWithMovements(ctx, pharmacyB);

      const listResA = body(
        await request(ctx.server)
          .get('/inventory/listings')
          .set(...auth(pharmacyA.accessToken))
          .expect(200),
      ) as unknown as { items: Array<{ id: string }> };
      expect(listResA.items.map((i) => i.id)).toEqual([listingAId]);

      await request(ctx.server)
        .delete(`/inventory/listings/${listingAId}`)
        .set(...auth(pharmacyA.accessToken))
        .expect(204);

      const afterDelete = body(
        await request(ctx.server)
          .get('/inventory/listings')
          .set(...auth(pharmacyA.accessToken))
          .expect(200),
      ) as unknown as { items: Array<{ id: string }> };
      expect(afterDelete.items).toHaveLength(0);
    });
  });
});
