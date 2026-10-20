import request from 'supertest';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createStockedPharmacy, placeOrder, PlacedOrder } from '../orders/support';

interface Item {
  type: string | null;
  data: Record<string, unknown>;
}

/**
 * Module 05/06 seam: checkout's own match request stays `MATCHED` (the pharmacy-decline flow
 * rematches it), its id reaches the customer through the `MATCHING_ORDER_MATCHED` notification,
 * and `POST /matching/:id/select|rematch` is open to the customer (`matching:create:own`).
 *
 * Checkout binds the match request to its pre-allocated order id, so those customer routes refuse
 * it with `MATCH_REQUEST_ORDER_BOUND` before touching any reservation; before that bind, a
 * customer rematch released the paid order's reservations and the pharmacy's mark-ready failed
 * with `INVALID_RESERVATION_STATE`. Module 06's own in-process rematch (decline) still works.
 */
describe('Rematch of a placed order’s match request (e2e)', () => {
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

  async function matchRequestIdFromInbox(order: PlacedOrder): Promise<string> {
    await ctx.drainOutbox();
    const items = (
      body(await request(ctx.server).get('/notifications').set(...auth(order.customer.accessToken)).expect(200)) as {
        items: Item[];
      }
    ).items;
    const matched = items.find((i) => i.type === 'MATCHING_ORDER_MATCHED');
    expect(matched).toBeDefined();
    return matched!.data.matchRequestId as string;
  }

  const customerCall = (order: PlacedOrder, matchRequestId: string, action: 'rematch' | 'select') =>
    request(ctx.server)
      .post(`/matching/${matchRequestId}/${action}`)
      .set(...auth(order.customer.accessToken))
      .send({ lines: [{ catalogProductId: order.catalogProductId, quantity: 2 }] });

  const pharmacyAction = (order: PlacedOrder, action: string, token = order.pharmacy.accessToken, fulfillmentId = order.fulfillmentId) =>
    request(ctx.server).post(`/pharmacy/orders/${fulfillmentId}/${action}`).set(...auth(token));

  async function orderState(orderId: string) {
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const lines = await ctx.prisma.orderLine.findMany({ where: { orderId } });
    const reservations = await ctx.prisma.stockReservation.findMany({
      where: { id: { in: lines.map((l) => l.reservationId!) } },
      include: { listing: true },
    });
    return { order, lines, reservations };
  }

  it('checkout binds its match request and reservations to the order it places', async () => {
    const order = await placeOrder(ctx);
    const matchRequestId = await matchRequestIdFromInbox(order);

    const { order: placed, reservations } = await orderState(order.orderId);
    expect(placed.matchRequestId).toBe(matchRequestId);
    const mr = await ctx.prisma.matchRequest.findUniqueOrThrow({ where: { id: matchRequestId } });
    expect([mr.status, mr.customerUserId, mr.orderId]).toEqual(['MATCHED', order.customer.userId, order.orderId]);
    expect(reservations.map((r) => r.orderId)).toEqual([order.orderId]);
  });

  it.each(['rematch', 'select'] as const)(
    'customer %s of the order’s match request → 409 MATCH_REQUEST_ORDER_BOUND, reservations untouched, dispatch still works',
    async (action) => {
      const order = await placeOrder(ctx);
      await createStockedPharmacy(ctx, order.catalogProductId);
      const matchRequestId = await matchRequestIdFromInbox(order);
      const mrBefore = await ctx.prisma.matchRequest.findUniqueOrThrow({ where: { id: matchRequestId } });

      const res = await customerCall(order, matchRequestId, action);
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('MATCH_REQUEST_ORDER_BOUND');

      const mrAfter = await ctx.prisma.matchRequest.findUniqueOrThrow({ where: { id: matchRequestId } });
      expect([mrAfter.status, mrAfter.chosenResult]).toEqual([mrBefore.status, mrBefore.chosenResult]);
      const after = await orderState(order.orderId);
      expect(after.order.status).toBe('PAID');
      expect(after.reservations.map((r) => [r.status, r.listing.reserved])).toEqual([['CONFIRMED', 2]]);
      // No stray hold was taken anywhere.
      expect(await ctx.prisma.stockReservation.count()).toBe(1);

      expect((await pharmacyAction(order, 'accept')).status).toBe(200);
      expect((await pharmacyAction(order, 'prepare')).status).toBe(200);
      expect((await pharmacyAction(order, 'ready')).status).toBe(200);
      // Dispatch has no reservation status of its own (module-04): it is the DISPATCH movement.
      const [reservation] = (await orderState(order.orderId)).reservations;
      expect(
        await ctx.prisma.stockMovement.count({ where: { reservationId: reservation.id, type: 'DISPATCH' } }),
      ).toBeGreaterThan(0);
    },
  );

  it('pharmacy decline still rematches the bound request in-process and repoints the order', async () => {
    const order = await placeOrder(ctx);
    const other = await createStockedPharmacy(ctx, order.catalogProductId);
    const before = await orderState(order.orderId);

    await pharmacyAction(order, 'decline').send({ reason: 'Out of stock on the shelf' }).expect(200);

    const after = await orderState(order.orderId);
    expect(after.order.status).toBe('PAID');
    expect(after.lines[0].pharmacyId).toBe(other.pharmacyId);
    expect(after.lines[0].reservationId).not.toBe(before.lines[0].reservationId);
    expect(after.reservations.map((r) => [r.orderId, r.listing.branchId])).toEqual([[order.orderId, other.branchId]]);
    const original = await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: before.lines[0].reservationId! } });
    expect(original.status).toBe('RELEASED');
  });
});
