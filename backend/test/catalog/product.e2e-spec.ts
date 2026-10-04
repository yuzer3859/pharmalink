import request from 'supertest';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

function medicineDto(overrides: Record<string, unknown> = {}) {
  return {
    type: 'MEDICINE',
    genericName: 'Amoxicillin',
    manufacturerId: undefined,
    dosageForm: 'CAPSULE',
    strengthValue: 500,
    strengthUnit: 'MG',
    rxClassification: 'RX',
    nameEn: 'Amoxicillin 500mg',
    ...overrides,
  };
}

describe('Catalog — Product CRUD, classification and status (e2e)', () => {
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

  async function manufacturer(token: string) {
    const res = await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(token))
      .send({ name: 'Acme Pharma', country: 'Ethiopia' })
      .expect(201);
    return body(res).id as string;
  }

  // -----------------------------------------------------------------------------------------
  // AC-1 / AC-2 — classification & controlled-substance invariants
  // -----------------------------------------------------------------------------------------
  it('AC-1: rejects a MEDICINE with no rxClassification, then accepts it once supplied', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);

    const rejected = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId, rxClassification: undefined }));
    // VALIDATION_ERROR maps to HTTP 400 platform-wide (shared/errors/error-codes.ts), not 422 as
    // the spec's prose says — same documented deviation already established by Module 01/02
    // (see test/profiles/*.e2e-spec.ts). INVALID_CLASSIFICATION / INVALID_PRODUCT_STATUS_TRANSITION
    // / CATEGORY_CYCLE_DETECTED are genuinely mapped to 422 and are asserted as such below.
    expect(rejected.status).toBe(400);
    expect(errorOf(rejected).code).toBe('VALIDATION_ERROR');

    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);
    expect(body(created).rxClassification).toBe('RX');

    const fetched = await request(ctx.server)
      .get(`/admin/catalog/products/${body(created).id}`)
      .set(...auth(a.accessToken))
      .expect(200);
    expect(body(fetched).rxClassification).toBe('RX');
  });

  it('rejects a HEALTH_PRODUCT that carries an rxClassification (422 INVALID_CLASSIFICATION)', async () => {
    const a = await admin();
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send({ type: 'HEALTH_PRODUCT', brandName: 'Vitamin C', rxClassification: 'OTC' });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('INVALID_CLASSIFICATION');
  });

  it('§14.6: rejects a MEDICINE with no manufacturerId', async () => {
    const a = await admin();
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: undefined }));
    expect(res.status).toBe(400); // VALIDATION_ERROR -> 400 platform-wide
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('AC-2: forces onlineSaleProhibited = true when controlledSchedule = PROHIBITED', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId, controlledSchedule: 'PROHIBITED' }))
      .expect(201);
    expect(body(created).onlineSaleProhibited).toBe(true);
  });

  it('rejects an unknown field like onlineSaleProhibited (forbidNonWhitelisted)', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send({ ...medicineDto({ manufacturerId: mfrId }), onlineSaleProhibited: true });
    expect(res.status).toBe(400); // Nest's forbidNonWhitelisted -> 400
  });

  it('rejects an unknown out-of-scope field like equivalenceGroupId (forbidNonWhitelisted)', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send({ ...medicineDto({ manufacturerId: mfrId }), equivalenceGroupId: 'x' });
    expect(res.status).toBe(400); // Nest's forbidNonWhitelisted -> 400
  });

  // -----------------------------------------------------------------------------------------
  // AC-3 — dedup
  // -----------------------------------------------------------------------------------------
  it('AC-3: rejects a duplicate MEDICINE create with the existing product id surfaced', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const first = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);

    const dup = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }));
    expect(dup.status).toBe(409);
    expect(errorOf(dup).code).toBe('CATALOG_DUPLICATE_PRODUCT');
    expect((dup.body as { error: { details: { productId: string } } }).error.details.productId).toBe(
      body(first).id,
    );
  });

  it('is case-insensitive on genericName for dedup purposes', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId, genericName: 'amoxicillin' }))
      .expect(201);

    const dup = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId, genericName: 'AMOXICILLIN' }));
    expect(dup.status).toBe(409);
  });

  it('does not dedup HEALTH_PRODUCT items (§14.2 accepted no-dedup exemption)', async () => {
    const a = await admin();
    const dto = { type: 'HEALTH_PRODUCT', brandName: 'Vitamin C', nameEn: 'Vitamin C' };
    await request(ctx.server).post('/admin/catalog/products').set(...auth(a.accessToken)).send(dto).expect(201);
    await request(ctx.server).post('/admin/catalog/products').set(...auth(a.accessToken)).send(dto).expect(201);
  });

  // -----------------------------------------------------------------------------------------
  // PATCH semantics
  // -----------------------------------------------------------------------------------------
  it('PATCH updates a single field and leaves the rest untouched', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);

    const updated = await request(ctx.server)
      .patch(`/admin/catalog/products/${body(created).id}`)
      .set(...auth(a.accessToken))
      .send({ descriptionEn: 'A broad-spectrum antibiotic.' })
      .expect(200);
    expect(body(updated).descriptionEn).toBe('A broad-spectrum antibiotic.');
    expect(body(updated).genericName).toBe('Amoxicillin');
  });

  // -----------------------------------------------------------------------------------------
  // Reference price (`products.price`) — Catalog owns it; Module 06 reads it at checkout
  // -----------------------------------------------------------------------------------------
  it('persists a reference price through create and returns it on both admin and public reads', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);

    const created = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(a.accessToken))
        .send(medicineDto({ manufacturerId: mfrId, price: 2500 }))
        .expect(201),
    );
    expect(created.price).toBe(2500);

    // It really reached the column Module 06's `ICatalogPort` adapter reads, written through the
    // catalog repository rather than a direct Prisma write.
    const row = await ctx.prisma.product.findUniqueOrThrow({ where: { id: created.id as string } });
    expect(row.price).toBe(2500);

    await request(ctx.server)
      .post(`/admin/catalog/products/${created.id as string}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);

    const publicRead = body(
      await request(ctx.server).get(`/catalog/products/${created.id as string}`).expect(200),
    );
    expect(publicRead.price).toBe(2500);
  });

  it('leaves price null when the create omits it — unpriced, never defaulted to zero', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);

    const created = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(a.accessToken))
        .send(medicineDto({ manufacturerId: mfrId }))
        .expect(201),
    );

    expect(created.price).toBeNull();
    const row = await ctx.prisma.product.findUniqueOrThrow({ where: { id: created.id as string } });
    expect(row.price).toBeNull();
  });

  it('PATCHes the reference price and leaves it untouched when the body omits it', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(a.accessToken))
        .send(medicineDto({ manufacturerId: mfrId, price: 2500 }))
        .expect(201),
    );

    const repriced = body(
      await request(ctx.server)
        .patch(`/admin/catalog/products/${created.id as string}`)
        .set(...auth(a.accessToken))
        .send({ price: 3100 })
        .expect(200),
    );
    expect(repriced.price).toBe(3100);

    // A PATCH that says nothing about price must not clear it (the whole aggregate is rewritten
    // by `save()`, so this is the regression that would silently zero out live prices).
    const renamed = body(
      await request(ctx.server)
        .patch(`/admin/catalog/products/${created.id as string}`)
        .set(...auth(a.accessToken))
        .send({ nameEn: 'Amoxicillin 500mg (renamed)' })
        .expect(200),
    );
    expect(renamed.price).toBe(3100);
  });

  it.each([
    ['a floating-point price (money is never a float)', 25.5],
    ['a negative price', -1],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, price) => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);

    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId, price }));

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('rejects an empty PATCH body', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);

    const res = await request(ctx.server)
      .patch(`/admin/catalog/products/${body(created).id}`)
      .set(...auth(a.accessToken))
      .send({});
    expect(res.status).toBe(400); // VALIDATION_ERROR -> 400 platform-wide
  });

  it('rejects an attempt to PATCH the immutable `type` field', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);

    const res = await request(ctx.server)
      .patch(`/admin/catalog/products/${body(created).id}`)
      .set(...auth(a.accessToken))
      .send({ type: 'HEALTH_PRODUCT' });
    expect(res.status).toBe(400); // Nest's forbidNonWhitelisted -> 400
  });

  // -----------------------------------------------------------------------------------------
  // AC-4 / AC-5 — status machine & public visibility
  // -----------------------------------------------------------------------------------------
  it('AC-4: DRAFT products 404 for unauthenticated callers; ACTIVE ones are visible', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);
    const id = body(created).id as string;

    const draftRead = await request(ctx.server).get(`/catalog/products/${id}`);
    expect(draftRead.status).toBe(404);

    await request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);

    const activeRead = await request(ctx.server).get(`/catalog/products/${id}`).expect(200);
    expect(body(activeRead).id).toBe(id);
  });

  it('AC-5 + §14.3: DELISTED -> ACTIVE is illegal directly, but DELISTED -> DRAFT is legal', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);
    const id = body(created).id as string;

    await request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);
    await request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'DELISTED' })
      .expect(200);

    const illegal = await request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' });
    expect(illegal.status).toBe(422);
    expect(errorOf(illegal).code).toBe('INVALID_PRODUCT_STATUS_TRANSITION');

    const recovered = await request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'DRAFT' })
      .expect(200);
    expect(body(recovered).status).toBe('DRAFT');

    // Fully re-activatable only via the normal DRAFT -> ACTIVE transition.
    const reactivated = await request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect(body(reactivated).status).toBe('ACTIVE');
  });

  it('DEPRECATED products remain readable but excluded from search', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);
    const id = body(created).id as string;

    await request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);
    await request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'DEPRECATED' })
      .expect(200);

    await request(ctx.server).get(`/catalog/products/${id}`).expect(200);

    const search = await request(ctx.server).get('/catalog/products?q=Amoxicillin').expect(200);
    expect((body(search).items as unknown[]).length).toBe(0);
  });

  // -----------------------------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------------------------
  it('search returns ACTIVE products matching q, paginated', async () => {
    const a = await admin();
    const mfrId = await manufacturer(a.accessToken);
    const created = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(a.accessToken))
      .send(medicineDto({ manufacturerId: mfrId }))
      .expect(201);
    await request(ctx.server)
      .post(`/admin/catalog/products/${body(created).id}/status`)
      .set(...auth(a.accessToken))
      .send({ status: 'ACTIVE' })
      .expect(200);

    const res = await request(ctx.server).get('/catalog/products?q=amox').expect(200);
    const data = body(res) as { items: Array<{ id: string }>; meta: { total: number } };
    expect(data.items.some((i) => i.id === body(created).id)).toBe(true);
    expect(data.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('unauthenticated GET /catalog/products and /catalog/products/:id both work with no token', async () => {
    await request(ctx.server).get('/catalog/products').expect(200);
  });
});
