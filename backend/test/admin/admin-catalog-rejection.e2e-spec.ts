import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
const REASON = 'Duplicate of an existing catalogue entry';
const path = (id: string, action: 'submit' | 'approve' | 'reject') => `/admin/catalog/review/${id}/${action}`;

/**
 * Module 16 Work 31 against real PostgreSQL (with the `REJECTED` enum migration applied by
 * `prisma migrate deploy`): rejecting a product under catalogue review, through Module 03's own
 * status command — create → submit → reject — with no direct database writes.
 */
describe('Admin catalogue review rejection (e2e)', () => {
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

  const post = (p: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).post(p);
    return token ? r.set(...auth(token)) : r;
  };
  const reject = (id: string, payload: object = { reason: REASON }, token: string | null = admin.accessToken) => post(path(id, 'reject'), token).send(payload);
  async function createDraft(): Promise<string> {
    seq += 1;
    return body(
      await post('/admin/catalog/products')
        .send({ type: 'MEDICINE', genericName: `Generic${seq}`, manufacturerId, dosageForm: 'TABLET', strengthValue: 100, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `Reject product ${seq}`, price: 700 })
        .expect(201),
    ).id as string;
  }
  async function productIn(status: string): Promise<string> {
    const id = await createDraft();
    if (status === 'DRAFT') return id;
    await post(path(id, 'submit')).expect(200);
    if (status === 'PENDING_REVIEW') return id;
    if (status === 'REJECTED') {
      await reject(id).expect(200);
      return id;
    }
    await post(path(id, 'approve')).expect(200);
    for (const step of { ACTIVE: [], DEPRECATED: ['DEPRECATED'], DELISTED: ['DELISTED'] }[status] as string[]) {
      await post(`/admin/catalog/products/${id}/status`).send({ status: step }).expect(200);
    }
    return id;
  }
  const changes = (id: string) => ctx.prisma.auditLog.findMany({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: id }, orderBy: { createdAt: 'asc' } });
  const events = (id: string) => ctx.prisma.outbox.findMany({ where: { eventType: 'catalog.product.status_changed', aggregateId: id }, orderBy: { createdAt: 'asc' } });
  const review = async (status: string) =>
    (body(await request(ctx.server).get('/admin/catalog/review').query({ status }).set(...auth(admin.accessToken)).expect(200)) as unknown as { items: Array<{ id: string; allowedTransitions: string[] }> }).items;

  it('the migration is applied: the database enum carries REJECTED', async () => {
    const labels = await ctx.prisma.$queryRaw<Array<{ label: string }>>`
      SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ProductStatus' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.label)).toEqual(['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'DEPRECATED', 'DELISTED', 'REJECTED']);
  });

  it('create → submit → reject: PENDING_REVIEW → REJECTED, only the status changes, one audit row and one event with the trimmed reason, off the review queue, no inventory', async () => {
    const inventory = async () => [await ctx.prisma.inventoryListing.count(), await ctx.prisma.pharmacy.count(), await ctx.prisma.stockBatch.count(), await ctx.prisma.stockReservation.count()];
    const inventoryBefore = await inventory();
    const id = await productIn('PENDING_REVIEW');
    expect((await review('PENDING_REVIEW')).map((i) => [i.id, i.allowedTransitions])).toEqual([[id, ['ACTIVE', 'REJECTED']]]);
    const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    const [auditsBefore, eventsBefore] = [(await changes(id)).length, (await events(id)).length];

    const res = body(await reject(id, { reason: `   ${REASON}   ` }).expect(200)) as Record<string, unknown>;
    expect(res).toMatchObject({ id, status: 'REJECTED' });

    const after = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    const strip = (p: typeof before) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'status' && k !== 'updatedAt'));
    expect([before.status, after.status]).toEqual(['PENDING_REVIEW', 'REJECTED']);
    expect(strip(after)).toEqual(strip(before));

    const audits = await changes(id);
    expect(audits).toHaveLength(auditsBefore + 1);
    expect([audits.at(-1)!.actorUserId, audits.at(-1)!.context]).toEqual([admin.userId, { from: 'PENDING_REVIEW', to: 'REJECTED', reason: REASON }]);
    const published = await events(id);
    expect(published).toHaveLength(eventsBefore + 1);
    expect((published.at(-1)!.payload as { payload: unknown }).payload).toEqual({ productId: id, from: 'PENDING_REVIEW', to: 'REJECTED', reason: REASON });
    expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN_CATALOG' } } })).toBe(0);

    expect(await review('PENDING_REVIEW')).toEqual([]);
    expect((await review('REJECTED')).map((i) => [i.id, i.allowedTransitions])).toEqual([[id, []]]);
    expect(await inventory()).toEqual(inventoryBefore);
  });

  it('the reason is never exposed by product responses: not in the reject response, the admin detail, or the public catalogue (where the product is not visible at all)', async () => {
    const id = await productIn('PENDING_REVIEW');
    const raw = JSON.stringify((await reject(id).expect(200)).body);
    const detail = JSON.stringify((await request(ctx.server).get(`/admin/catalog/products/${id}`).set(...auth(admin.accessToken)).expect(200)).body);
    const pub = await request(ctx.server).get(`/catalog/products/${id}`);
    expect(pub.status).toBe(404);
    const search = JSON.stringify((await request(ctx.server).get('/catalog/products').query({ q: 'Reject product' }).expect(200)).body);
    for (const text of [raw, detail, JSON.stringify(pub.body), search]) {
      expect(text).not.toContain(REASON);
      expect(text).not.toMatch(/createdBy|rejectReason|"reason"/);
    }
    expect(search).not.toContain(id);
  });

  it('reason validation: missing, blank, whitespace-only, too short, too long, non-string and extra fields → 400; nothing changes', async () => {
    const id = await productIn('PENDING_REVIEW');
    const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    const audits = (await changes(id)).length;
    for (const payload of [{}, { reason: '' }, { reason: '     ' }, { reason: ' ab ' }, { reason: 'x'.repeat(301) }, { reason: 7 }, { reason: REASON, status: 'ACTIVE' }]) {
      const res = await reject(id, payload);
      expect({ payload, status: res.status, code: res.body?.error?.code ?? res.body?.code }).toEqual({ payload, status: 400, code: 'VALIDATION_ERROR' });
    }
    expect(await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect((await changes(id)).length).toBe(audits);
  });

  it('DRAFT, ACTIVE, DEPRECATED, DELISTED and REJECTED → 422 INVALID_PRODUCT_STATUS_TRANSITION; unchanged; no audit row or event', async () => {
    for (const status of ['DRAFT', 'ACTIVE', 'DEPRECATED', 'DELISTED', 'REJECTED']) {
      const id = await productIn(status);
      const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
      const [a, e] = [(await changes(id)).length, (await events(id)).length];
      const res = await reject(id);
      expect({ status, http: res.status, code: res.body?.error?.code ?? res.body?.code }).toEqual({ status, http: 422, code: 'INVALID_PRODUCT_STATUS_TRANSITION' });
      expect(await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect([(await changes(id)).length, (await events(id)).length]).toEqual([a, e]);
    }
  });

  it('unknown or soft-deleted product → 404, malformed id → 400; nothing audited', async () => {
    const deleted = await productIn('PENDING_REVIEW');
    await ctx.prisma.product.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const auditBefore = await ctx.prisma.auditLog.count();
    await reject(randomUUID()).expect(404);
    await reject('not-a-uuid').expect(400);
    await reject(deleted).expect(404);
    expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
  });

  it('concurrent rejections: exactly one 200; the rest refused; one transition, one audit row, one event', async () => {
    const id = await productIn('PENDING_REVIEW');
    const [a, e] = [(await changes(id)).length, (await events(id)).length];
    const results = await Promise.all(Array.from({ length: 6 }, () => reject(id)));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.every((c) => c === 200 || c === 422 || c === 409)).toBe(true);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('REJECTED');
    expect([(await changes(id)).length, (await events(id)).length]).toEqual([a + 1, e + 1]);
  });

  it('no bypass: the generic status route refuses REJECTED (400), with or without a reason; the product stays under review', async () => {
    const id = await productIn('PENDING_REVIEW');
    for (const payload of [{ status: 'REJECTED' }, { status: 'REJECTED', reason: REASON }]) {
      expect((await post(`/admin/catalog/products/${id}/status`).send(payload)).status).toBe(400);
    }
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');
  });

  it('Works 28 and 29 still work; a rejected product cannot then be approved (409) or resubmitted (409)', async () => {
    const approved = await productIn('PENDING_REVIEW');
    expect(body(await post(path(approved, 'approve')).expect(200))).toMatchObject({ status: 'ACTIVE' });
    const rejected = await productIn('REJECTED');
    await post(path(rejected, 'approve')).expect(409);
    await post(path(rejected, 'submit')).expect(409);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id: rejected } })).status).toBe('REJECTED');
  });

  it('RBAC: 401 anonymous; 403 for other roles and a read-only catalogue role; SUPER_ADMIN allowed', async () => {
    const id = await productIn('PENDING_REVIEW');
    expect((await reject(id, { reason: REASON }, null)).status).toBe(401);
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      expect({ role, status: (await reject(id, { reason: REASON }, (await createUserWithRole(ctx, role)).accessToken)).status }).toEqual({ role, status: 403 });
    }
    const read = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'catalog:read:any' } });
    const reader = await ctx.prisma.role.upsert({ where: { key: 'CATALOG_READER_TEST' }, update: {}, create: { key: 'CATALOG_READER_TEST', name: 'Catalog reader (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: reader.id, permissionId: read.id } }, update: {}, create: { roleId: reader.id, permissionId: read.id } });
    expect((await reject(id, { reason: REASON }, (await createUserWithRole(ctx, 'CATALOG_READER_TEST')).accessToken)).status).toBe(403);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');
    await reject(id, { reason: REASON }, (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
  });
});
