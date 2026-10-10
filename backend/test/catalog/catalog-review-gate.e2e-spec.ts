import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;

/**
 * Module 03 / Module 16 Work 30 against real PostgreSQL: the catalogue review gate. A draft is
 * published only through review — `DRAFT -> PENDING_REVIEW -> ACTIVE` — and no application route can
 * publish it directly. Enforced in one place, `ProductStatusPolicy`.
 */
describe('Catalogue review gate (e2e)', () => {
  let ctx: TestContext;
  let admin: User;
  let manufacturerId: string;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    manufacturerId = body(await request(ctx.server).post('/admin/catalog/manufacturers').set(...auth(admin.accessToken)).send({ name: 'Acme Pharma' }).expect(201)).id as string;
  });

  const as = (method: 'post' | 'patch', path: string) => request(ctx.server)[method](path).set(...auth(admin.accessToken));
  async function createDraft(): Promise<string> {
    seq += 1;
    const res = await as('post', '/admin/catalog/products')
      .send({ type: 'MEDICINE', genericName: `Generic${seq}`, manufacturerId, dosageForm: 'TABLET', strengthValue: 250, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `Gate product ${seq}`, price: 900 })
      .expect(201);
    return body(res).id as string;
  }
  const statusChanges = (id: string) => ctx.prisma.auditLog.count({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: id } });
  const events = (id: string) => ctx.prisma.outbox.count({ where: { eventType: 'catalog.product.status_changed', aggregateId: id } });
  const review = async (status: string) =>
    (body(await request(ctx.server).get('/admin/catalog/review').query({ status }).set(...auth(admin.accessToken)).expect(200)) as unknown as { items: Array<{ id: string }> }).items.map((i) => i.id);

  it('the generic status route refuses DRAFT → ACTIVE (422 INVALID_PRODUCT_STATUS_TRANSITION): product unchanged, no audit row, no outbox event', async () => {
    const id = await createDraft();
    const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    const [audits, published] = [await statusChanges(id), await events(id)];

    const res = await as('post', `/admin/catalog/products/${id}/status`).send({ status: 'ACTIVE' });
    expect(res.status).toBe(422);
    expect(res.body?.error?.code ?? res.body?.code).toBe('INVALID_PRODUCT_STATUS_TRANSITION');

    expect(await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(before); // every column, updatedAt included
    expect([await statusChanges(id), await events(id)]).toEqual([audits, published]);
    expect([audits, published]).toEqual([0, 0]);
    // Not public, not listed as active.
    expect((await request(ctx.server).get(`/catalog/products/${id}`)).status).toBe(404);
    expect(await review('ACTIVE')).toEqual([]);
  });

  it('no other route can publish a draft: PATCH and create refuse a status field (400) and the product stays DRAFT', async () => {
    const id = await createDraft();
    await as('patch', `/admin/catalog/products/${id}`).send({ status: 'ACTIVE' }).expect(400);
    await as('patch', `/admin/catalog/products/${id}`).send({ nameEn: 'Renamed', status: 'ACTIVE' }).expect(400);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
    await as('post', '/admin/catalog/products')
      .send({ type: 'MEDICINE', genericName: 'Sneaky', manufacturerId, dosageForm: 'TABLET', strengthValue: 1, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: 'Sneaky', status: 'ACTIVE' })
      .expect(400);
    // Work 28's approval refuses a DRAFT too (it requires PENDING_REVIEW).
    await as('post', `/admin/catalog/review/${id}/approve`).expect(409);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
    expect(await statusChanges(id)).toBe(0);
  });

  it('the review workflow still works end to end: create → submit → listed → approve → ACTIVE, leaving the queue', async () => {
    const listings = await ctx.prisma.inventoryListing.count();
    const id = await createDraft();
    expect(body(await as('post', `/admin/catalog/review/${id}/submit`).expect(200))).toMatchObject({ id, status: 'PENDING_REVIEW' });
    expect(await review('PENDING_REVIEW')).toEqual([id]);
    expect(body(await as('post', `/admin/catalog/review/${id}/approve`).expect(200))).toMatchObject({ id, status: 'ACTIVE' });
    expect(await review('PENDING_REVIEW')).toEqual([]);
    expect(await review('ACTIVE')).toEqual([id]);
    expect((await request(ctx.server).get(`/catalog/products/${id}`)).status).toBe(200);
    expect([await statusChanges(id), await events(id)]).toEqual([2, 2]);
    expect(await ctx.prisma.inventoryListing.count()).toBe(listings);
  });

  it('the generic route still performs the other legal transitions; it takes no DRAFT out — review does', async () => {
    const id = await createDraft();
    // The generic route never accepted PENDING_REVIEW (its DTO: ACTIVE/DEPRECATED/DELISTED/DRAFT), and
    // DRAFT -> ACTIVE is now illegal: a draft leaves only through submit → approve.
    expect((await as('post', `/admin/catalog/products/${id}/status`).send({ status: 'PENDING_REVIEW' })).status).toBe(400);
    await as('post', `/admin/catalog/review/${id}/submit`).expect(200);
    await as('post', `/admin/catalog/review/${id}/approve`).expect(200);
    for (const to of ['DEPRECATED', 'ACTIVE', 'DELISTED', 'DRAFT']) {
      expect({ to, status: (await as('post', `/admin/catalog/products/${id}/status`).send({ status: to })).status }).toEqual({ to, status: 200 });
    }
    // Back in DRAFT after delisting (§14.3): still gated.
    expect((await as('post', `/admin/catalog/products/${id}/status`).send({ status: 'ACTIVE' })).status).toBe(422);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
  });

  it('submission and approval stay race-safe: concurrent submits → one transition; concurrent approvals → one transition', async () => {
    const id = await createDraft();
    const submits = await Promise.all(Array.from({ length: 5 }, () => as('post', `/admin/catalog/review/${id}/submit`)));
    expect(submits.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    const approvals = await Promise.all(Array.from({ length: 5 }, () => as('post', `/admin/catalog/review/${id}/approve`)));
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    expect([await statusChanges(id), await events(id)]).toEqual([2, 2]);
  });
});
