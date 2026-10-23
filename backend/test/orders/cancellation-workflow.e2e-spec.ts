import { SchedulerRegistry } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { OrderCancellationWorkflow } from '../../src/modules/orders/application/services/order-cancellation.workflow';
import {
  IOrderCancellationRequestRepository,
  ORDER_CANCELLATION_REQUEST_REPOSITORY,
} from '../../src/modules/orders/domain/repositories/order-cancellation-request.repository';
import { IOrderRepository, ORDER_REPOSITORY } from '../../src/modules/orders/domain/repositories/order.repository';
import { OrderCancellationReconciler } from '../../src/modules/orders/infrastructure/scheduling/order-cancellation.reconciler';
import { COUPON_PORT, ICouponPort } from '../../src/modules/payment/application/ports/inbound/coupon.port';
import { IInventoryPort, INVENTORY_PORT } from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { ApiException } from '../../src/shared/errors/api-exception';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createPricedProduct, readyToCheckout } from './support';

const REASON = 'Found it cheaper nearby';

/**
 * Work 55 against real PostgreSQL: durable, recoverable customer cancellation. The customer's intent
 * is an `order_cancellation_requests` row written before Module 04 is touched; the request path and
 * `OrderCancellationReconciler` advance it with lease-guarded, idempotent steps. A process
 * interruption is reproduced as the state a dead process leaves: a step's next persistence write
 * fails, then the row is rewritten as held by a dead executor whose lease has expired — and only the
 * real reconciler may finish it. No sleeps: the reconciler is run by hand (cron jobs are stopped).
 */
