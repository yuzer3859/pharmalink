import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
const submitPath = (id: string) => `/admin/catalog/review/${id}/submit`;
const approvePath = (id: string) => `/admin/catalog/review/${id}/approve`;

/**
 * Module 16 Work 29 against real PostgreSQL: submitting a draft product for catalogue review, and
 * the whole normal workflow — create (Module 03's route) → submit → listed for review → approve
 * (Work 28) → ACTIVE — with no direct database writes.
 */
describe('Admin catalogue review submission (e2e)', () => {
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
    const res = await request(ctx.server).post('/admin/catalog/manufacturers').set(...auth(admin.accessToken)).send({ name: 'Acme Pharma', country: 'Ethiopia' }).expect(201);
    manufacturerId = body(res).id as string;
  });

  const post = (path: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).post(path);
    return token ? r.set(...auth(token)) : r;
  };
  /** A DRAFT product, created through Module 03's own route — the only product-creation path. */
  async function createProduct(): Promise<string> {
    seq += 1;
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({ type: 'MEDICINE', genericName: `Generic${seq}`, manufacturerId, dosageForm: 'TABLET', strengthValue: 500, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `Product ${seq}`, price: 1_800 })
      .expect(201);
    expect(body(res).status).toBe('DRAFT');
    return body(res).id as string;
  }
  async function productIn(status: string): Promise<string> {
    const id = await createProduct();
    const path: Record<string, string[]> = { DRAFT: [], ACTIVE: ['ACTIVE'], DEPRECATED: ['ACTIVE', 'DEPRECATED'], DELISTED: ['ACTIVE', 'DELISTED'] };
    if (status === 'PENDING_REVIEW') {
      await post(submitPath(id)).expect(200);
      return id;
    }
    for (const step of path[status]) {
      await request(ctx.server).post(`/admin/catalog/products/${id}/status`).set(...auth(admin.accessToken)).send({ status: step }).expect(200);
    }
    return id;
  }
  const statusChanges = (id: string) => ctx.prisma.auditLog.findMany({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: id }, orderBy: { createdAt: 'asc' } });
  const events = (id: string) => ctx.prisma.outbox.findMany({ where: { eventType: 'catalog.product.status_changed', aggregateId: id }, orderBy: { createdAt: 'asc' } });
  const review = async (status: string) =>
    (body(await request(ctx.server).get('/admin/catalog/review').query({ status }).set(...auth(admin.accessToken)).expect(200)) as unknown as {
      items: Array<{ id: string; status: string; allowedTransitions: string[] }>;
    }).items;
  const inventoryCounts = async () => ({ listings: await ctx.prisma.inventoryListing.count(), pharmacies: await ctx.prisma.pharmacy.count(), batches: await ctx.prisma.stockBatch.count(), reservations: await ctx.prisma.stockReservation.count() });

  it('the complete normal workflow: create → submit → listed for review → approve → ACTIVE; two audit rows, two events, no inventory', async () => {
    const inventoryBefore = await inventoryCounts();
    // 1. Created through the established application path.
    const id = await createProduct();
    expect((await review('DRAFT')).map((i) => [i.id, i.allowedTransitions])).toEqual([[id, ['PENDING_REVIEW', 'ACTIVE']]]);

    // 2–3. Submitted: PENDING_REVIEW.
    const submitted = body(await post(submitPath(id)).expect(200)) as Record<string, unknown>;
    expect(submitted).toMatchObject({ id, status: 'PENDING_REVIEW' });
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');

    // 4. Work 09's review list shows it.
    expect((await review('PENDING_REVIEW')).map((i) => [i.id, i.status, i.allowedTransitions])).toEqual([[id, 'PENDING_REVIEW', ['ACTIVE']]]);
    expect(await review('DRAFT')).toEqual([]);

    // 5–6. Approved through Work 28: ACTIVE.
    expect(body(await post(approvePath(id)).expect(200))).toMatchObject({ id, status: 'ACTIVE' });
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    expect(await review('PENDING_REVIEW')).toEqual([]);
    expect((await review('ACTIVE')).map((i) => i.id)).toEqual([id]);

    // 7. One audit row and one outbox event per transition, in order.
    expect((await statusChanges(id)).map((a) => [a.actorUserId, a.context])).toEqual([
      [admin.userId, { from: 'DRAFT', to: 'PENDING_REVIEW', reason: null }],
      [admin.userId, { from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null }],
    ]);
    expect((await events(id)).map((e) => (e.payload as { payload: { from: string; to: string } }).payload)).toEqual([
      { productId: id, from: 'DRAFT', to: 'PENDING_REVIEW', reason: null },
      { productId: id, from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null },
    ]);
    expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN_CATALOG' } } })).toBe(0);

    // 8. Nothing created in Module 04.
    expect(await inventoryCounts()).toEqual(inventoryBefore);
  });

  it('submission changes only the status — every other product column is unchanged', async () => {
    const id = await createProduct();
    const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    await post(submitPath(id)).expect(200);
    const after = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    const strip = (p: typeof before) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'status' && k !== 'updatedAt'));
    expect([before.status, after.status]).toEqual(['DRAFT', 'PENDING_REVIEW']);
    expect(strip(after)).toEqual(strip(before));
  });

  it('PENDING_REVIEW, ACTIVE, DEPRECATED, DELISTED → 409 CONFLICT; unchanged; no new audit row or event', async () => {
    for (const status of ['PENDING_REVIEW', 'ACTIVE', 'DEPRECATED', 'DELISTED']) {
      const id = await productIn(status);
      const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
      const [audits, published] = [(await statusChanges(id)).length, (await events(id)).length];
      const res = await post(submitPath(id));
      expect({ status, http: res.status, code: res.body?.error?.code ?? res.body?.code }).toEqual({ status, http: 409, code: 'CONFLICT' });
      expect(await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect([(await statusChanges(id)).length, (await events(id)).length]).toEqual([audits, published]);
    }
  });

  it('unknown or soft-deleted product → 404, malformed id → 400; nothing audited', async () => {
    const deleted = await createProduct();
    await ctx.prisma.product.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const auditBefore = await ctx.prisma.auditLog.count();
    await post(submitPath(randomUUID())).expect(404);
    await post(submitPath('not-a-uuid')).expect(400);
    await post(submitPath(deleted)).expect(404);
    expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
  });

  it('a body cannot redirect the submission: a { status: ACTIVE } body still yields PENDING_REVIEW', async () => {
    const id = await createProduct();
    await post(submitPath(id)).send({ status: 'ACTIVE' }).expect(200);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');
  });

  it('concurrent submissions: exactly one 200, the rest 409; one transition, one audit row, one event', async () => {
    const id = await createProduct();
    const results = await Promise.all(Array.from({ length: 6 }, () => post(submitPath(id))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');
    expect((await statusChanges(id)).length).toBe(1);
    expect((await events(id)).length).toBe(1);
  });

  it('RBAC: 401 anonymous; 403 for pharmacy roles (catalog:manage:org), other roles and a read-only catalogue role; SUPER_ADMIN allowed', async () => {
    const id = await createProduct();
    expect((await post(submitPath(id), null)).status).toBe(401);
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      expect({ role, status: (await post(submitPath(id), (await createUserWithRole(ctx, role)).accessToken)).status }).toEqual({ role, status: 403 });
    }
    const read = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'catalog:read:any' } });
    const reader = await ctx.prisma.role.upsert({ where: { key: 'CATALOG_READER_TEST' }, update: {}, create: { key: 'CATALOG_READER_TEST', name: 'Catalog reader (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: reader.id, permissionId: read.id } }, update: {}, create: { roleId: reader.id, permissionId: read.id } });
    expect((await post(submitPath(id), (await createUserWithRole(ctx, 'CATALOG_READER_TEST')).accessToken)).status).toBe(403);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');
    expect((await statusChanges(id)).length).toBe(0);
    await post(submitPath(id), (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
    // The generic status route moving DRAFT → PENDING_REVIEW is held to the same key.
    const other = await createProduct();
    const owner = await createUserWithRole(ctx, 'PHARMACY_OWNER');
    await request(ctx.server).post(`/admin/catalog/products/${other}/status`).set(...auth(owner.accessToken)).send({ status: 'PENDING_REVIEW' }).expect(403);
  });

  it('privacy: the response is the catalogue record only — no creator, person, pharmacy or listing data', async () => {
    const id = await createProduct();
    const raw = JSON.stringify((await post(submitPath(id)).expect(200)).body);
    const row = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    for (const secret of [row.createdBy, admin.userId, admin.phone].filter((v): v is string => !!v)) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/createdBy|deletedAt|supplier|pharmacy|listing|phone|email/i);
  });
});
