import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Summary = {
  generatedAt: string;
  queue: { pendingReviewCount: number; pendingWithoutRecordedSubmission: number; oldestPendingSubmittedAt: string | null; oldestPendingAgeSeconds: number | null };
  lifetimeTransitions: { approvals: number; rejections: number; resubmissions: number };
};
const SUMMARY = '/admin/catalog/review/summary';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const path = (id: string, action: string) => `/admin/catalog/review/${id}/${action}`;

/**
 * Module 16 Work 34 against real PostgreSQL: the catalogue review summary, computed from the real
 * `products` rows and the `PRODUCT_STATUS_CHANGED` entries the Works 28–32 routes wrote.
 */
describe('Admin catalogue review summary (e2e)', () => {
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
  const get = (token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(SUMMARY);
    return token ? r.set(...auth(token)) : r;
  };
  const summary = async () => body(await get().expect(200)) as unknown as Summary;
  async function createDraft(): Promise<string> {
    seq += 1;
    return body(
      await post('/admin/catalog/products')
        .send({ type: 'MEDICINE', genericName: `Generic${seq}`, manufacturerId, dosageForm: 'TABLET', strengthValue: 10, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: `Summary product ${seq}`, price: 400 })
        .expect(201),
    ).id as string;
  }
  const submit = (id: string) => post(path(id, 'submit')).expect(200);
  const approve = (id: string) => post(path(id, 'approve')).expect(200);
  const reject = (id: string) => post(path(id, 'reject')).send({ reason: 'Needs another look' }).expect(200);
  const resubmit = (id: string) => post(path(id, 'resubmit')).expect(200);
  /** Move this product's recorded entries into PENDING_REVIEW back in time (fixture only). */
  async function backdateEntriesIntoReview(id: string, at: Date, which: 'all' | 'first' = 'all') {
    const entries = await ctx.prisma.auditLog.findMany({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: id }, orderBy: { createdAt: 'asc' } });
    const into = entries.filter((e) => (e.context as { to?: string } | null)?.to === 'PENDING_REVIEW');
    for (const e of which === 'first' ? into.slice(0, 1) : into) await ctx.prisma.auditLog.update({ where: { id: e.id }, data: { createdAt: at } });
  }

  async function seedAll() {
    const now = Date.now();
    // A — waiting since its submission, an hour ago.
    const a = await createDraft();
    await submit(a);
    await backdateEntriesIntoReview(a, new Date(now - HOUR));
    // B — submitted 10 days ago, rejected, resubmitted just now: waiting since the resubmission.
    const b = await createDraft();
    await submit(b);
    await backdateEntriesIntoReview(b, new Date(now - 10 * DAY), 'first');
    await reject(b);
    await resubmit(b);
    // C — approved, then DEPRECATED -> ACTIVE on the generic route (not an approval).
    const c = await createDraft();
    await submit(c);
    await approve(c);
    await post(`/admin/catalog/products/${c}/status`).send({ status: 'DEPRECATED' }).expect(200);
    await post(`/admin/catalog/products/${c}/status`).send({ status: 'ACTIVE' }).expect(200);
    // D — rejected and left so.
    const d = await createDraft();
    await submit(d);
    await reject(d);
    // E — waiting since 30 days ago, then soft-deleted: out of the queue.
    const e = await createDraft();
    await submit(e);
    await backdateEntriesIntoReview(e, new Date(now - 30 * DAY));
    await ctx.prisma.product.update({ where: { id: e }, data: { deletedAt: new Date() } });
    // F — PENDING_REVIEW with no recorded entry (placed directly): counted, never aged.
    const f = await createDraft();
    await ctx.prisma.product.update({ where: { id: f }, data: { status: 'PENDING_REVIEW' } });
    // G — the same product through review three times: every transition counts.
    const g = await createDraft();
    await submit(g);
    await reject(g);
    await resubmit(g);
    await reject(g);
    await resubmit(g);
    await approve(g);
    // Entries that must match nothing: malformed context, and the same transition on another resource type.
    const hashFields = { hash: 'fixture', prevHash: null };
    await ctx.prisma.auditLog.create({ data: { action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: a, context: undefined, ...hashFields } });
    await ctx.prisma.auditLog.create({ data: { action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: a, context: 'PENDING_REVIEW->ACTIVE', ...hashFields } });
    await ctx.prisma.auditLog.create({ data: { action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: a, context: { from: ['PENDING_REVIEW'], to: 'ACTIVE' }, ...hashFields } });
    await ctx.prisma.auditLog.create({ data: { action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Category', resourceId: a, context: { from: 'PENDING_REVIEW', to: 'ACTIVE' }, ...hashFields } });
    await ctx.prisma.auditLog.create({ data: { action: 'PRODUCT_UPDATED', resourceType: 'Product', resourceId: a, context: { from: 'PENDING_REVIEW', to: 'REJECTED' }, ...hashFields } });
    return { a, b, c, d, e, f, g, now };
  }

  it('an empty catalogue: zero counts, null timestamp and age', async () => {
    expect(await summary()).toEqual({
      generatedAt: expect.any(String),
      queue: { pendingReviewCount: 0, pendingWithoutRecordedSubmission: 0, oldestPendingSubmittedAt: null, oldestPendingAgeSeconds: null },
      lifetimeTransitions: { approvals: 0, rejections: 0, resubmissions: 0 },
    });
  });

  it('the summary of a real workflow: the queue (resubmission resets the wait; deleted excluded; unrecorded counted not aged) and exact transition counts', async () => {
    const { a, now } = await seedAll();
    const s = await summary();
    const aEntry = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceId: a, context: { path: ['to'], equals: 'PENDING_REVIEW' } } });
    expect(s.queue).toEqual({
      pendingReviewCount: 3, // A, B, F
      pendingWithoutRecordedSubmission: 1, // F
      oldestPendingSubmittedAt: aEntry.createdAt.toISOString(), // A's hour, not B's 10 days or E's 30
      oldestPendingAgeSeconds: Math.floor((Date.parse(s.generatedAt) - +aEntry.createdAt) / 1000),
    });
    expect(s.queue.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(HOUR / 1000);
    expect(s.queue.oldestPendingAgeSeconds).toBeLessThan((Date.now() - now + HOUR) / 1000 + 5);
    // approvals: C, G; rejections: B, D, G×2; resubmissions: B, G×2.
    expect(s.lifetimeTransitions).toEqual({ approvals: 2, rejections: 4, resubmissions: 3 });
  });

  it('cross-check against the persisted rows: the counts and the oldest wait equal what the audit and product tables hold', async () => {
    await seedAll();
    const s = await summary();
    const entries = await ctx.prisma.auditLog.findMany({ where: { action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product' } });
    const pair = (from: string, to: string) =>
      entries.filter((e) => {
        const c = e.context as { from?: unknown; to?: unknown } | null;
        return !!c && typeof c === 'object' && c.from === from && c.to === to;
      }).length;
    expect(s.lifetimeTransitions).toEqual({ approvals: pair('PENDING_REVIEW', 'ACTIVE'), rejections: pair('PENDING_REVIEW', 'REJECTED'), resubmissions: pair('REJECTED', 'PENDING_REVIEW') });
    const pending = await ctx.prisma.product.findMany({ where: { status: 'PENDING_REVIEW', deletedAt: null } });
    const waits = pending.map((p) =>
      entries
        .filter((e) => e.resourceId === p.id && (e.context as { to?: unknown } | null)?.to === 'PENDING_REVIEW')
        .map((e) => +e.createdAt)
        .reduce<number | null>((latest, t) => (latest === null || t > latest ? t : latest), null),
    );
    const recorded = waits.filter((w): w is number => w !== null);
    expect(s.queue.pendingReviewCount).toBe(pending.length);
    expect(s.queue.pendingWithoutRecordedSubmission).toBe(waits.length - recorded.length);
    expect(s.queue.oldestPendingSubmittedAt).toBe(new Date(Math.min(...recorded)).toISOString());
  });

  it('read-only: audit rows, outbox and every product are unchanged by reads; other methods are 404; Work 09 and Work 33 still answer', async () => {
    const { b } = await seedAll();
    const state = async () => ({
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
      products: await ctx.prisma.product.findMany({ orderBy: { id: 'asc' } }),
    });
    const before = await state();
    for (let i = 0; i < 3; i++) await summary();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect({ method, status: (await request(ctx.server)[method](SUMMARY).set(...auth(admin.accessToken)).send({})).status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
    const list = body(await request(ctx.server).get('/admin/catalog/review').query({ status: 'PENDING_REVIEW' }).set(...auth(admin.accessToken)).expect(200)) as unknown as { total: number };
    expect(list.total).toBe(3);
    const history = body(await request(ctx.server).get(path(b, 'history')).set(...auth(admin.accessToken)).expect(200)) as unknown as { history: Array<{ to: string }> };
    expect(history.history.map((h) => h.to)).toEqual(['PENDING_REVIEW', 'REJECTED', 'PENDING_REVIEW']);
  });

  it('privacy: aggregates only — no product id, actor, reason, hash or IP', async () => {
    const ids = await seedAll();
    const raw = JSON.stringify((await get().expect(200)).body);
    for (const secret of [ids.a, ids.b, ids.c, ids.d, ids.e, ids.f, ids.g, admin.userId, 'Needs another look', 'fixture']) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/productId|actor|reason|hash|"ip"/i);
  });

  it('RBAC: 401 anonymous; 403 for other roles, a read-only catalogue role and an audit-reader-only role; SUPER_ADMIN allowed', async () => {
    expect((await get(null)).status).toBe(401);
    for (const role of ['PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER', 'CUSTOMER_SUPPORT', 'FINANCE_OFFICER']) {
      expect({ role, status: (await get((await createUserWithRole(ctx, role)).accessToken)).status }).toEqual({ role, status: 403 });
    }
    for (const [key, permission] of [['CATALOG_READER_TEST', 'catalog:read:any'], ['AUDIT_READER_TEST', 'audit:read:any']]) {
      const p = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: permission } });
      const r = await ctx.prisma.role.upsert({ where: { key }, update: {}, create: { key, name: key, scope: 'PLATFORM' } });
      await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: p.id } }, update: {}, create: { roleId: r.id, permissionId: p.id } });
      expect({ key, status: (await get((await createUserWithRole(ctx, key)).accessToken)).status }).toEqual({ key, status: 403 });
    }
    await get((await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken).expect(200);
  });
});
