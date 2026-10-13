import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Summary = {
  generatedAt: string;
  collections: { total: number; byStatus: Record<string, number>; outstandingCount: number; oldestOutstandingCollectedAt: string | null; oldestOutstandingAgeSeconds: number | null };
  exceptions: { discrepancyCount: number; reconciliationDiscrepancyCount: number; collectionsWithCorrectionsCount: number; collectionsWithOpenDisputesCount: number; openDisputeCount: number };
};
const PATH = '/admin/operations/cod/summary';

/**
 * Module 16 Work 39 against real PostgreSQL: the COD exception and aging summary — counts and
 * timestamps over Module 08's collections, remittances, reconciliations, corrections and disputes.
 */
describe('Admin COD exception summary (e2e)', () => {
  let ctx: TestContext;
  let admin: User;
  let driverUser: User;
  let driverId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    driverUser = await createUserWithRole(ctx, 'DRIVER');
    driverId = (await ctx.prisma.driverProfile.create({ data: { userId: driverUser.userId, plateNumber: 'AA-3-PLATE-66' } })).id;
  });

  const get = (token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(PATH);
    return token ? r.set(...auth(token)) : r;
  };
  const summary = async (token = admin.accessToken) => body(await get(token).expect(200)) as unknown as Summary;
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  async function collection(o: { collectedAt: Date; expected: number; collected: number; status?: string }) {
    const job = await ctx.prisma.deliveryJob.create({
      data: { orderId: randomUUID(), fulfillmentId: randomUUID(), pharmacyId: randomUUID(), branchId: randomUUID(), assignedDriverId: driverId, status: 'DELIVERED', isCod: true, codAmount: o.expected, dropoffAddress: 'Bole Road 42' },
    });
    return ctx.prisma.codCollection.create({
      data: {
        jobId: job.id, driverId, orderId: job.orderId, fulfillmentId: job.fulfillmentId, expectedAmount: o.expected, collectedAmount: o.collected,
        method: 'CASH', status: (o.status ?? 'COLLECTED') as never, providerReference: 'TXN-SECRET', settlementRef: 'SETTLE-SECRET', collectedAt: o.collectedAt,
      },
    });
  }
  const remit = (collectionId: string, amount: number) =>
    ctx.prisma.codRemittance.create({ data: { collectionId, remittedAmount: amount, reference: 'SLIP-SECRET', note: 'counted by Kebede', confirmedByUserId: admin.userId } });
  const reconcile = (collectionId: string, outcome: 'ACCEPTED' | 'DISCREPANCY') =>
    ctx.prisma.codReconciliation.create({ data: { collectionId, outcome, note: 'see Almaz', reference: 'RUN-SECRET', reconciledByUserId: admin.userId } });
  const correct = (collectionId: string) =>
    ctx.prisma.codCorrection.create({ data: { collectionId, type: 'ADMINISTRATIVE_ADJUSTMENT', reason: 'per phone +251911', idempotencyKey: `idem-${randomUUID()}`, createdByUserId: admin.userId } });
  const dispute = (collectionId: string, status: 'OPEN' | 'RESOLVED') =>
    ctx.prisma.codDispute.create({ data: { collectionId, reason: 'customer says paid', status, openedByUserId: admin.userId, ...(status === 'RESOLVED' ? { resolvedAt: new Date(), resolvedByUserId: admin.userId } : {}) } });

  /**
   * Six collections chosen so every condition overlaps another somewhere:
   *  a  COLLECTED, short at collection (variance), oldest outstanding, 2 corrections, 1 OPEN + 2 RESOLVED disputes
   *  b  COLLECTED, exact, no legs
   *  c  REMITTED, exact collection but short remittance (remittance variance), 1 OPEN + 1 RESOLVED dispute
   *  d  RECONCILED ACCEPTED, all exact, 1 correction
   *  e  RECONCILED DISCREPANCY recorded although every amount matches (finding ≠ variance)
   *  f  RECONCILED ACCEPTED but collection was short (variance without a DISCREPANCY finding), 1 RESOLVED dispute
   *
   * At most one dispute per collection can be OPEN — a partial unique index on `cod_disputes(collectionId)
   * WHERE status = 'OPEN'` (Module 08's "one open dispute at a time"), asserted in its own test below.
   */
  async function seedSet() {
    const a = await collection({ collectedAt: t(600), expected: 10_000, collected: 9_000 });
    const b = await collection({ collectedAt: t(30), expected: 5_000, collected: 5_000 });
    const c = await collection({ collectedAt: t(300), expected: 7_000, collected: 7_000, status: 'REMITTED' });
    await remit(c.id, 6_500);
    const d = await collection({ collectedAt: t(900), expected: 4_000, collected: 4_000, status: 'RECONCILED' });
    await remit(d.id, 4_000);
    await reconcile(d.id, 'ACCEPTED');
    const e = await collection({ collectedAt: t(800), expected: 3_000, collected: 3_000, status: 'RECONCILED' });
    await remit(e.id, 3_000);
    await reconcile(e.id, 'DISCREPANCY');
    const f = await collection({ collectedAt: t(700), expected: 2_000, collected: 1_500, status: 'RECONCILED' });
    await remit(f.id, 1_500);
    await reconcile(f.id, 'ACCEPTED');
    await correct(a.id);
    await correct(a.id);
    await correct(d.id);
    await dispute(a.id, 'RESOLVED');
    await dispute(a.id, 'RESOLVED');
    await dispute(a.id, 'OPEN');
    await dispute(c.id, 'OPEN');
    await dispute(c.id, 'RESOLVED');
    await dispute(f.id, 'RESOLVED');
    return { a, b, c, d, e, f };
  }

  it('empty dataset: zeros, every status zero-filled, oldest timestamp and age null', async () => {
    const s = await summary();
    expect(Date.parse(s.generatedAt)).not.toBeNaN();
    expect(s.collections).toEqual({ total: 0, byStatus: { COLLECTED: 0, REMITTED: 0, RECONCILED: 0 }, outstandingCount: 0, oldestOutstandingCollectedAt: null, oldestOutstandingAgeSeconds: null });
    expect(s.exceptions).toEqual({ discrepancyCount: 0, reconciliationDiscrepancyCount: 0, collectionsWithCorrectionsCount: 0, collectionsWithOpenDisputesCount: 0, openDisputeCount: 0 });
  });

  it('mixed dataset: the expected figures, and each one cross-checked against the persisted rows', async () => {
    const seeded = await seedSet();
    const s = await summary();
    expect(s.collections).toMatchObject({ total: 6, byStatus: { COLLECTED: 2, REMITTED: 1, RECONCILED: 3 }, outstandingCount: 3, oldestOutstandingCollectedAt: seeded.a.collectedAt.toISOString() });
    expect(s.exceptions).toEqual({ discrepancyCount: 3, reconciliationDiscrepancyCount: 1, collectionsWithCorrectionsCount: 2, collectionsWithOpenDisputesCount: 2, openDisputeCount: 2 });

    // Independently from the stored rows, with Module 08's item-view rules (isOutstanding, hasDiscrepancy).
    const rows = await ctx.prisma.codCollection.findMany({ include: { remittance: true, reconciliation: true, corrections: true, disputes: true } });
    const outstanding = rows.filter((r) => r.status !== 'RECONCILED');
    const discrepant = rows.filter((r) => r.collectedAmount !== r.expectedAmount || (r.remittance !== null && r.remittance.remittedAmount !== r.collectedAmount));
    expect(s.collections.total).toBe(rows.length);
    for (const st of ['COLLECTED', 'REMITTED', 'RECONCILED']) expect(s.collections.byStatus[st]).toBe(rows.filter((r) => r.status === st).length);
    expect(s.collections.outstandingCount).toBe(outstanding.length);
    expect(s.collections.oldestOutstandingCollectedAt).toBe(new Date(Math.min(...outstanding.map((r) => r.collectedAt.getTime()))).toISOString());
    expect(s.exceptions.discrepancyCount).toBe(discrepant.length);
    expect(s.exceptions.reconciliationDiscrepancyCount).toBe(await ctx.prisma.codReconciliation.count({ where: { outcome: 'DISCREPANCY' } }));
    expect(s.exceptions.collectionsWithCorrectionsCount).toBe(rows.filter((r) => r.corrections.length > 0).length);
    expect(s.exceptions.collectionsWithOpenDisputesCount).toBe(rows.filter((r) => r.disputes.some((d) => d.status === 'OPEN')).length);
    expect(s.exceptions.openDisputeCount).toBe(await ctx.prisma.codDispute.count({ where: { status: 'OPEN' } }));
    // Not inflated by multiple rows: 3 correction rows over 2 collections; 6 dispute rows (2 open) over 3 collections.
    expect(await ctx.prisma.codCorrection.count()).toBe(3);
    expect(await ctx.prisma.codDispute.count()).toBe(6);
    // A recorded DISCREPANCY (e) and a variance (a, c, f) are different conditions: e is not a variance, f has no DISCREPANCY finding.
    expect(discrepant.map((r) => r.id).sort()).toEqual([seeded.a.id, seeded.c.id, seeded.f.id].sort());
  });

  it('one OPEN dispute per collection is a database rule, so collections-with-open-disputes and open disputes coincide on real data', async () => {
    const seeded = await seedSet();
    await expect(dispute(seeded.a.id, 'OPEN')).rejects.toThrow(/Unique constraint/);
    const s = await summary();
    expect(s.exceptions.collectionsWithOpenDisputesCount).toBe(s.exceptions.openDisputeCount);
    // Resolving one leaves the other collection's open dispute counted once in each figure.
    await ctx.prisma.codDispute.updateMany({ where: { collectionId: seeded.a.id, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId: admin.userId } });
    const after = await summary();
    expect([after.exceptions.collectionsWithOpenDisputesCount, after.exceptions.openDisputeCount]).toEqual([1, 1]);
  });

  it('oldest outstanding age: whole seconds from the oldest outstanding collectedAt to generatedAt; null again once nothing is outstanding', async () => {
    const seeded = await seedSet();
    const s = await summary();
    const expectedAge = Math.floor((Date.parse(s.generatedAt) - seeded.a.collectedAt.getTime()) / 1000);
    expect(Number.isInteger(s.collections.oldestOutstandingAgeSeconds)).toBe(true);
    expect(Math.abs(s.collections.oldestOutstandingAgeSeconds! - expectedAge)).toBeLessThanOrEqual(1);
    expect(s.collections.oldestOutstandingAgeSeconds).toBeGreaterThanOrEqual(600 * 60 - 1);
    // A collection recorded with a future collectedAt never yields a negative age.
    await ctx.prisma.codCollection.update({ where: { id: seeded.a.id }, data: { status: 'RECONCILED' } });
    await ctx.prisma.codCollection.update({ where: { id: seeded.c.id }, data: { status: 'RECONCILED' } });
    await ctx.prisma.codCollection.update({ where: { id: seeded.b.id }, data: { collectedAt: t(-10) } });
    expect((await summary()).collections.oldestOutstandingAgeSeconds).toBe(0);
    await ctx.prisma.codCollection.update({ where: { id: seeded.b.id }, data: { status: 'RECONCILED' } });
    const none = await summary();
    expect([none.collections.outstandingCount, none.collections.oldestOutstandingCollectedAt, none.collections.oldestOutstandingAgeSeconds]).toEqual([0, null, null]);
  });

  it('the summary segment is the summary route, not a collection id; Work 38 list and detail are unchanged', async () => {
    const seeded = await seedSet();
    const s = await summary();
    expect(Object.keys(s)).toEqual(['generatedAt', 'collections', 'exceptions']);
    const list = body(await request(ctx.server).get('/admin/operations/cod').set(...auth(admin.accessToken)).expect(200)) as unknown as { total: number };
    expect(list.total).toBe(6);
    const detail = body(await request(ctx.server).get(`/admin/operations/cod/${seeded.a.id}`).set(...auth(admin.accessToken)).expect(200)) as { collectionId: string; correctionCount: number };
    expect([detail.collectionId, detail.correctionCount]).toEqual([seeded.a.id, 2]);
    await request(ctx.server).get('/admin/operations/cod/not-a-uuid').set(...auth(admin.accessToken)).expect(400);
  });

  it('privacy: counts and timestamps only — no id, amount, reference, note, reason or person', async () => {
    const seeded = await seedSet();
    const raw = JSON.stringify(await summary());
    const ids = Object.values(seeded).flatMap((c) => [c.id, c.jobId, c.orderId, c.fulfillmentId]);
    for (const secret of [...ids, driverId, admin.userId, driverUser.userId, driverUser.phone, 'TXN-SECRET', 'SETTLE-SECRET', 'SLIP-SECRET', 'RUN-SECRET', 'Kebede', 'Almaz', '+251911', 'customer says', 'idem-', 'Bole', 'AA-3']) {
      expect({ secret: secret.slice(0, 10), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 10), found: false });
    }
    for (const amount of ['10000', '9000', '6500', '1500']) expect(raw).not.toContain(amount);
    expect(raw).not.toMatch(/Id"|Amount"|reference|note|reason/i);
  });

  it('read-only: COD records, jobs, earnings, audit and outbox unchanged; other methods do not mutate', async () => {
    const seeded = await seedSet();
    await ctx.prisma.driverEarning.create({ data: { driverId, jobId: seeded.d.jobId, orderId: seeded.d.orderId, fulfillmentId: seeded.d.fulfillmentId, base: 1_000, total: 1_000 } });
    const state = async () => ({
      collections: await ctx.prisma.codCollection.findMany({ orderBy: { id: 'asc' } }),
      remittances: await ctx.prisma.codRemittance.findMany({ orderBy: { id: 'asc' } }),
      reconciliations: await ctx.prisma.codReconciliation.findMany({ orderBy: { id: 'asc' } }),
      corrections: await ctx.prisma.codCorrection.findMany({ orderBy: { id: 'asc' } }),
      disputes: await ctx.prisma.codDispute.findMany({ orderBy: { id: 'asc' } }),
      jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
      earnings: await ctx.prisma.driverEarning.findMany({ orderBy: { id: 'asc' } }),
      audit: await ctx.prisma.auditLog.count(),
      outbox: await ctx.prisma.outbox.count(),
    });
    const before = await state();
    await summary();
    await summary();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const status = (await request(ctx.server)[method](PATH).set(...auth(admin.accessToken)).send({ status: 'RECONCILED' })).status;
      // POST resolves to no route (404); PUT/PATCH/DELETE reach Work 38's `:collectionId` path shape, which has no such
      // method either (404). Neither writes anything — the state comparison below is the point.
      expect({ method, status }).toEqual({ method, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('RBAC: ADMIN, FINANCE_OFFICER and SUPER_ADMIN allowed; anonymous 401; driver, customer, pharmacy, support and ops-read-only roles 403', async () => {
    await seedSet();
    for (const role of ['FINANCE_OFFICER', 'SUPER_ADMIN']) {
      const token = (await createUserWithRole(ctx, role)).accessToken;
      expect({ role, status: (await get(token)).status }).toEqual({ role, status: 200 });
    }
    expect((await get(null)).status).toBe(401);
    const tokens: Array<[string, string]> = [['DRIVER', driverUser.accessToken]];
    for (const role of ['CUSTOMER', 'PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER_SUPPORT']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    const r = await ctx.prisma.role.upsert({ where: { key: 'OPS_VIEWER_TEST' }, update: {}, create: { key: 'OPS_VIEWER_TEST', name: 'Ops viewer (test)', scope: 'PLATFORM' } });
    for (const key of ['delivery:read:any', 'driver:read:any', 'analytics:read']) {
      const p = await ctx.prisma.permission.findUniqueOrThrow({ where: { key } });
      await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: p.id } }, update: {}, create: { roleId: r.id, permissionId: p.id } });
    }
    tokens.push(['OPS_VIEWER_TEST', (await createUserWithRole(ctx, 'OPS_VIEWER_TEST')).accessToken]);
    for (const [role, token] of tokens) expect({ role, status: (await get(token)).status }).toEqual({ role, status: 403 });
  });

  it('Work 06 disputes and Work 07 finance still answer', async () => {
    const seeded = await seedSet();
    const disputes = body(await request(ctx.server).get('/admin/cod-disputes').set(...auth(admin.accessToken)).expect(200)) as unknown as { items: unknown[] };
    expect(disputes.items.length).toBeGreaterThan(0);
    const open = await ctx.prisma.codDispute.findFirstOrThrow({ where: { collectionId: seeded.a.id } });
    await request(ctx.server).get(`/admin/cod-disputes/${open.id}`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).get('/admin/finance/payments').set(...auth(admin.accessToken)).expect(200);
  });
});
