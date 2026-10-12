import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type History = { productId: string; history: Array<{ from: string | null; to: string | null; occurredAt: string; reason: string | null }> };
const REASON = 'Pack size does not match the registration';
const path = (id: string, action: string) => `/admin/catalog/review/${id}/${action}`;

/**
 * Module 16 Work 33 against real PostgreSQL: a product's review history, read back from the
 * `PRODUCT_STATUS_CHANGED` audit entries written by the real Works 28–32 workflow.
 */
describe('Admin catalogue review history (e2e)', () => {
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

  const post = (p: string) => request(ctx.server).post(p).set(...auth(admin.accessToken));
  const get = (id: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(path(id, 'history'));
    return token ? r.set(...auth(token)) : r;
  };
  const historyOf = async (id: string) => body(await get(id).expect(200)) as unknown as History;
  async function createDraft(): Promise<string> {
    seq += 1;
    return body(
      await post('/admin/catalog/products')
        .send({ type: 'MEDICINE', genericName: `Generic${seq}`, manufacturerId, dosageForm: 'TABLET', strengthValue: 20, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `History product ${seq}`, price: 600 })
        .expect(201),
    ).id as string;
  }
  /** create → submit → reject → correct → resubmit → approve, through the real routes; returns every response body. */
  async function fullCycle(id: string) {
    const bodies: unknown[] = [];
    bodies.push(body(await post(path(id, 'submit')).expect(200)));
    bodies.push(body(await post(path(id, 'reject')).send({ reason: `  ${REASON}  ` }).expect(200)));
    bodies.push(body(await request(ctx.server).patch(`/admin/catalog/products/${id}`).set(...auth(admin.accessToken)).send({ packSize: '30 tablets' }).expect(200)));
    bodies.push(body(await post(path(id, 'resubmit')).expect(200)));
    bodies.push(body(await post(path(id, 'approve')).expect(200)));
    return bodies;
  }

  it('a new product: 200 with an empty history', async () => {
    const id = await createDraft();
    expect(await historyOf(id)).toEqual({ productId: id, history: [] });
  });

  it('the real workflow, oldest first: four transitions, timestamps as recorded, the trimmed reason on the rejection only', async () => {
    const id = await createDraft();
    await fullCycle(id);
    const h = await historyOf(id);
    expect(h.productId).toBe(id);
    expect(h.history.map(({ from, to, reason }) => ({ from, to, reason }))).toEqual([
      { from: 'DRAFT', to: 'PENDING_REVIEW', reason: null },
      { from: 'PENDING_REVIEW', to: 'REJECTED', reason: REASON },
      { from: 'REJECTED', to: 'PENDING_REVIEW', reason: null },
      { from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null },
    ]);
    // Timestamps are the audit entries' own, in order.
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(h.history.map((e) => e.occurredAt)).toEqual(audits.map((a) => a.createdAt.toISOString()));
    const times = h.history.map((e) => Date.parse(e.occurredAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Only the four approved fields per entry.
    for (const e of h.history) expect(Object.keys(e)).toEqual(['from', 'to', 'occurredAt', 'reason']);
  });

  it('only this product’s status changes: its create/update audit entries and another product’s history are excluded; a non-review note is not a reason', async () => {
    const id = await createDraft();
    const other = await createDraft();
    await fullCycle(id);
    await post(path(other, 'submit')).expect(200);
    await post(path(other, 'reject')).send({ reason: 'Belongs to the other product' }).expect(200);
    // A later generic-route change with an operator note.
    await post(`/admin/catalog/products/${id}/status`).send({ status: 'DEPRECATED', reason: 'operator note' }).expect(200);
    expect(await ctx.prisma.auditLog.count({ where: { resourceId: id, action: { not: 'PRODUCT_STATUS_CHANGED' } } })).toBeGreaterThan(0); // created, updated
    const h = await historyOf(id);
    expect(h.history.map((e) => [e.to, e.reason])).toEqual([
      ['PENDING_REVIEW', null],
      ['REJECTED', REASON],
      ['PENDING_REVIEW', null],
      ['ACTIVE', null],
      ['DEPRECATED', null],
    ]);
    expect(JSON.stringify(h)).not.toContain('Belongs to the other product');
    expect((await historyOf(other)).history.map((e) => [e.to, e.reason])).toEqual([['PENDING_REVIEW', null], ['REJECTED', 'Belongs to the other product']]);
  });

  it('privacy: no actor, IP, hash or other context in the history; the reason is absent from every product response, the public view and search', async () => {
    const id = await createDraft();
    const responses = await fullCycle(id);
    const raw = JSON.stringify(await historyOf(id));
    const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: id } });
    for (const secret of [admin.userId, admin.phone, ...audits.flatMap((a) => [a.hash, a.prevHash ?? 'none', a.ip ?? 'none'])]) {
      if (secret === 'none') continue;
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/actorUserId|prevHash|"hash"|"ip"|createdBy/);
    const elsewhere = [
      ...responses.map((r) => JSON.stringify(r)), // submit, reject, update, resubmit, approve
      JSON.stringify(body(await request(ctx.server).get(`/admin/catalog/products/${id}`).set(...auth(admin.accessToken)).expect(200))),
      JSON.stringify(body(await request(ctx.server).get(`/catalog/products/${id}`).expect(200))),
      JSON.stringify(body(await request(ctx.server).get('/catalog/products').query({ q: 'History product' }).expect(200))),
      JSON.stringify(body(await request(ctx.server).get('/admin/catalog/review').query({ status: 'ACTIVE' }).set(...auth(admin.accessToken)).expect(200))),
    ];
    for (const text of elsewhere) expect(text).not.toContain(REASON);
  });

  it('read-only: reading writes no audit row or outbox event and leaves the product unchanged', async () => {
    const id = await createDraft();
    await fullCycle(id);
    const state = async () => ({
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
      product: await ctx.prisma.product.findUniqueOrThrow({ where: { id } }),
    });
    const before = await state();
    for (let i = 0; i < 3; i++) await historyOf(id);
    expect(await state()).toEqual(before);
    expect(before.product.status).toBe('ACTIVE');
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect({ method, status: (await request(ctx.server)[method](path(id, 'history')).set(...auth(admin.accessToken)).send({})).status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('unknown or soft-deleted product → 404; malformed id → 400', async () => {
    const deleted = await createDraft();
    await ctx.prisma.product.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    await get(randomUUID()).expect(404);
    await get(deleted).expect(404);
    await get('not-a-uuid').expect(400);
  });

  it('RBAC: 401 anonymous; 403 for other roles, a read-only catalogue role and an audit-reader-only role; SUPER_ADMIN allowed', async () => {
    const id = await createDraft();
    expect((await get(id, null)).status).toBe(401);
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      expect({ role, status: (await get(id, (await createUserWithRole(ctx, role)).accessToken)).status }).toEqual({ role, status: 403 });
    }
    for (const [key, permission] of [['CATALOG_READER_TEST', 'catalog:read:any'], ['AUDIT_READER_TEST', 'audit:read:any']]) {
      const p = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: permission } });
      const r = await ctx.prisma.role.upsert({ where: { key }, update: {}, create: { key, name: key, scope: 'PLATFORM' } });
      await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: p.id } }, update: {}, create: { roleId: r.id, permissionId: p.id } });
      expect({ key, status: (await get(id, (await createUserWithRole(ctx, key)).accessToken)).status }).toEqual({ key, status: 403 });
    }
    await get(id, (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
  });
});
