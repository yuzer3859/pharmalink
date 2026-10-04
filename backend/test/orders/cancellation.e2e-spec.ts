import request from 'supertest';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder } from './support';

/**
 * Cancellation (`06-orders-spec.md` §12.3's `cancellation.e2e-spec.ts`: "Cancel before `READY`
 * releases the real Module 04 reservation; cancel attempt at/after `READY` →
 * `422 CANCELLATION_NOT_ALLOWED`").
 *
 * Everything runs through the real HTTP surface against real Postgres with real Module 04
 * inventory state — `IInventoryPort.release()` is **not** mocked, so the reservation rows and the
 * listing's `reserved` counter are asserted as the real thing (§12.3's explicit "real Module 04
 * reservation" requirement, and the audit's finding that the previous coverage was unit-only).
 */
describe('Orders — cancellation lifecycle and reservation release (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const CANCEL_REASON = 'No longer need this medication';

  // -------------------------------------------------------------------------------------------
  // Pre-READY cancellation, in each Slice-1 status CancellationPolicy allows (§3.5)
  // -------------------------------------------------------------------------------------------

  it('cancels a PAID order, recording status, history, audit and event together', async () => {
    const { customer, orderId } = await placeOrder(ctx);

    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: CANCEL_REASON })
      .expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CANCELLED');
    expect(order.cancelReason).toBe(CANCEL_REASON);
    expect(order.cancelledAt).not.toBeNull();

    const history = await ctx.prisma.orderStatusHistory.findMany({
      where: { orderId, toStatus: 'CANCELLED' },
    });
    expect(history).toHaveLength(1);
    expect(history[0].fromStatus).toBe('PAID');

    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ORDER_CANCELLED', resourceId: orderId } }),
    ).toBe(1);
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.cancelled', aggregateId: orderId } }),
    ).toBe(1);
  });

  it('cancels an ACCEPTED order (still pre-READY per §3.5)', async () => {
    const { customer, pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);
    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/accept`)
      .set(...auth(pharmacy.accessToken))
      .expect(200);

    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: CANCEL_REASON })
      .expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CANCELLED');
    const history = await ctx.prisma.orderStatusHistory.findMany({
      where: { orderId, toStatus: 'CANCELLED' },
    });
    expect(history[0].fromStatus).toBe('ACCEPTED');
  });

  it('cancels while the fulfillment is PREPARING (the order is still pre-READY)', async () => {
    const { customer, pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);
    for (const action of ['accept', 'prepare']) {
      await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/${action}`)
        .set(...auth(pharmacy.accessToken))
        .expect(200);
    }

    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: CANCEL_REASON })
      .expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CANCELLED');
    // §3.5/§6: cancellation is an Order-level decision; Slice 1 defines no Fulfillment-side
    // cascade for it, so the fulfillment row is left as the pharmacy last set it.
    const fulfillment = await ctx.prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
    });
    expect(fulfillment.status).toBe('PREPARING');
  });

  // -------------------------------------------------------------------------------------------
  // Real Module 04 reservation release (§3.12 invariant 5)
  // -------------------------------------------------------------------------------------------

  it('releases the real Module 04 reservation and returns the stock to the listing', async () => {
    const { customer, orderId } = await placeOrder(ctx);
    const line = await ctx.prisma.orderLine.findFirstOrThrow({ where: { orderId } });
    const reservationId = line.reservationId as string;

    // Checkout confirmed the hold (dc033e4), and the listing is holding the ordered quantity.
    const before = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    expect(before.status).toBe('CONFIRMED');
    const listingBefore = await ctx.prisma.inventoryListing.findUniqueOrThrow({
      where: { id: before.listingId },
    });
    expect(listingBefore.reserved).toBe(before.quantity);

    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: CANCEL_REASON })
      .expect(200);

    const after = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    expect(after.status).toBe('RELEASED');

    // The hold is genuinely returned — this is real Module 04 state, not a mocked port call.
    const listingAfter = await ctx.prisma.inventoryListing.findUniqueOrThrow({
      where: { id: before.listingId },
    });
    expect(listingAfter.reserved).toBe(listingBefore.reserved - before.quantity);
    expect(listingAfter.sellable).toBeGreaterThan(listingBefore.sellable);
    // Releasing a confirmed hold restores availability without dispatching anything.
    expect(listingAfter.onHand).toBe(listingBefore.onHand);
    expect(
      await ctx.prisma.stockMovement.count({ where: { reservationId, type: 'DISPATCH' } }),
    ).toBe(0);
  });

  it('never leaves a CANCELLED order holding stock (§3.12 invariant 5)', async () => {
    const { customer, orderId } = await placeOrder(ctx);

    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: CANCEL_REASON })
      .expect(200);

    const lines = await ctx.prisma.orderLine.findMany({ where: { orderId } });
    for (const line of lines) {
      if (!line.reservationId) continue;
      const reservation = await ctx.prisma.stockReservation.findUniqueOrThrow({
        where: { id: line.reservationId },
      });
      expect(['RELEASED', 'EXPIRED']).toContain(reservation.status);
    }
  });

  it('is idempotent enough to be retried: a second cancel is refused, not double-released', async () => {
    // `ReleaseReservationCommand` is a no-op on an already-terminal reservation, and the order
    // state machine refuses the second transition — so a client retry cannot double-release.
    const { customer, orderId } = await placeOrder(ctx);
    const line = await ctx.prisma.orderLine.findFirstOrThrow({ where: { orderId } });

    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: CANCEL_REASON })
      .expect(200);

    const second = await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: CANCEL_REASON });
    expect(second.status).toBe(422);
    expect(errorOf(second).code).toBe(ErrorCode.CANCELLATION_NOT_ALLOWED);

    expect(
      await ctx.prisma.orderStatusHistory.count({ where: { orderId, toStatus: 'CANCELLED' } }),
    ).toBe(1);
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.cancelled', aggregateId: orderId } }),
    ).toBe(1);
    const reservation = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: line.reservationId as string },
    });
    expect(reservation.status).toBe('RELEASED');
  });

  // -------------------------------------------------------------------------------------------
  // Post-READY cancellation (§3.5 / §10 CANCELLATION_NOT_ALLOWED) — real HTTP path
  // -------------------------------------------------------------------------------------------

  it('refuses cancellation once the order is READY with 422 CANCELLATION_NOT_ALLOWED', async () => {
    const { customer, pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/${action}`)
        .set(...auth(pharmacy.accessToken))
        .expect(200);
    }

    const res = await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: CANCEL_REASON });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe(ErrorCode.CANCELLATION_NOT_ALLOWED);

    // The refusal changed nothing: stock stays dispatched and no cancellation was recorded.
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('READY');
    expect(order.cancelledAt).toBeNull();
    expect(
      await ctx.prisma.orderStatusHistory.count({ where: { orderId, toStatus: 'CANCELLED' } }),
    ).toBe(0);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'order.cancelled' } })).toBe(0);

    const line = await ctx.prisma.orderLine.findFirstOrThrow({ where: { orderId } });
    const reservation = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: line.reservationId as string },
    });
    // Dispatch leaves the reservation CONFIRMED (module-04 §14.7) — a refused cancel must not
    // release stock that has already physically left the pharmacy.
    expect(reservation.status).toBe('CONFIRMED');
    expect(
      await ctx.prisma.stockMovement.count({ where: { reservationId: reservation.id, type: 'DISPATCH' } }),
    ).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------------------------

  it('does not let another customer cancel an order they do not own', async () => {
    const { orderId } = await placeOrder(ctx);
    const { customer: stranger } = await placeOrder(ctx);

    const res = await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(stranger.accessToken))
      .send({ reason: CANCEL_REASON });

    // Not-yours is indistinguishable from not-found (§7's no-existence-leakage discipline).
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe(ErrorCode.ORDER_NOT_FOUND);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAID');
  });
});
