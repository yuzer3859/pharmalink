import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { IMatchingPort, MATCHING_PORT } from '../../src/modules/prescription-matching/application/ports/inbound/matching.port';
import { IInventoryPort, INVENTORY_PORT } from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createCustomer, createPricedProduct, createStockedPharmacy, placeOrder, PlacedOrder, readyToCheckout } from '../orders/support';

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

  // ── Work 55 integration: additional coverage for the adopted bind ─────────────────────────────

  const releaseCount = (reservationIds: string[]) =>
    ctx.prisma.stockMovement.count({ where: { reservationId: { in: reservationIds }, type: 'RELEASE' } });

  it.each(['rematch', 'select'] as const)('an ACCEPTED order’s request: customer %s → 409, reservation CONFIRMED, no RELEASE', async (action) => {
    const order = await placeOrder(ctx);
    await createStockedPharmacy(ctx, order.catalogProductId);
    const matchRequestId = await matchRequestIdFromInbox(order);
    await pharmacyAction(order, 'accept').expect(200);
    expect((await orderState(order.orderId)).order.status).toBe('ACCEPTED');

    const res = await customerCall(order, matchRequestId, action);
    expect([res.status, errorOf(res).code]).toEqual([409, 'MATCH_REQUEST_ORDER_BOUND']);
    const after = await orderState(order.orderId);
    expect(after.reservations.map((r) => r.status)).toEqual(['CONFIRMED']);
    expect(await releaseCount(after.lines.map((l) => l.reservationId!))).toBe(0);
  });

  it('a partially dispatched order is protected: rematch → 409 and no RELEASE movement for any of its reservations', async () => {
    const ready = await readyToCheckout(ctx, { quantity: 2, stock: 20 });
    const productB = await createPricedProduct(ctx);
    await request(ctx.server).post('/inventory/listings').set(...auth(ready.pharmacy.accessToken)).send({
      catalogProductId: productB, branchId: ready.pharmacy.branchId, price: 2500, batchNumber: 'B-2',
      initialQuantity: 20, expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }).expect(201);
    await ctx.prisma.cartItem.create({ data: { cartId: ready.cartId, catalogProductId: productB, quantity: 3, indicativePrice: 2500 } });
    const orderId = body(await request(ctx.server).post('/checkout').set(...auth(ready.user.accessToken)).send({ addressId: ready.addressId, idempotencyKey: randomUUID() }).expect(201)).orderId as string;
    const fulfillmentId = (await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId } })).id;
    const order = { customer: ready.user, pharmacy: ready.pharmacy, catalogProductId: ready.catalogProductId, orderId, fulfillmentId } as PlacedOrder;
    await pharmacyAction(order, 'accept').expect(200);
    await pharmacyAction(order, 'prepare').expect(200);
    const reservationIds = (await ctx.prisma.orderLine.findMany({ where: { orderId }, orderBy: { id: 'asc' } })).map((l) => l.reservationId!);
    await ctx.app.get<IInventoryPort>(INVENTORY_PORT).dispatch({ reservationId: reservationIds[0] }); // MarkReady failed midway
    const matchRequestId = (await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).matchRequestId!;

    const res = await customerCall(order, matchRequestId, 'rematch');
    expect([res.status, errorOf(res).code]).toEqual([409, 'MATCH_REQUEST_ORDER_BOUND']);
    expect(await releaseCount(reservationIds)).toBe(0);
    expect((await ctx.prisma.stockReservation.findMany({ where: { id: { in: reservationIds } } })).map((r) => r.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('the match request is already bound to the order id when checkout’s select runs — no unbound window', async () => {
    const port = ctx.app.get<IMatchingPort>(MATCHING_PORT);
    const original = port.select.bind(port);
    let boundAtSelect: string | null | undefined;
    jest.spyOn(port, 'select').mockImplementationOnce(async (input) => {
      boundAtSelect = (await ctx.prisma.matchRequest.findUniqueOrThrow({ where: { id: input.matchRequestId } })).orderId;
      return original(input);
    });
    const order = await placeOrder(ctx);
    expect(boundAtSelect).toBe(order.orderId);
    jest.restoreAllMocks();
  });

  it('the backfill binds an old (unbound) order request — then customer rematch is refused; unrelated requests are untouched', async () => {
    const order = await placeOrder(ctx);
    await createStockedPharmacy(ctx, order.catalogProductId);
    const matchRequestId = await matchRequestIdFromInbox(order);
    // The pre-change state: an order's match request without orderId.
    await ctx.prisma.matchRequest.update({ where: { id: matchRequestId }, data: { orderId: null } });
    // A standalone (no order) request, and one already bound elsewhere, must not change.
    const standalone = await ctx.prisma.matchRequest.create({ data: { customerUserId: order.customer.userId } });
    const otherOrderId = randomUUID();
    const bound = await ctx.prisma.matchRequest.create({ data: { customerUserId: order.customer.userId, orderId: otherOrderId } });

    const sql = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema', 'migrations', '20261015000000_module05_bind_match_request_order', 'migration.sql'), 'utf8');
    await ctx.prisma.$executeRawUnsafe(sql);

    expect((await ctx.prisma.matchRequest.findUniqueOrThrow({ where: { id: matchRequestId } })).orderId).toBe(order.orderId);
    expect((await ctx.prisma.matchRequest.findUniqueOrThrow({ where: { id: standalone.id } })).orderId).toBeNull();
    expect((await ctx.prisma.matchRequest.findUniqueOrThrow({ where: { id: bound.id } })).orderId).toBe(otherOrderId);
    const res = await customerCall(order, matchRequestId, 'rematch');
    expect([res.status, errorOf(res).code]).toEqual([409, 'MATCH_REQUEST_ORDER_BOUND']);
    expect((await orderState(order.orderId)).reservations.map((r) => r.status)).toEqual(['CONFIRMED']);
  });

  it('ordinary customer matching without an order still rematches (unbound request)', async () => {
    const productId = await createPricedProduct(ctx);
    const first = await createStockedPharmacy(ctx, productId);
    const backup = await createStockedPharmacy(ctx, productId);
    const customer = await createCustomer(ctx);
    const lines = [{ catalogProductId: productId, quantity: 1 }];
    const found = body(await request(ctx.server).post('/matching/find').set(...auth(customer.accessToken)).send({ lines, deliveryLat: 9.02, deliveryLng: 38.75 }).expect(201));
    const id = (found.matchRequest as { id: string }).id;
    expect((await ctx.prisma.matchRequest.findUniqueOrThrow({ where: { id } })).orderId).toBeNull();
    await request(ctx.server).post(`/matching/${id}/select`).set(...auth(customer.accessToken)).send({ pharmacyId: first.pharmacyId, lines }).expect(200);
    const rematched = body(await request(ctx.server).post(`/matching/${id}/rematch`).set(...auth(customer.accessToken)).send({ lines }).expect(200));
    expect(rematched.status).toBe('MATCHED');
    expect((rematched.chosenResult as { pharmacyId: string }).pharmacyId).toBe(backup.pharmacyId);
  });
});
