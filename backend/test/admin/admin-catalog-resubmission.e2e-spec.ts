import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
const REASON = 'Strength and pack size are missing';
const path = (id: string, action: 'submit' | 'approve' | 'reject' | 'resubmit') => `/admin/catalog/review/${id}/${action}`;

/**
 * Module 16 Work 32 against real PostgreSQL: correcting and resubmitting a rejected product, through
 * application routes only — create → submit → reject → correct (Module 03's existing update) →
 * resubmit → approve.
 */
describe('Admin catalogue review resubmission (e2e)', () => {
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
  async function createDraft(): Promise<string> {
    seq += 1;
    return body(
      await post('/admin/catalog/products')
        .send({ type: 'MEDICINE', genericName: `Generic${seq}`, manufacturerId, dosageForm: 'TABLET', strengthValue: 50, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `Resubmit product ${seq}`, price: 1_100 })
        .expect(201),
    ).id as string;
  }
  async function productIn(status: string): Promise<string> {
    const id = await createDraft();
    if (status === 'DRAFT') return id;
    await post(path(id, 'submit')).expect(200);
    if (status === 'PENDING_REVIEW') return id;
    if (status === 'REJECTED') {
      await post(path(id, 'reject')).send({ reason: REASON }).expect(200);
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
  const inventory = async () => [await ctx.prisma.inventoryListing.count(), await ctx.prisma.pharmacy.count(), await ctx.prisma.stockBatch.count(), await ctx.prisma.stockReservation.count(), await ctx.prisma.stockMovement.count()];

  it('the complete lifecycle: create → submit → reject → correct → resubmit → approve; four transitions, four audit rows, four events, no inventory', async () => {
    const inventoryBefore = await inventory();
    // 1. Created through the established creation endpoint.
    const id = await createDraft();
    // 2. Submit.
    expect(body(await post(path(id, 'submit')).expect(200))).toMatchObject({ status: 'PENDING_REVIEW' });
    // 3. Reject with a valid reason.
    expect(body(await post(path(id, 'reject')).send({ reason: REASON }).expect(200))).toMatchObject({ status: 'REJECTED' });
    // 4. Listed under REJECTED (resubmission allowed), gone from the pending queue.
    expect((await review('REJECTED')).map((i) => [i.id, i.allowedTransitions])).toEqual([[id, ['PENDING_REVIEW']]]);
    expect(await review('PENDING_REVIEW')).toEqual([]);
    // 5. Corrected through Module 03's existing update — a REJECTED product is editable as any other.
    const corrected = body(await request(ctx.server).patch(`/admin/catalog/products/${id}`).set(...auth(admin.accessToken)).send({ strengthValue: 100, packSize: '30 tablets' }).expect(200));
    expect(corrected).toMatchObject({ status: 'REJECTED', strengthValue: 100, packSize: '30 tablets' });
    // 6. Resubmit — status only; the correction is kept.
    const beforeResubmit = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    expect(body(await post(path(id, 'resubmit')).expect(200))).toMatchObject({ id, status: 'PENDING_REVIEW', strengthValue: 100, packSize: '30 tablets' });
    const afterResubmit = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
    const strip = (p: typeof beforeResubmit) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'status' && k !== 'updatedAt'));
    expect(strip(afterResubmit)).toEqual(strip(beforeResubmit));
    // 7. Back in the pending queue.
    expect((await review('PENDING_REVIEW')).map((i) => [i.id, i.allowedTransitions])).toEqual([[id, ['ACTIVE', 'REJECTED']]]);
    expect(await review('REJECTED')).toEqual([]);
    // 8–9. Approve: ACTIVE, out of the queue.
    expect(body(await post(path(id, 'approve')).expect(200))).toMatchObject({ status: 'ACTIVE' });
    expect(await review('PENDING_REVIEW')).toEqual([]);
    expect((await review('ACTIVE')).map((i) => i.id)).toEqual([id]);
    // 10. Exactly four status changes — one audit row and one event each, in order.
    const transitions = [
      { from: 'DRAFT', to: 'PENDING_REVIEW', reason: null },
      { from: 'PENDING_REVIEW', to: 'REJECTED', reason: REASON },
      { from: 'REJECTED', to: 'PENDING_REVIEW', reason: null },
      { from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null },
    ];
    expect((await changes(id)).map((a) => a.context)).toEqual(transitions);
    expect((await events(id)).map((e) => {
      const { from, to, reason } = (e.payload as { payload: { from: string; to: string; reason: string | null } }).payload;
      return { from, to, reason };
    })).toEqual(transitions);
    expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN_CATALOG' } } })).toBe(0);
    // 11. Nothing in Module 04.
    expect(await inventory()).toEqual(inventoryBefore);
  });

  it('DRAFT, PENDING_REVIEW, ACTIVE, DEPRECATED and DELISTED → 422 INVALID_PRODUCT_STATUS_TRANSITION; unchanged; no audit row or event', async () => {
    for (const status of ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'DEPRECATED', 'DELISTED']) {
      const id = await productIn(status);
      const before = await ctx.prisma.product.findUniqueOrThrow({ where: { id } });
      const [a, e] = [(await changes(id)).length, (await events(id)).length];
      const res = await post(path(id, 'resubmit'));
      expect({ status, http: res.status, code: res.body?.error?.code ?? res.body?.code }).toEqual({ status, http: 422, code: 'INVALID_PRODUCT_STATUS_TRANSITION' });
      expect(await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect([(await changes(id)).length, (await events(id)).length]).toEqual([a, e]);
    }
  });

  it('unknown or soft-deleted product → 404, malformed id → 400; nothing audited', async () => {
    const deleted = await productIn('REJECTED');
    await ctx.prisma.product.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const auditBefore = await ctx.prisma.auditLog.count();
    await post(path(randomUUID(), 'resubmit')).expect(404);
    await post(path('not-a-uuid', 'resubmit')).expect(400);
    await post(path(deleted, 'resubmit')).expect(404);
    expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
  });

  it('concurrent resubmissions: exactly one 200; the rest refused; one transition, one audit row, one event', async () => {
    const id = await productIn('REJECTED');
    const [a, e] = [(await changes(id)).length, (await events(id)).length];
    const results = await Promise.all(Array.from({ length: 6 }, () => post(path(id, 'resubmit'))));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.every((c) => c === 200 || c === 422 || c === 409)).toBe(true);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING_REVIEW');
    expect([(await changes(id)).length, (await events(id)).length]).toEqual([a + 1, e + 1]);
  });

  it('no bypass: the generic status route cannot resubmit (PENDING_REVIEW → 400) or publish a rejected product (ACTIVE → 422); Work 29 submit refuses it (409)', async () => {
    const id = await productIn('REJECTED');
    expect((await post(`/admin/catalog/products/${id}/status`).send({ status: 'PENDING_REVIEW' })).status).toBe(400);
    const direct = await post(`/admin/catalog/products/${id}/status`).send({ status: 'ACTIVE' });
    expect([direct.status, direct.body?.error?.code ?? direct.body?.code]).toEqual([422, 'INVALID_PRODUCT_STATUS_TRANSITION']);
    await post(path(id, 'submit')).expect(409);
    await post(path(id, 'approve')).expect(409);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('REJECTED');
  });

  it('privacy: the earlier rejection reason never appears in product responses — resubmit, admin detail or public catalogue', async () => {
    const id = await productIn('REJECTED');
    const resubmitted = JSON.stringify((await post(path(id, 'resubmit')).expect(200)).body);
    await post(path(id, 'approve')).expect(200);
    const detail = JSON.stringify((await request(ctx.server).get(`/admin/catalog/products/${id}`).set(...auth(admin.accessToken)).expect(200)).body);
    const pub = JSON.stringify((await request(ctx.server).get(`/catalog/products/${id}`).expect(200)).body);
    for (const text of [resubmitted, detail, pub]) {
      expect(text).not.toContain(REASON);
      expect(text).not.toMatch(/createdBy|rejectReason|"reason"/);
    }
  });

  it('RBAC: 401 anonymous; 403 for other roles and a read-only catalogue role; SUPER_ADMIN allowed', async () => {
    const id = await productIn('REJECTED');
    expect((await post(path(id, 'resubmit'), null)).status).toBe(401);
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      expect({ role, status: (await post(path(id, 'resubmit'), (await createUserWithRole(ctx, role)).accessToken)).status }).toEqual({ role, status: 403 });
    }
    const read = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'catalog:read:any' } });
    const reader = await ctx.prisma.role.upsert({ where: { key: 'CATALOG_READER_TEST' }, update: {}, create: { key: 'CATALOG_READER_TEST', name: 'Catalog reader (test)', scope: 'PLATFORM' } });
    await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: reader.id, permissionId: read.id } }, update: {}, create: { roleId: reader.id, permissionId: read.id } });
    expect((await post(path(id, 'resubmit'), (await createUserWithRole(ctx, 'CATALOG_READER_TEST')).accessToken)).status).toBe(403);
    expect((await ctx.prisma.product.findUniqueOrThrow({ where: { id } })).status).toBe('REJECTED');
    await post(path(id, 'resubmit'), (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
  });
});
