import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
const approvePath = (id: string) => `/admin/catalog/review/${id}/approve`;

/**
 * Module 16 Work 28 against real PostgreSQL: approving a product under catalogue review through
 * Module 03's own status command.
 *
 * Products are created through Module 03's route (as `DRAFT`) and placed in `PENDING_REVIEW` directly
 * in the database, so each test's audit and outbox counts are the approval's alone. The application
 * path into `PENDING_REVIEW` — Work 29's submission — and the whole create → submit → approve
 * workflow are covered in admin-catalog-submission.e2e-spec.ts.
 */
describe('Admin catalogue review approval (e2e)', () => {
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

  const approve = (id: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).post(approvePath(id));
    return token ? r.set(...auth(token)) : r;
  };
  async function createProduct(): Promise<string> {
    seq += 1;
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({ type: 'MEDICINE', genericName: `Generic${seq}`, manufacturerId, dosageForm: 'TABLET', strengthValue: 500, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `Product ${seq}`, price: 2_500 })
      .expect(201);
    return body(res).id as string;
  }
  const changeStatus = (id: string, status: string) =>
    request(ctx.server).post(`/admin/catalog/products/${id}/status`).set(...auth(admin.accessToken)).send({ status });
  async function productIn(status: string): Promise<string> {
    const id = await createProduct();
    if (status === 'PENDING_REVIEW') {
      await ctx.prisma.product.update({ where: { id }, data: { status: 'PENDING_REVIEW' } });
      return id;
    }
    if (status === 'DRAFT') return id;
    // Published only through review (Work 30): submit and approve, then the generic route.
    await request(ctx.server).post(`/admin/catalog/review/${id}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${id}/approve`).set(...auth(admin.accessToken)).expect(200);
    const rest: Record<string, string[]> = { ACTIVE: [], DEPRECATED: ['DEPRECATED'], DELISTED: ['DELISTED'] };
    for (const step of rest[status]) await changeStatus(id, step).expect(200);
    return id;
  }
  const approvals = (id: string) => ctx.prisma.auditLog.findMany({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: id } });
  const events = (id: string) => ctx.prisma.outbox.findMany({ where: { eventType: 'catalog.product.status_changed', aggregateId: id } });

  it('approves a PENDING_REVIEW product: → ACTIVE, every other column unchanged, one audit row and one event, no inventory created', async () => {
    const id = await productIn('PENDING_REVIEW');
    const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    const counts = async () => ({ listings: await ctx.prisma.inventoryListing.count(), pharmacies: await ctx.prisma.pharmacy.count(), batches: await ctx.prisma.stockBatch.count() });
    const inventoryBefore = await counts();

    const res = body(await approve(id).expect(200)) as Record<string, unknown>;

    const after = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    expect([before.status, after.status]).toEqual(['PENDING_REVIEW', 'ACTIVE']);
    const strip = (p: typeof before) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'status' && k !== 'updatedAt'));
    expect(strip(after)).toEqual(strip(before));
    expect(res).toMatchObject({ id, status: 'ACTIVE', price: 2_500, manufacturerId });
    expect(res).not.toHaveProperty('createdBy');
    expect(res).not.toHaveProperty('deletedAt');

    expect((await approvals(id)).map((a) => [a.actorUserId, a.resourceType, a.context])).toEqual([[admin.userId, 'Product', { from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null }]]);
    expect((await events(id)).map((e) => e.payload)).toEqual([
      expect.objectContaining({ type: 'catalog.product.status_changed', aggregateType: 'Product', aggregateId: id, payload: { productId: id, from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null } }),
    ]);
    // No Module 16 audit row of its own.
    expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN_CATALOG' } } })).toBe(0);
    expect(await counts()).toEqual(inventoryBefore);
  });

  it('DRAFT, ACTIVE, DEPRECATED and DELISTED → 409 CONFLICT; unchanged; no audit or event', async () => {
    for (const status of ['DRAFT', 'ACTIVE', 'DEPRECATED', 'DELISTED']) {
      const id = await productIn(status);
      const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
      const auditBefore = (await approvals(id)).length;
      const eventsBefore = (await events(id)).length;
      const res = await approve(id);
      expect({ status, http: res.status, code: res.body?.error?.code ?? res.body?.code }).toEqual({ status, http: 409, code: 'CONFLICT' });
      expect(await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect([(await approvals(id)).length, (await events(id)).length]).toEqual([auditBefore, eventsBefore]);
    }
  });

  it('unknown product → 404, malformed id → 400; nothing audited', async () => {
    const deleted = await productIn('PENDING_REVIEW');
    await ctx.prisma.product.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const auditBefore = await ctx.prisma.auditLog.count();
    await approve(randomUUID()).expect(404);
    await approve('not-a-uuid').expect(400);
    await approve(deleted).expect(404);
    expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
  });

  it('concurrent approvals: exactly one 200, the rest 409; one transition, one audit row, one event', async () => {
    const id = await productIn('PENDING_REVIEW');
    const results = await Promise.all(Array.from({ length: 6 }, () => approve(id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    expect((await approvals(id)).length).toBe(1);
    expect((await events(id)).length).toBe(1);
  });

  it('RBAC: 401 anonymous; 403 for other roles and for a read-only catalogue role; SUPER_ADMIN allowed', async () => {
    const id = await productIn('PENDING_REVIEW');
    expect((await approve(id, null)).status).toBe(401);
    for (const role of ['CUSTOMER', 'PHARMACY_OWNER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      expect({ role, status: (await approve(id, (await createUserWithRole(ctx, role)).accessToken)).status }).toEqual({ role, status: 403 });
    }
    for (const [key, permission] of [['CATALOG_READER_TEST', 'catalog:read:any'], ['ANALYTICS_VIEWER_TEST', 'analytics:read']]) {
      const p = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: permission } });
      const r = await ctx.prisma.role.upsert({ where: { key }, update: {}, create: { key, name: key, scope: 'PLATFORM' } });
      await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: p.id } }, update: {}, create: { roleId: r.id, permissionId: p.id } });
      expect({ key, status: (await approve(id, (await createUserWithRole(ctx, key)).accessToken)).status }).toEqual({ key, status: 403 });
    }
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');
    expect((await approvals(id)).length).toBe(0);
    await approve(id, (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
    const holders = await ctx.prisma.rolePermission.findMany({ where: { permission: { key: 'catalog:manage:any' } }, include: { role: { select: { key: true } } } });
    expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
  });

  it('Work 09’s GET /admin/catalog/review still works: the pending product is listed with ACTIVE allowed, and moves to ACTIVE when approved', async () => {
    const id = await productIn('PENDING_REVIEW');
    const list = async (status: string) =>
      (body(await request(ctx.server).get('/admin/catalog/review').query({ status }).set(...auth(admin.accessToken)).expect(200)) as unknown as { items: Array<{ id: string; status: string; allowedTransitions: string[] }> }).items;
    expect((await list('PENDING_REVIEW')).map((i) => [i.id, i.status, i.allowedTransitions])).toEqual([[id, 'PENDING_REVIEW', ['ACTIVE']]]);
    await approve(id).expect(200);
    expect(await list('PENDING_REVIEW')).toEqual([]);
    expect((await list('ACTIVE')).map((i) => i.id)).toEqual([id]);
    expect((await list('DRAFT')).map((i) => i.id)).toEqual([]);
  });

  it('privacy: the response carries the catalogue record only — no creator, supplier, pharmacy or person data', async () => {
    const id = await productIn('PENDING_REVIEW');
    const raw = JSON.stringify((await approve(id).expect(200)).body);
    const row = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    for (const secret of [row.createdBy, admin.userId, admin.phone].filter((v): v is string => !!v)) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/createdBy|deletedAt|supplier|pharmacy|listing|phone|email/i);
  });
});
