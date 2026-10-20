import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import {
  IOrderCancellationRequestRepository,
  ORDER_CANCELLATION_REQUEST_REPOSITORY,
} from '../../src/modules/orders/domain/repositories/order-cancellation-request.repository';
import { ReservationTtlSweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/reservation-ttl.sweeper';
import { auth, body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createStockedPharmacy, placeOrder } from './support';

/**
 * Work 55: a pharmacy decline's internal re-match takes replacement reservations at another pharmacy.
 * They are now confirmed once the order's lines reference them, so the TTL sweeper cannot expire the
 * stock a PAID order relies on, and the new pharmacy can take the order to READY. A customer
 * cancellation racing the decline is forced deterministically: the decline's Phase 3 is parked right
 * after it reads the order's cancellation request, the cancellation runs to completion, and on resume
 * the Serializable conflict makes the decline retry, see the cancellation and re-point nothing.
 */
describe('Pharmacy decline — replacement reservations (e2e, Work 55)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    // This suite runs the TTL sweeper by hand; no background tick may run.
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
    // §3.12 invariant 5: no CANCELLED order holds stock.
    const held = await ctx.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "orders" o JOIN "order_lines" l ON l."orderId" = o."id"
        JOIN "stock_reservations" r ON r."id" = l."reservationId"
       WHERE o."status" = 'CANCELLED' AND r."status" IN ('HELD', 'CONFIRMED')`;
    expect(held[0].n).toBe(0);
  });

  const decline = (o: { pharmacy: { accessToken: string }; fulfillmentId: string }) =>
    request(ctx.server).post(`/pharmacy/orders/${o.fulfillmentId}/decline`).set(...auth(o.pharmacy.accessToken)).send({ reason: 'Out of stock on the shelf' });
  const linesOf = (orderId: string) => ctx.prisma.orderLine.findMany({ where: { orderId } });

  it('a successful decline confirms the replacement reservation; it survives a TTL sweep and the new pharmacy reaches READY', async () => {
    const order = await placeOrder(ctx);
    const other = await createStockedPharmacy(ctx, order.catalogProductId);
    const originalReservation = (await linesOf(order.orderId))[0].reservationId!;

    await decline(order).expect(200);

    const [line] = await linesOf(order.orderId);
    expect(line.reservationId).not.toBe(originalReservation);
    const replacement = await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: line.reservationId! } });
    expect(replacement.status).toBe('CONFIRMED');
    expect((await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: originalReservation } })).status).toBe('RELEASED');

    // Past its TTL: the sweeper only expires HELD holds, so the confirmed replacement stays.
    await ctx.prisma.stockReservation.update({ where: { id: replacement.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect(await ctx.app.get(ReservationTtlSweeper).run()).toBe(0);
    expect((await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: replacement.id } })).status).toBe('CONFIRMED');

    const newFulfillment = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId: order.orderId, status: 'PENDING' } });
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${newFulfillment.id}/${action}`).set(...auth(other.accessToken)).expect(200);
    }
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('READY');
    expect(await ctx.prisma.stockMovement.count({ where: { reservationId: replacement.id, type: 'DISPATCH' } })).toBeGreaterThan(0);
  });

  it('a customer cancellation that wins the race with the decline: no new fulfillment, no re-pointed line, replacement holds released', async () => {
    const order = await placeOrder(ctx);
    await createStockedPharmacy(ctx, order.catalogProductId);
    const before = await linesOf(order.orderId);

    // Park the decline's Phase 3 just after it reads the order's cancellation request (none yet).
    const requests = ctx.app.get<IOrderCancellationRequestRepository>(ORDER_CANCELLATION_REQUEST_REPOSITORY);
    const original = requests.findByOrderId.bind(requests);
    let reached!: () => void;
    let resume!: () => void;
    const atPhase3 = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (resume = r));
    jest.spyOn(requests, 'findByOrderId').mockImplementationOnce(async (orderId: string, tx?: unknown) => {
      const found = await original(orderId, tx);
      reached();
      await gate;
      return found;
    });

    const declining = decline(order).then((r) => r);
    await atPhase3;
    // The customer cancels to completion while the decline's transaction is open.
    await request(ctx.server).post(`/orders/${order.orderId}/cancel`).set(...auth(order.customer.accessToken)).send({ reason: 'Changed my mind today' }).expect(200);
    resume();

    const res = await declining;
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({ orderCancelled: true, newFulfillment: null });

    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('CANCELLED');
    expect(await ctx.prisma.fulfillment.count({ where: { orderId: order.orderId, status: 'PENDING' } })).toBe(0);
    const after = await linesOf(order.orderId);
    expect(after.map((l) => l.reservationId)).toEqual(before.map((l) => l.reservationId)); // not re-pointed
    // Every reservation for this order — original and replacement — is released; nothing confirmed or held.
    const all = await ctx.prisma.stockReservation.findMany({ where: { orderId: order.orderId } });
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map((r) => r.status).every((s) => s === 'RELEASED')).toBe(true);
  });
});
