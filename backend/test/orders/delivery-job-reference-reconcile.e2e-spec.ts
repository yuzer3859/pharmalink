import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { backfillFulfillmentDeliveryJobIds } from '../../prisma/maintenance/backfill-fulfillment-delivery-job-ids';
import { FULFILLMENT_DELIVERY_JOB_LINK_REPOSITORY, DeliveryJobLinkInput, DeliveryJobLinkOutcome } from '../../src/modules/orders/domain/repositories/fulfillment-delivery-job-link.repository';
import { PrismaFulfillmentDeliveryJobLinkRepository } from '../../src/modules/orders/infrastructure/persistence/prisma-fulfillment-delivery-job-link.repository';
import { DeliveryJobReferenceReconciler } from '../../src/modules/orders/infrastructure/scheduling/delivery-job-reference.reconciler';
import { DeliveryJobCreatedHandler } from '../../src/modules/orders/interface/events/delivery-job-created.handler';
import { jobCreatedEvent } from '../../src/modules/delivery/domain/events';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder } from './support';

/** The real guarded link, with a switch that makes every write fail — a stand-in for a lost DB connection. */
@Injectable()
class SwitchableLinkRepository extends PrismaFulfillmentDeliveryJobLinkRepository {
  static failing = false;
  override async link(input: DeliveryJobLinkInput): Promise<DeliveryJobLinkOutcome> {
    if (SwitchableLinkRepository.failing) throw new Error('simulated write failure');
    return super.link(input);
  }
}

/**
 * Work 45 against real PostgreSQL: missed `fulfillments.deliveryJobId` references recovered by
 * `DeliveryJobReferenceReconciler`, through Module 08's read port and the shared guarded link.
 */
