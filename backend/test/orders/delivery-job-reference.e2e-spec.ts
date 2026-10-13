import { randomUUID } from 'crypto';
import request from 'supertest';
import { backfillFulfillmentDeliveryJobIds } from '../../prisma/maintenance/backfill-fulfillment-delivery-job-ids';
import { jobCreatedEvent } from '../../src/modules/delivery/domain/events';
import { DeliveryJobCreatedHandler } from '../../src/modules/orders/interface/events/delivery-job-created.handler';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder } from './support';

/**
 * Work 42A against real PostgreSQL: Module 08's `delivery.job.created` recorded on the Module 06
 * fulfillment (`fulfillments.deliveryJobId`), and the maintenance backfill that recovers it.
 */
describe('Delivery job reference on fulfillments (e2e)', () => {
  let ctx: TestContext;
  let handler: DeliveryJobCreatedHandler;

  beforeAll(async () => {
    ctx = await createTestApp();
    handler = ctx.app.get(DeliveryJobCreatedHandler);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  /** A real order taken to READY through Module 06's pharmacy routes, then the outbox drained. */
  async function readyOrderWithJob() {
    const placed = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${placed.fulfillmentId}/${action}`).set(...auth(placed.pharmacy.accessToken)).expect(200);
    }
    await ctx.drainOutbox(); // order.ready -> Module 08 creates the job -> delivery.job.created -> Module 06 links it
    const job = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { fulfillmentId: placed.fulfillmentId } });
    return { ...placed, job };
  }

  /** Everything the reference write must not disturb. */
  const invariants = async () => ({
    orders: await ctx.prisma.order.findMany({ orderBy: { id: 'asc' } }),
    fulfillments: await ctx.prisma.fulfillment.findMany({ orderBy: { id: 'asc' }, select: { id: true, orderId: true, status: true, acceptedAt: true, readyAt: true, pharmacyId: true, branchId: true, createdAt: true } }),
    orderHistory: await ctx.prisma.orderStatusHistory.findMany({ orderBy: { id: 'asc' } }),
    jobs: await ctx.prisma.deliveryJob.findMany({ orderBy: { id: 'asc' } }),
    jobHistory: await ctx.prisma.deliveryStatusHistory.findMany({ orderBy: { id: 'asc' } }),
    audit: await ctx.prisma.auditLog.count(),
    outbox: await ctx.prisma.outbox.count(),
  });

  it('the real workflow records the actual job id on the matching fulfillment; Work 35 and Work 36 agree on it', async () => {
    const { orderId, fulfillmentId, job } = await readyOrderWithJob();
    const fulfillment = await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id: fulfillmentId } });
    expect(fulfillment.deliveryJobId).toBe(job.id);
    expect([job.orderId, job.fulfillmentId]).toEqual([orderId, fulfillmentId]);
    expect(fulfillment.status).toBe('READY');
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('READY');
    // The job was announced exactly once, and nothing in Module 06 published an event of its own for the link.
    const created = await ctx.prisma.outbox.findMany({ where: { eventType: 'delivery.job.created' } });
    expect(created).toHaveLength(1);
    expect(await ctx.prisma.outbox.count({ where: { eventType: { contains: 'fulfillment' } } })).toBe(0);

    const admin = await createUserWithRole(ctx, 'ADMIN');
    const order = body(await request(ctx.server).get(`/admin/operations/orders/${orderId}`).set(...auth(admin.accessToken)).expect(200)) as { fulfillments: Array<{ fulfillmentId: string; deliveryJobId: string | null }> };
    expect(order.fulfillments).toEqual([expect.objectContaining({ fulfillmentId, deliveryJobId: job.id })]);
    const delivery = body(await request(ctx.server).get(`/admin/operations/deliveries/${job.id}`).set(...auth(admin.accessToken)).expect(200)) as { deliveryJobId: string; orderId: string; fulfillmentId: string };
    expect([delivery.deliveryJobId, delivery.orderId, delivery.fulfillmentId]).toEqual([job.id, orderId, fulfillmentId]);
  });

  it('a redelivered event changes nothing and creates no second job, audit entry or event; a conflicting job id is not written', async () => {
    const { orderId, fulfillmentId, job } = await readyOrderWithJob();
    const before = await invariants();
    const event = jobCreatedEvent({ jobId: job.id, orderId, fulfillmentId, pharmacyId: job.pharmacyId, branchId: job.branchId, isColdChain: job.isColdChain, isCod: job.isCod });
    await Promise.all([handler.handle(event), handler.handle(event), handler.handle(event)]);
    await handler.handle(jobCreatedEvent({ ...event.payload, jobId: randomUUID() })); // a different job for the same fulfillment
    await handler.handle(jobCreatedEvent({ ...event.payload, orderId: randomUUID() })); // the right fulfillment under another order
    await handler.handle(jobCreatedEvent({ ...event.payload, fulfillmentId: randomUUID() })); // no such fulfillment
    expect(await invariants()).toEqual(before);
    expect((await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id: fulfillmentId } })).deliveryJobId).toBe(job.id);
    expect(await ctx.prisma.deliveryJob.count({ where: { fulfillmentId } })).toBe(1);
  });

  it('backfill: populates only missing references, keeps correct ones, skips conflicting/mismatched/orphaned rows, and is safe to rerun', async () => {
    // Two real READY orders with jobs; one's reference is wiped, as if the handler had failed.
    const missed = await readyOrderWithJob();
    const correct = await readyOrderWithJob();
    await ctx.prisma.fulfillment.update({ where: { id: missed.fulfillmentId }, data: { deliveryJobId: null } });
    // A third whose fulfillment names some other job — must survive untouched.
    const conflicted = await readyOrderWithJob();
    const foreign = randomUUID();
    await ctx.prisma.fulfillment.update({ where: { id: conflicted.fulfillmentId }, data: { deliveryJobId: foreign } });
    // A job whose orderId is not its fulfillment's order, on an unlinked fulfillment.
    const mismatched = await readyOrderWithJob();
    await ctx.prisma.fulfillment.update({ where: { id: mismatched.fulfillmentId }, data: { deliveryJobId: null } });
    await ctx.prisma.deliveryJob.update({ where: { id: mismatched.job.id }, data: { orderId: randomUUID() } });
    // A job pointing at no fulfillment at all.
    await ctx.prisma.deliveryJob.create({ data: { orderId: randomUUID(), fulfillmentId: randomUUID(), pharmacyId: randomUUID(), branchId: randomUUID() } });

    const before = await invariants();
    const first = await backfillFulfillmentDeliveryJobIds(ctx.prisma);
    expect(first).toEqual({ populated: 1, alreadyCorrect: 1, conflicting: 1, orderMismatch: 1, orphaned: 1, ambiguous: 0 });

    const ref = async (id: string) => (await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id } })).deliveryJobId;
    expect(await ref(missed.fulfillmentId)).toBe(missed.job.id);
    expect(await ref(correct.fulfillmentId)).toBe(correct.job.id);
    expect(await ref(conflicted.fulfillmentId)).toBe(foreign);
    expect(await ref(mismatched.fulfillmentId)).toBeNull();
    // Cross-checked against the persisted pairs: every linked fulfillment names the job cut for it.
    const linked = await ctx.prisma.fulfillment.findMany({ where: { deliveryJobId: { not: null } } });
    for (const f of linked.filter((x) => x.deliveryJobId !== foreign)) {
      const j = await ctx.prisma.deliveryJob.findUniqueOrThrow({ where: { id: f.deliveryJobId! } });
      expect([j.fulfillmentId, j.orderId]).toEqual([f.id, f.orderId]);
    }

    const second = await backfillFulfillmentDeliveryJobIds(ctx.prisma);
    expect(second).toEqual({ populated: 0, alreadyCorrect: 2, conflicting: 1, orderMismatch: 1, orphaned: 1, ambiguous: 0 });
    // Nothing but the one reference moved: statuses, history, jobs, audit and outbox as they were.
    expect(await invariants()).toEqual(before);
  });
});