describe('Orders — durable cancellation workflow (e2e, Work 55)', () => {
  let ctx: TestContext;
  let requests: IOrderCancellationRequestRepository;
  let orders: IOrderRepository;
  let inventory: IInventoryPort;
  let coupons: ICouponPort;
  let reconciler: OrderCancellationReconciler;

  beforeAll(async () => {
    ctx = await createTestApp();
    requests = ctx.app.get(ORDER_CANCELLATION_REQUEST_REPOSITORY);
    orders = ctx.app.get(ORDER_REPOSITORY);
    inventory = ctx.app.get(INVENTORY_PORT);
    coupons = ctx.app.get(COUPON_PORT);
    reconciler = ctx.app.get(OrderCancellationReconciler);
    for (const job of ctx.app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
    expect([...ctx.app.get(SchedulerRegistry).getCronJobs().values()].filter((job) => job.running)).toEqual([]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // §3.12 invariant 5, after every scenario: no CANCELLED order holds stock.
    const held = await ctx.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "orders" o JOIN "order_lines" l ON l."orderId" = o."id"
        JOIN "stock_reservations" r ON r."id" = l."reservationId"
       WHERE o."status" = 'CANCELLED' AND r."status" IN ('HELD', 'CONFIRMED')`;
    expect(held[0].n).toBe(0);
  });

  /** A real checkout of two products from one pharmacy (optionally with a fixed coupon). */
  async function placeOrder({ coupon = false } = {}) {
    const ready = await readyToCheckout(ctx, { quantity: 2, stock: 20 });
    const productB = await createPricedProduct(ctx);
    await request(ctx.server)
      .post('/inventory/listings')
      .set(...auth(ready.pharmacy.accessToken))
      .send({
        catalogProductId: productB, branchId: ready.pharmacy.branchId, price: 2500, batchNumber: 'B-2',
        initialQuantity: 20, expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .expect(201);
    await ctx.prisma.cartItem.create({ data: { cartId: ready.cartId, catalogProductId: productB, quantity: 3, indicativePrice: 2500 } });
    let couponCode: string | undefined;
    if (coupon) {
      couponCode = (await ctx.prisma.coupon.create({ data: { code: `SAVE-${randomUUID().slice(0, 8)}`.toUpperCase(), discountType: 'FIXED', value: 750, isActive: true } })).code;
    }
    const checkout = body(
      await request(ctx.server)
        .post('/checkout')
        .set(...auth(ready.user.accessToken))
        .send({ addressId: ready.addressId, idempotencyKey: randomUUID(), ...(couponCode ? { couponCode } : {}) })
        .expect(201),
    );
    const orderId = checkout.orderId as string;
    const lines = await ctx.prisma.orderLine.findMany({ where: { orderId } });
    const reservationIds = [...new Set(lines.map((l) => l.reservationId as string))];
    const reservations = await ctx.prisma.stockReservation.findMany({ where: { id: { in: reservationIds } } });
    return {
      customer: ready.user, pharmacy: ready.pharmacy, orderId, reservationIds, listingIds: [...new Set(reservations.map((r) => r.listingId))],
      fulfillmentId: (await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId } })).id,
    };
  }
  type Placed = Awaited<ReturnType<typeof placeOrder>>;

  const cancel = (o: Placed) => request(ctx.server).post(`/orders/${o.orderId}/cancel`).set(...auth(o.customer.accessToken)).send({ reason: REASON });
  const requestOf = (o: Placed) => ctx.prisma.orderCancellationRequest.findUniqueOrThrow({ where: { orderId: o.orderId } });
  const statusOf = async (o: Placed) => (await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status;
  const reservationStatuses = async (o: Placed) => (await ctx.prisma.stockReservation.findMany({ where: { id: { in: o.reservationIds } } })).map((r) => r.status).sort();
  /** Make an open request due now and, optionally, look held by a dead process whose lease expired. */
  const makeDue = (o: Placed, deadHolder = false) =>
    ctx.prisma.orderCancellationRequest.update({
      where: { orderId: o.orderId },
      data: { nextAttemptAt: new Date(Date.now() - 1000), ...(deadHolder ? { leaseOwner: 'dead-process', leaseExpiresAt: new Date(Date.now() - 1000) } : {}) },
    });

  /** Every effect exactly once, the original initiator kept. */
  async function expectCancelledOnce(o: Placed, opts: { couponed?: boolean; processedBy?: 'CUSTOMER_REQUEST' | 'SYSTEM_RECOVERY' } = {}) {
    expect(await statusOf(o)).toBe('CANCELLED');
    expect(await reservationStatuses(o)).toEqual(['RELEASED', 'RELEASED']);
    for (const id of o.reservationIds) {
      expect(await ctx.prisma.stockMovement.count({ where: { reservationId: id, type: 'RELEASE' } })).toBe(1);
    }
    const released = (await ctx.prisma.outbox.findMany({ where: { eventType: 'pharmacy.stock.released' } }))
      .map((e) => (e.payload as { payload: { reservationId: string } }).payload.reservationId).filter((id) => o.reservationIds.includes(id));
    expect(released.sort()).toEqual([...o.reservationIds].sort());
    expect(await ctx.prisma.orderStatusHistory.count({ where: { orderId: o.orderId, toStatus: 'CANCELLED' } })).toBe(1);
    const history = await ctx.prisma.orderStatusHistory.findFirstOrThrow({ where: { orderId: o.orderId, toStatus: 'CANCELLED' } });
    expect(history).toMatchObject({ actorUserId: o.customer.userId, actorRole: 'CUSTOMER', reason: REASON });
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'ORDER_CANCELLED', resourceId: o.orderId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: o.customer.userId });
    expect(audits[0].context).toMatchObject({ reason: REASON, ...(opts.processedBy ? { processedBy: opts.processedBy } : {}) });
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'order.cancelled', aggregateId: o.orderId } })).toBe(1);
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.cancelReason).toBe(REASON);
    const redemptions = await ctx.prisma.couponRedemption.findMany({ where: { orderId: o.orderId } });
    expect(redemptions.map((r) => r.status)).toEqual(opts.couponed ? ['REVERSED'] : []);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'COUPON_REVERSED' } })).toBe(opts.couponed ? 1 : 0);
    expect(await requestOf(o)).toMatchObject({ phase: 'COMPLETED', customerUserId: o.customer.userId, reason: REASON, leaseOwner: null, attentionRequiredAt: null });
  }

  describe('the request path', () => {
    it('normal cancellation (with a coupon): every phase in one request, each effect exactly once, coupon reversed after the order commits', async () => {
      const o = await placeOrder({ coupon: true });
      const res = await cancel(o).expect(200);
      expect(body(res).status).toBe('CANCELLED');
      await expectCancelledOnce(o, { couponed: true, processedBy: 'CUSTOMER_REQUEST' });
      const cancelledAt = (await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).cancelledAt!;
      const reversedAt = (await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'COUPON_REVERSED' } })).createdAt;
      expect(reversedAt.getTime()).toBeGreaterThanOrEqual(cancelledAt.getTime());
    });

    it('rejected before any work (a reservation already dispatched): 422, no request row, nothing changed', async () => {
      const o = await placeOrder();
      await request(ctx.server).post(`/pharmacy/orders/${o.fulfillmentId}/accept`).set(...auth(o.pharmacy.accessToken)).expect(200);
      await request(ctx.server).post(`/pharmacy/orders/${o.fulfillmentId}/prepare`).set(...auth(o.pharmacy.accessToken)).expect(200);
      await inventory.dispatch({ reservationId: o.reservationIds[0] });
      const res = await cancel(o).expect(422);
      expect(errorOf(res).code).toBe(ErrorCode.CANCELLATION_NOT_ALLOWED);
      expect(await ctx.prisma.orderCancellationRequest.count()).toBe(0);
      expect(await statusOf(o)).toBe('ACCEPTED');
      expect(await reservationStatuses(o)).toEqual(['CONFIRMED', 'CONFIRMED']);
    });

    it('committed with a side effect pending (coupon reversal fails): 200 CANCELLED; the reconciler reverses the coupon once', async () => {
      const o = await placeOrder({ coupon: true });
      jest.spyOn(coupons, 'reverse').mockRejectedValueOnce(new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Module 07 down'));
      const res = await cancel(o).expect(200);
      expect(body(res).status).toBe('CANCELLED');
      expect(await requestOf(o)).toMatchObject({ phase: 'ORDER_CANCELLED', attempts: 1, lastErrorCode: 'DEPENDENCY_UNAVAILABLE' });
      expect((await ctx.prisma.couponRedemption.findFirstOrThrow({ where: { orderId: o.orderId } })).status).toBe('APPLIED');

      await makeDue(o);
      expect(await reconciler.run()).toMatchObject({ examined: 1, completed: 1 });
      await expectCancelledOnce(o, { couponed: true });
      expect(await reconciler.run()).toMatchObject({ examined: 0 }); // nothing left: no second reversal
    });

    it('transient release failure: 503 PENDING, order and stock untouched; the reconciler finishes it', async () => {
      const o = await placeOrder();
      jest.spyOn(inventory, 'releaseAllUnlessDispatched').mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'P1001' }));
      const res = await cancel(o).expect(503);
      expect(errorOf(res).code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(await statusOf(o)).toBe('PAID');
      expect(await reservationStatuses(o)).toEqual(['CONFIRMED', 'CONFIRMED']);
      expect(await requestOf(o)).toMatchObject({ phase: 'REQUESTED', attempts: 1, lastErrorCode: 'P1001' });

      expect(await reconciler.run()).toMatchObject({ examined: 0 }); // backoff: not yet due
      await makeDue(o);
      expect(await reconciler.run()).toMatchObject({ completed: 1 });
      await expectCancelledOnce(o, { processedBy: 'SYSTEM_RECOVERY' });
    });

    it('permanent release failure (a listing soft-deleted before the H1 guard): 409 NEEDS_ATTENTION; order not cancelled; NO reservation released; visible to operators; never auto-retried', async () => {
      const o = await placeOrder();
      // The H1 guard now refuses this deletion through the API...
      await request(ctx.server).delete(`/inventory/listings/${o.listingIds[0]}`).set(...auth(o.pharmacy.accessToken)).expect(409);
      // ...so the pre-guard state (a listing deleted while holding reservations) is written directly.
      await ctx.prisma.inventoryListing.update({ where: { id: o.listingIds[0] }, data: { deletedAt: new Date() } });
      const res = await cancel(o).expect(409);
      expect(errorOf(res).code).toBe(ErrorCode.CONFLICT);
      expect(await statusOf(o)).toBe('PAID');
      expect(await reservationStatuses(o)).toEqual(['CONFIRMED', 'CONFIRMED']); // all-or-nothing
      const r = await requestOf(o);
      expect(r).toMatchObject({ phase: 'REQUESTED', lastErrorCode: 'LISTING_NOT_FOUND', customerUserId: o.customer.userId, reason: REASON });
      expect(r.attentionRequiredAt).not.toBeNull();

      await makeDue(o);
      expect(await reconciler.run()).toMatchObject({ examined: 0 });
      const admin = await createUserWithRole(ctx, 'ADMIN');
      const view = body(await request(ctx.server).get('/admin/operations/order-cancellations').query({ state: 'ATTENTION' }).set(...auth(admin.accessToken)).expect(200)) as {
        counts: { pending: number; attention: number }; items: Array<Record<string, unknown>>;
      };
      expect(view.counts).toEqual({ pending: 0, attention: 1 });
      expect(view.items).toEqual([expect.objectContaining({ orderId: o.orderId, state: 'ATTENTION', phase: 'REQUESTED', lastErrorCode: 'LISTING_NOT_FOUND' })]);
      expect(JSON.stringify(view)).not.toContain(o.customer.userId);
      expect(JSON.stringify(view)).not.toContain(REASON);
      // A customer retry re-attempts once, and is still refused for the same reason.
      await cancel(o).expect(409);
      expect((await requestOf(o)).attempts).toBe(2);
    });

    it('M1: the request turns REJECTED between createOrGet and claim → 422 CANCELLATION_NOT_ALLOWED, not 503 PENDING; nothing processed', async () => {
      const o = await placeOrder();
      jest.spyOn(inventory, 'releaseAllUnlessDispatched').mockRejectedValueOnce(new Error('flaky'));
      await cancel(o).expect(503); // an open request now exists (REQUESTED, no lease)
      const originalClaim = requests.claim.bind(requests);
      jest.spyOn(requests, 'claim').mockImplementationOnce(async (...args: Parameters<IOrderCancellationRequestRepository['claim']>) => {
        // A concurrent executor records the rejection just before this request's claim.
        await ctx.prisma.orderCancellationRequest.update({ where: { orderId: o.orderId }, data: { phase: 'REJECTED', completedAt: new Date(), lastErrorCode: 'RESERVATIONS_DISPATCHED' } });
        return originalClaim(...args);
      });
      const res = await cancel(o).expect(422);
      expect(errorOf(res).code).toBe(ErrorCode.CANCELLATION_NOT_ALLOWED);
      expect(await requestOf(o)).toMatchObject({ phase: 'REJECTED', leaseOwner: null });
      expect(await statusOf(o)).toBe('PAID');
      expect(await reservationStatuses(o)).toEqual(['CONFIRMED', 'CONFIRMED']);
      // And it stays rejected: a later request answers 422 without reopening it.
      await cancel(o).expect(422);
      expect(await requestOf(o)).toMatchObject({ phase: 'REJECTED' });
    });

    it('exhausted serialization retries in the order step: 503 PENDING with stock released; recovery completes it once', async () => {
      const o = await placeOrder();
      const conflict = () => Object.assign(new Error('write conflict'), { code: 'P2034' });
      const spy = jest.spyOn(orders, 'updateStatus');
      for (let i = 0; i < 5; i += 1) spy.mockRejectedValueOnce(conflict());
      const res = await cancel(o).expect(503);
      expect(errorOf(res).code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(await statusOf(o)).toBe('PAID');
      expect(await reservationStatuses(o)).toEqual(['RELEASED', 'RELEASED']);
      expect(await requestOf(o)).toMatchObject({ phase: 'STOCK_RELEASED', lastErrorCode: 'CONFLICT' });
      // MarkReady cannot proceed meanwhile: the stock is released.
      await makeDue(o);
      expect(await reconciler.run()).toMatchObject({ completed: 1 });
      await expectCancelledOnce(o, { processedBy: 'SYSTEM_RECOVERY' });
    });

    it('a non-retryable order-step failure: 503 PENDING; a customer retry resumes and completes (no second release)', async () => {
      const o = await placeOrder();
      jest.spyOn(orders, 'updateStatus').mockRejectedValueOnce(new Error('connection reset'));
      await cancel(o).expect(503);
      expect(await requestOf(o)).toMatchObject({ phase: 'STOCK_RELEASED' });
      await cancel(o).expect(200);
      await expectCancelledOnce(o, { processedBy: 'CUSTOMER_REQUEST' });
    });
  });

  describe('restart: a dead process at each step boundary is recovered by the reconciler', () => {
    async function interruptedAt(step: 'after-release' | 'after-stock-marker' | 'after-order-commit') {
      const o = await placeOrder({ coupon: true });
      if (step === 'after-release') jest.spyOn(requests, 'advance').mockRejectedValueOnce(new Error('process killed'));
      if (step === 'after-stock-marker') jest.spyOn(orders, 'updateStatus').mockRejectedValueOnce(new Error('process killed'));
      if (step === 'after-order-commit') jest.spyOn(coupons, 'reverse').mockRejectedValueOnce(new Error('process killed'));
      await cancel(o);
      jest.restoreAllMocks();
      await makeDue(o, true);
      return o;
    }

    it('after Module 04 released the stock but before the STOCK_RELEASED marker: the release is safely repeated (no-op)', async () => {
      const o = await interruptedAt('after-release');
      expect(await requestOf(o)).toMatchObject({ phase: 'REQUESTED', leaseOwner: 'dead-process' });
      expect(await reservationStatuses(o)).toEqual(['RELEASED', 'RELEASED']);
      expect(await reconciler.run()).toMatchObject({ completed: 1 });
      await expectCancelledOnce(o, { couponed: true, processedBy: 'SYSTEM_RECOVERY' });
    });

    it('after the STOCK_RELEASED marker but before the order transaction', async () => {
      const o = await interruptedAt('after-stock-marker');
      expect(await requestOf(o)).toMatchObject({ phase: 'STOCK_RELEASED' });
      expect(await statusOf(o)).toBe('PAID');
      expect(await reconciler.run()).toMatchObject({ completed: 1 });
      await expectCancelledOnce(o, { couponed: true, processedBy: 'SYSTEM_RECOVERY' });
    });

    it('after the order committed but before the coupon reversal', async () => {
      const o = await interruptedAt('after-order-commit');
      expect(await requestOf(o)).toMatchObject({ phase: 'ORDER_CANCELLED' });
      expect(await statusOf(o)).toBe('CANCELLED');
      expect(await reconciler.run()).toMatchObject({ completed: 1 });
      await expectCancelledOnce(o, { couponed: true, processedBy: 'CUSTOMER_REQUEST' });
    });

    it('a live lease is respected: a dead holder is only taken over once its lease has expired', async () => {
      const o = await interruptedAt('after-stock-marker');
      await ctx.prisma.orderCancellationRequest.update({ where: { orderId: o.orderId }, data: { leaseOwner: 'alive', leaseExpiresAt: new Date(Date.now() + 60_000) } });
      expect(await reconciler.run()).toMatchObject({ examined: 0 });
      expect(await statusOf(o)).toBe('PAID');
      await makeDue(o, true);
      expect(await reconciler.run()).toMatchObject({ completed: 1 });
      await expectCancelledOnce(o, { couponed: true });
    });
  });

  describe('concurrency', () => {
    /** Parks the next `orders.updateStatus` — the order step, inside its transaction, holding the request's lease. */
    function pauseOrderStep() {
      const original = orders.updateStatus.bind(orders);
      let reached!: () => void;
      let resume!: () => void;
      const atStep = new Promise<void>((r) => (reached = r));
      const gate = new Promise<void>((r) => (resume = r));
      jest.spyOn(orders, 'updateStatus').mockImplementationOnce(async (...args: Parameters<IOrderRepository['updateStatus']>) => {
        reached();
        await gate;
        return original(...args);
      });
      return { atStep, resume };
    }

    it('a customer retry while the reconciler holds the lease gets 503 PENDING and changes nothing; the reconciler completes once', async () => {
      const o = await placeOrder({ coupon: true });
      jest.spyOn(orders, 'updateStatus').mockRejectedValueOnce(new Error('first attempt fails'));
      await cancel(o).expect(503);
      await makeDue(o);

      const pause = pauseOrderStep();
      const running = reconciler.run();
      await pause.atStep;
      const retry = await cancel(o);
      expect(retry.status).toBe(503);
      expect(errorOf(retry).code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
      pause.resume();
      expect(await running).toMatchObject({ completed: 1 });
      await expectCancelledOnce(o, { couponed: true, processedBy: 'SYSTEM_RECOVERY' });
    });

    it('overlapping reconcilers (another instance) and a direct resume: exactly one executor advances the request', async () => {
      const o = await placeOrder({ coupon: true });
      jest.spyOn(orders, 'updateStatus').mockRejectedValueOnce(new Error('first attempt fails'));
      await cancel(o).expect(503);
      await makeDue(o);

      const other = new OrderCancellationReconciler(requests, ctx.app.get(OrderCancellationWorkflow));
      const pause = pauseOrderStep();
      const first = reconciler.run();
      await pause.atStep;
      expect(await other.run()).toMatchObject({ examined: 0 }); // leased: not even listed
      const r = await requestOf(o);
      expect(await ctx.app.get(OrderCancellationWorkflow).resume(r.id)).toBe('BUSY'); // the claim's compare-and-set refuses
      pause.resume();
      expect(await first).toMatchObject({ completed: 1 });
      await expectCancelledOnce(o, { couponed: true });
    });
  });

  describe('operations view', () => {
    it('lists open requests with counts; ADMIN only; validates input', async () => {
      const pending = await placeOrder();
      jest.spyOn(inventory, 'releaseAllUnlessDispatched').mockRejectedValueOnce(new Error('flaky'));
      await cancel(pending).expect(503);
      const admin = await createUserWithRole(ctx, 'ADMIN');
      const res = body(await request(ctx.server).get('/admin/operations/order-cancellations').set(...auth(admin.accessToken)).expect(200)) as {
        counts: { pending: number; attention: number }; items: Array<{ orderId: string; state: string; phase: string }>; total: number;
      };
      expect(res.counts).toEqual({ pending: 1, attention: 0 });
      expect(res.items.map((i) => [i.orderId, i.state, i.phase])).toEqual([[pending.orderId, 'PENDING', 'REQUESTED']]);
      await request(ctx.server).get('/admin/operations/order-cancellations').query({ state: 'DONE' }).set(...auth(admin.accessToken)).expect(400);
      await request(ctx.server).get('/admin/operations/order-cancellations').expect(401);
      await request(ctx.server).get('/admin/operations/order-cancellations').set(...auth(pending.customer.accessToken)).expect(403);
      await request(ctx.server).get('/admin/operations/order-cancellations').set(...auth(pending.pharmacy.accessToken)).expect(403);
    });
  });
});