describe('Delivery job reference reconciliation (e2e)', () => {
  let ctx: TestContext;
  let reconciler: DeliveryJobReferenceReconciler;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: FULFILLMENT_DELIVERY_JOB_LINK_REPOSITORY, useClass: SwitchableLinkRepository }]);
    reconciler = ctx.app.get(DeliveryJobReferenceReconciler);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    SwitchableLinkRepository.failing = false;
    await ctx.reset();
  });

  /** A real order taken to READY through Module 06's pharmacy routes, then the outbox drained. */
  async function readyOrder() {
    const placed = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${placed.fulfillmentId}/${action}`).set(...auth(placed.pharmacy.accessToken)).expect(200);
    }
    await ctx.drainOutbox();
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { fulfillmentId: placed.fulfillmentId } });
    return { ...placed, job };
  }
  const ref = async (fulfillmentId: string) => (await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id: fulfillmentId } })).deliveryJobId;

  /** Everything but the reference column. */
  const invariants = async () => ({
    orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
    fulfillments: await ctx.prisma.fulfillment.findMany({ orderBy: { id: 'asc' }, select: { id: true, orderId: true, status: true, acceptedAt: true, readyAt: true, pharmacyId: true, branchId: true, createdAt: true } }),
    orderHistory: await ctx.prisma.orderStatusHistory.findMany({ orderBy: { id: 'asc' } }),
    jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
    jobHistory: await ctx.prisma.deliveryStatusHistory.findMany({ orderBy: { id: 'asc' } }),
    offers: await ctx.prisma.jobOffer.findMany({ orderBy: { id: 'asc' } }),
    cod: await ctx.prisma.codCollection.findMany({ orderBy: { id: 'asc' } }),
    audit: await ctx.prisma.auditLog.count(),
    outbox: await ctx.prisma.outbox.findMany({ orderBy: { id: 'asc' } }),
  });

  it('normal workflow: the event handler records the reference; the reconciler then finds nothing to do and creates nothing', async () => {
    const o = await readyOrder();
    expect(await ref(o.fulfillmentId)).toBe(o.job.id);
    const before = await invariants();
    expect(await reconciler.run()).toEqual({ examined: 0, populated: 0, alreadyCorrect: 0, conflicts: 0, orderMismatches: 0, noJob: 0, failures: 0 });
    expect(await invariants()).toEqual(before);
  });

  it('a failed handler write is published-and-lost by the relay, then recovered automatically — and every admin view reflects it', async () => {
    SwitchableLinkRepository.failing = true;
    const o = await readyOrder();
    // The handler failed, the event is nonetheless marked published, and the job exists — the gap Work 45 closes.
    expect(await ref(o.fulfillmentId)).toBeNull();
    const created = await ctx.prisma.outbox.findFirstOrThrow({ where: { eventType: 'delivery.job.created' } });
    expect(created.publishedAt).not.toBeNull();

    SwitchableLinkRepository.failing = false;
    const before = await invariants();
    const report = await reconciler.run();
    expect(report).toMatchObject({ examined: 1, populated: 1, conflicts: 0, failures: 0 });
    expect(await ref(o.fulfillmentId)).toBe(o.job.id);
    expect(await invariants()).toEqual(before); // only deliveryJobId moved: no job, history, offer, COD, audit or event added
    expect(await ctx.prisma.deliveryJob.count({ where: { fulfillmentId: o.fulfillmentId } })).toBe(1);

    const admin = (await createUserWithRole(ctx, 'ADMIN')).accessToken;
    const get = (path: string, query: Record<string, string> = {}) => request(ctx.server).get(path).query(query).set(...auth(admin)).expect(200).then((r) => body(r));
    const detail = (await get(`/admin/operations/orders/${o.orderId}`)) as { fulfillments: Array<{ deliveryJobId: string | null }> };
    expect(detail.fulfillments.map((f) => f.deliveryJobId)).toEqual([o.job.id]); // Work 35
    expect(((await get(`/admin/operations/deliveries/${o.job.id}`)) as { fulfillmentId: string }).fulfillmentId).toBe(o.fulfillmentId); // Work 36
    const summary = (await get('/admin/operations/orders/summary')) as { orders: { byStatus: Record<string, number> }; readyHandoff: Record<string, number> };
    expect(summary.orders.byStatus.READY).toBe(1); // Work 41
    expect(summary.readyHandoff).toEqual({ readyOrderCount: 1, readyOrdersWithDeliveryJob: 1, readyOrdersWithoutDeliveryJob: 0 }); // Work 42
    const row = ((await get('/admin/operations/orders', { hasDeliveryJobReference: 'true' })) as { items: Array<{ orderId: string; unreferencedFulfillmentCount: number }> }).items; // Work 43
    expect(row.map((r) => [r.orderId, r.unreferencedFulfillmentCount])).toEqual([[o.orderId, 0]]); // Work 44
  });

  it('a transient failure during reconciliation is logged and retried by the next run', async () => {
    SwitchableLinkRepository.failing = true;
    const o = await readyOrder();
    expect(await reconciler.run()).toMatchObject({ examined: 1, populated: 0, failures: 1 });
    expect(await ref(o.fulfillmentId)).toBeNull();
    SwitchableLinkRepository.failing = false;
    expect(await reconciler.run()).toMatchObject({ examined: 1, populated: 1, failures: 0 });
    expect(await ref(o.fulfillmentId)).toBe(o.job.id);
  });

  it('a reference missed for any reason (wiped) is restored to the job Module 08 already has — no second job', async () => {
    const o = await readyOrder();
    await ctx.prisma.fulfillment.update({ where: { id: o.fulfillmentId }, data: { deliveryJobId: null } });
    const jobsBefore = await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } });
    expect(await reconciler.run()).toMatchObject({ populated: 1 });
    expect(await ref(o.fulfillmentId)).toBe(o.job.id);
    expect(await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } })).toEqual(jobsBefore);
  });

  it('conflicting, mismatched, orphaned and job-less rows are left unchanged', async () => {
    // Conflicting: a fulfillment already naming another job is never a candidate.
    const conflicted = await readyOrder();
    const foreign = randomUUID();
    await ctx.prisma.fulfillment.update({ where: { id: conflicted.fulfillmentId }, data: { deliveryJobId: foreign } });
    // Mismatched: the only job for this fulfillment names another order.
    const mismatched = await readyOrder();
    await ctx.prisma.fulfillment.update({ where: { id: mismatched.fulfillmentId }, data: { deliveryJobId: null } });
    await ctx.prisma.deliveryJob.update({ where: { id: mismatched.job.id }, data: { orderId: randomUUID() } });
    // Job-less: a READY fulfillment Module 08 has no job for.
    const jobless = await ctx.prisma.fulfillment.create({ data: { orderId: conflicted.orderId, pharmacyId: randomUUID(), branchId: randomUUID(), status: 'READY' } });
    // Orphaned: a job pointing at no fulfillment.
    await ctx.prisma.deliveryJob.create({ data: { orderId: randomUUID(), fulfillmentId: randomUUID(), pharmacyId: randomUUID(), branchId: randomUUID() } });

    const report = await reconciler.run();
    expect(report).toEqual({ examined: 2, populated: 0, alreadyCorrect: 0, conflicts: 0, orderMismatches: 1, noJob: 1, failures: 0 });
    expect([await ref(conflicted.fulfillmentId), await ref(mismatched.fulfillmentId), await ref(jobless.id)]).toEqual([foreign, null, null]);
    expect(await reconciler.run()).toEqual(report); // and the same next time — nothing drifts
  });

  it('overlapping reconciliation, a racing handler redelivery and the maintenance script converge on one reference', async () => {
    SwitchableLinkRepository.failing = true;
    const a = await readyOrder();
    const b = await readyOrder();
    SwitchableLinkRepository.failing = false;
    const before = await invariants();
    const redelivery = jobCreatedEvent({ jobId: a.job.id, orderId: a.orderId, fulfillmentId: a.fulfillmentId, pharmacyId: a.job.pharmacyId, branchId: a.job.branchId, isColdChain: a.job.isColdChain, isCod: a.job.isCod });
    const [r1, r2, script] = await Promise.all([
      reconciler.run(),
      reconciler.run(),
      backfillFulfillmentDeliveryJobIds(ctx.prisma),
      ctx.app.get(DeliveryJobCreatedHandler).handle(redelivery),
    ]);
    // Whoever wins each row, each is filled exactly once (the handler's win is not counted here).
    expect(r1.populated + r2.populated + script.populated).toBeLessThanOrEqual(2);
    expect(r2.examined === 0 || r1.examined === 0).toBe(true); // the in-process overlap guard
    expect([await ref(a.fulfillmentId), await ref(b.fulfillmentId)]).toEqual([a.job.id, b.job.id]);
    expect(await invariants()).toEqual(before);
    expect(await reconciler.run()).toMatchObject({ examined: 0 });
    expect(await backfillFulfillmentDeliveryJobIds(ctx.prisma)).toMatchObject({ populated: 0, alreadyCorrect: 2 });
  });
});
