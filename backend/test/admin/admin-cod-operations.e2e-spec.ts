import { randomUUID } from 'crypto';
import request from 'supertest';
import { auth, body, createUserWithRole, RegisteredUser, Tokens } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

type User = RegisteredUser & Tokens;
type Item = Record<string, unknown> & { collectionId: string; status: string };
type Page = { items: Item[]; total: number; page: number; size: number };
const BASE = '/admin/operations/cod';

/**
 * Module 16 Work 38 against real PostgreSQL: read-only COD operations — Module 08 COD collections with
 * their remittance, reconciliation, corrections and dispute references.
 */
describe('Admin COD operations (e2e)', () => {
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
    driverId = (await ctx.prisma.driverProfile.create({ data: { userId: driverUser.userId, plateNumber: 'AA-3-PLATE-55', lastLat: 9.0101, lastLng: 38.7613 } })).id;
  });

  const get = (path: string, token: string | null = admin.accessToken) => {
    const r = request(ctx.server).get(path);
    return token ? r.set(...auth(token)) : r;
  };
  const list = async (query: Record<string, string | number> = {}) => body(await get(BASE).query(query).expect(200)) as unknown as Page;
  const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  /** A delivered COD job and the collection the driver declared on it. */
  async function seedCollection(o: { collectedAt: Date; expected?: number; collected?: number; status?: string; orderId?: string }) {
    const job = await ctx.prisma.deliveryJob.create({
      data: {
        orderId: o.orderId ?? randomUUID(), fulfillmentId: randomUUID(), pharmacyId: randomUUID(), branchId: randomUUID(), assignedDriverId: driverId,
        status: 'DELIVERED', isCod: true, codAmount: o.expected ?? 10_000, dropoffAddress: 'Bole Road 42, House 7', dropoffLat: 8.9951, dropoffLng: 38.7899,
      },
    });
    return ctx.prisma.codCollection.create({
      data: {
        jobId: job.id, driverId, orderId: job.orderId, fulfillmentId: job.fulfillmentId, expectedAmount: o.expected ?? 10_000, collectedAmount: o.collected ?? o.expected ?? 10_000,
        method: 'ELECTRONIC', status: (o.status ?? 'COLLECTED') as never, providerReference: 'TELEBIRR-TXN-SECRET', settlementRef: 'SETTLE-REF-SECRET', collectedAt: o.collectedAt,
      },
    });
  }
  async function remit(collectionId: string, amount: number, at: Date) {
    await ctx.prisma.codCollection.update({ where: { id: collectionId }, data: { status: 'REMITTED', remittedAt: at } });
    return ctx.prisma.codRemittance.create({
      data: { collectionId, remittedAmount: amount, reference: 'SLIP-SECRET-0042', note: 'counted by Kebede at desk 2', confirmedByUserId: admin.userId, remittedAt: at },
    });
  }
  async function reconcile(collectionId: string, outcome: 'ACCEPTED' | 'DISCREPANCY', at: Date) {
    await ctx.prisma.codCollection.update({ where: { id: collectionId }, data: { status: 'RECONCILED', reconciledAt: at } });
    return ctx.prisma.codReconciliation.create({
      data: { collectionId, outcome, reference: 'RECON-RUN-SECRET', note: 'driver short — call Almaz', reconciledByUserId: admin.userId, reconciledAt: at },
    });
  }

  async function seedSet() {
    const orderX = randomUUID();
    const fresh = await seedCollection({ collectedAt: t(50), expected: 10_000, collected: 10_000, orderId: orderX });
    const remitted = await seedCollection({ collectedAt: t(40), expected: 12_500, collected: 12_000 });
    const remittance = await remit(remitted.id, 11_500, t(35));
    const accepted = await seedCollection({ collectedAt: t(30), expected: 8_000 });
    await remit(accepted.id, 8_000, t(28));
    await reconcile(accepted.id, 'ACCEPTED', t(27));
    const disputed = await seedCollection({ collectedAt: t(20), expected: 20_000, collected: 20_000, orderId: orderX });
    const disputedRemittance = await remit(disputed.id, 15_500, t(18));
    const finding = await reconcile(disputed.id, 'DISCREPANCY', t(17));
    const c1 = await ctx.prisma.codCorrection.create({
      data: { collectionId: disputed.id, remittanceId: disputedRemittance.id, type: 'RECORDING_MISTAKE', originalAmount: 15_500, correctedAmount: 16_000, reason: 'operator typo, per Kebede', idempotencyKey: `idem-${randomUUID()}`, createdByUserId: admin.userId, createdAt: t(16) },
    });
    const c2 = await ctx.prisma.codCorrection.create({
      data: { collectionId: disputed.id, reconciliationId: finding.id, type: 'REFERENCE_CORRECTION', originalReference: 'SLIP-OLD-SECRET', correctedReference: 'SLIP-NEW-SECRET', reason: 'slip number mistyped', idempotencyKey: `idem-${randomUUID()}`, createdByUserId: admin.userId, createdAt: t(15) },
    });
    const d1 = await ctx.prisma.codDispute.create({
      data: { collectionId: disputed.id, reason: 'customer +251911222333 says paid in full', status: 'RESOLVED', openedByUserId: admin.userId, openedAt: t(14), resolvedByUserId: admin.userId, resolvedAt: t(13), resolutionNote: 'driver repaid' },
    });
    const d2 = await ctx.prisma.codDispute.create({ data: { collectionId: disputed.id, reason: 'second query from Almaz', openedByUserId: admin.userId, openedAt: t(12) } });
    return { orderX, fresh, remitted, remittance, accepted, disputed, disputedRemittance, finding, c1, c2, d1, d2 };
  }

  it('an empty list', async () => {
    expect(await list()).toEqual({ items: [], total: 0, page: 1, size: 20 });
  });

  it('lists most recently collected first; every figure cross-checked against the persisted rows', async () => {
    const s = await seedSet();
    const res = await list();
    expect(res.total).toBe(4);
    expect(res.items.map((i) => i.collectionId)).toEqual([s.disputed.id, s.accepted.id, s.remitted.id, s.fresh.id]);
    for (const item of res.items) {
      const row = await ctx.prisma.codCollection.findUniqueOrThrow({ where: { id: item.collectionId }, include: { remittance: true, reconciliation: true, corrections: true, disputes: true } });
      expect(item).toEqual({
        collectionId: row.id,
        jobId: row.jobId,
        orderId: row.orderId,
        fulfillmentId: row.fulfillmentId,
        driverProfileId: row.driverId,
        status: row.status,
        method: row.method,
        currency: row.currency,
        expectedAmount: row.expectedAmount,
        collectedAmount: row.collectedAmount,
        remittedAmount: row.remittance?.remittedAmount ?? null,
        collectionVariance: row.collectedAmount - row.expectedAmount,
        remittanceVariance: row.remittance ? row.remittance.remittedAmount - row.collectedAmount : null,
        hasDiscrepancy: row.collectedAmount !== row.expectedAmount || (row.remittance !== null && row.remittance.remittedAmount !== row.collectedAmount),
        isOutstanding: row.status !== 'RECONCILED',
        reconciliationOutcome: row.reconciliation?.outcome ?? null,
        collectedAt: row.collectedAt.toISOString(),
        recordedAt: row.recordedAt.toISOString(),
        remittedAt: row.remittedAt?.toISOString() ?? null,
        reconciledAt: row.reconciledAt?.toISOString() ?? null,
        correctionCount: row.corrections.length,
        disputeCount: row.disputes.length,
        openDisputeCount: row.disputes.filter((d) => d.status === 'OPEN').length,
      });
    }
  });

  it('filters by status, order id, job id and collected window; pages stably; rejects bad input', async () => {
    const s = await seedSet();
    expect((await list({ status: 'COLLECTED' })).items.map((i) => i.collectionId)).toEqual([s.fresh.id]);
    expect((await list({ status: 'REMITTED' })).items.map((i) => i.collectionId)).toEqual([s.remitted.id]);
    expect((await list({ status: 'RECONCILED' })).items.map((i) => i.collectionId)).toEqual([s.disputed.id, s.accepted.id]);
    expect((await list({ orderId: s.orderX })).items.map((i) => i.collectionId)).toEqual([s.disputed.id, s.fresh.id]);
    expect((await list({ jobId: s.remitted.jobId })).items.map((i) => i.collectionId)).toEqual([s.remitted.id]);
    expect((await list({ jobId: randomUUID() })).total).toBe(0);
    expect((await list({ collectedFrom: t(45).toISOString(), collectedTo: t(25).toISOString() })).items.map((i) => i.collectionId)).toEqual([s.accepted.id, s.remitted.id]);
    const pages = [await list({ size: 3, page: 1 }), await list({ size: 3, page: 2 })];
    expect(pages.map((p) => p.total)).toEqual([4, 4]);
    expect(pages.flatMap((p) => p.items.map((i) => i.collectionId))).toEqual((await list()).items.map((i) => i.collectionId));
    for (const bad of [
      { status: 'SETTLED' }, { status: 'DISCREPANCY' }, { orderId: 'ORD-1' }, { jobId: '7' }, { collectedFrom: 'yesterday' }, { page: 0 }, { size: 101 },
      { driverId }, { remittanceReference: 'SLIP-SECRET-0042' }, { q: 'Kebede' },
    ]) {
      expect({ bad, status: (await get(BASE).query(bad)).status }).toEqual({ bad, status: 400 });
    }
  });

  it('detail: collection, its one remittance and reconciliation, every correction and dispute — matched to the stored rows', async () => {
    const s = await seedSet();
    const d = body(await get(`${BASE}/${s.disputed.id}`).expect(200)) as Record<string, unknown>;
    expect(d).toMatchObject({
      collectionId: s.disputed.id, status: 'RECONCILED', expectedAmount: 20_000, collectedAmount: 20_000, remittedAmount: 15_500,
      collectionVariance: 0, remittanceVariance: -4_500, hasDiscrepancy: true, isOutstanding: false, reconciliationOutcome: 'DISCREPANCY',
      correctionCount: 2, disputeCount: 2, openDisputeCount: 1,
    });
    expect(d.remittance).toEqual({
      remittanceId: s.disputedRemittance.id, remittedAmount: 15_500, currency: 'ETB', remittedAt: s.disputedRemittance.remittedAt.toISOString(), recordedAt: s.disputedRemittance.recordedAt.toISOString(),
    });
    expect(d.reconciliation).toEqual({ reconciliationId: s.finding.id, outcome: 'DISCREPANCY', reconciledAt: s.finding.reconciledAt.toISOString() });
    // Corrections oldest first, recorded beside the facts: the remitted amount and variance above are unchanged by c1.
    expect(d.corrections).toEqual([
      { correctionId: s.c1.id, type: 'RECORDING_MISTAKE', remittanceId: s.disputedRemittance.id, reconciliationId: null, originalAmount: 15_500, correctedAmount: 16_000, createdAt: s.c1.createdAt.toISOString() },
      { correctionId: s.c2.id, type: 'REFERENCE_CORRECTION', remittanceId: null, reconciliationId: s.finding.id, originalAmount: null, correctedAmount: null, createdAt: s.c2.createdAt.toISOString() },
    ]);
    expect(d.disputes).toEqual([
      { disputeId: s.d2.id, status: 'OPEN', openedAt: s.d2.openedAt.toISOString(), resolvedAt: null },
      { disputeId: s.d1.id, status: 'RESOLVED', openedAt: s.d1.openedAt.toISOString(), resolvedAt: s.d1.resolvedAt!.toISOString() },
    ]);
    // A collection with nothing after it: nulls and empty histories, nothing inferred.
    const fresh = body(await get(`${BASE}/${s.fresh.id}`).expect(200)) as Record<string, unknown>;
    expect(fresh).toMatchObject({ status: 'COLLECTED', remittedAmount: null, remittanceVariance: null, isOutstanding: true, reconciliationOutcome: null, remittance: null, reconciliation: null, corrections: [], disputes: [] });
    // Remitted but not reconciled: still outstanding, no outcome.
    const rem = body(await get(`${BASE}/${s.remitted.id}`).expect(200)) as Record<string, unknown>;
    expect(rem).toMatchObject({ status: 'REMITTED', remittedAmount: 11_500, collectionVariance: -500, remittanceVariance: -500, isOutstanding: true, reconciliationOutcome: null, reconciliation: null });
  });

  it('unknown collection → 404; malformed id → 400; a job id is not a collection id', async () => {
    const s = await seedSet();
    await get(`${BASE}/${randomUUID()}`).expect(404);
    await get(`${BASE}/not-a-uuid`).expect(400);
    await get(`${BASE}/${s.fresh.jobId}`).expect(404);
  });

  it('privacy: no provider/settlement/remittance/reconciliation reference, note, reason, user id, driver person or address', async () => {
    const s = await seedSet();
    const ids = [s.fresh, s.remitted, s.accepted, s.disputed].map((c) => c.id);
    const raw = JSON.stringify([(await get(BASE).query({ size: 100 })).body, ...(await Promise.all(ids.map((id) => get(`${BASE}/${id}`)))).map((r) => r.body)]);
    for (const secret of [
      'TELEBIRR-TXN', 'SETTLE-REF', 'SLIP-SECRET', 'RECON-RUN', 'SLIP-OLD', 'SLIP-NEW', 'Kebede', 'Almaz', '+251911222333', 'typo', 'mistyped', 'paid in full', 'repaid', 'idem-',
      admin.userId, driverUser.userId, driverUser.phone, 'AA-3-PLATE', 'Bole Road', '9.0101', '38.7613', '8.9951',
    ]) {
      expect({ secret: secret.slice(0, 12), found: raw.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
    }
    expect(raw).not.toMatch(/"(note|reason|reference|providerReference|settlementRef|originalReference|correctedReference|resolutionNote|idempotencyKey|userId)"|ByUserId"/);
  });

  it('read-only: collections, remittances, reconciliations, corrections, disputes, jobs, earnings, audit and outbox unchanged; other methods are 404', async () => {
    const s = await seedSet();
    await ctx.prisma.driverEarning.create({ data: { driverId, jobId: s.disputed.jobId, orderId: s.disputed.orderId, fulfillmentId: s.disputed.fulfillmentId, base: 3_000, total: 3_000 } });
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
    await list();
    for (const c of [s.fresh, s.remitted, s.accepted, s.disputed]) await get(`${BASE}/${c.id}`).expect(200);
    const id = s.remitted.id;
    for (const [method, path] of [
      ['post', BASE], ['put', `${BASE}/${id}`], ['patch', `${BASE}/${id}`], ['delete', `${BASE}/${id}`],
      ['post', `${BASE}/${id}/remittance`], ['post', `${BASE}/${id}/reconcile`], ['post', `${BASE}/${id}/corrections`],
    ] as const) {
      expect({ method, path, status: (await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({ remittedAmount: 1, outcome: 'ACCEPTED' })).status }).toEqual({ method, path, status: 404 });
    }
    expect(await state()).toEqual(before);
  });

  it('RBAC: 401 anonymous; 403 for driver, customer, pharmacy, support and delivery/driver-read-only roles; FINANCE_OFFICER and SUPER_ADMIN allowed', async () => {
    const s = await seedSet();
    const paths = [BASE, `${BASE}/${s.disputed.id}`];
    for (const path of paths) expect({ path, status: (await get(path, null)).status }).toEqual({ path, status: 401 });
    const tokens: Array<[string, string]> = [['DRIVER', driverUser.accessToken]];
    for (const role of ['CUSTOMER', 'PHARMACY_OWNER', 'PHARMACY_MANAGER', 'CUSTOMER_SUPPORT']) tokens.push([role, (await createUserWithRole(ctx, role)).accessToken]);
    // A role holding the operations reads and analytics, but not the finance read.
    const r = await ctx.prisma.role.upsert({ where: { key: 'OPS_VIEWER_TEST' }, update: {}, create: { key: 'OPS_VIEWER_TEST', name: 'Ops viewer (test)', scope: 'PLATFORM' } });
    for (const key of ['delivery:read:any', 'driver:read:any', 'analytics:read']) {
      const p = await ctx.prisma.permission.findUniqueOrThrow({ where: { key } });
      await ctx.prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: r.id, permissionId: p.id } }, update: {}, create: { roleId: r.id, permissionId: p.id } });
    }
    tokens.push(['OPS_VIEWER_TEST', (await createUserWithRole(ctx, 'OPS_VIEWER_TEST')).accessToken]);
    for (const [role, token] of tokens) {
      for (const path of paths) expect({ role, path, status: (await get(path, token)).status }).toEqual({ role, path, status: 403 });
    }
    for (const role of ['FINANCE_OFFICER', 'SUPER_ADMIN']) {
      const token = (await createUserWithRole(ctx, role)).accessToken;
      for (const path of paths) expect({ role, path, status: (await get(path, token)).status }).toEqual({ role, path, status: 200 });
    }
  });

  it('Work 06 disputes, Work 07 finance, Work 35 orders, Work 36 deliveries and Work 37 drivers still answer', async () => {
    const s = await seedSet();
    expect((body(await get('/admin/cod-disputes').expect(200)) as unknown as { items: unknown[] }).items.length).toBeGreaterThan(0);
    await get(`/admin/cod-disputes/${s.d2.id}`).expect(200);
    await get('/admin/finance/payments').expect(200);
    await get('/admin/operations/orders').expect(200);
    const job = body(await get(`/admin/operations/deliveries/${s.disputed.jobId}`).expect(200)) as { cod: { collectionId: string; status: string } };
    expect([job.cod.collectionId, job.cod.status]).toEqual([s.disputed.id, 'RECONCILED']);
    await get(`/admin/operations/drivers/${driverId}`).expect(200);
  });
});
