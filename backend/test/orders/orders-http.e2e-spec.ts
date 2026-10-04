import { randomUUID } from 'crypto';
import request from 'supertest';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { grantOrgRole } from '../pharmacy-inventory/support';
import { auth, body, errorOf, grantRoleDirect, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import {
  createCustomer,
  createPricedProduct,
  createStockedPharmacy,
  placeOrder,
  setProductPrice,
} from './support';

/**
 * Module 06 HTTP layer — cart (§9.1), orders (§9.3) and pharmacy fulfillment (§9.4). Exercises
 * the real controller/guard/filter pipeline against real Postgres, following
 * `test/prescription-matching/http-interface.e2e-spec.ts`'s conventions. `POST /checkout` (§9.2)
 * has its own suite in `checkout-http.e2e-spec.ts`.
 *
 * The §9.4 block exercises the real `Pharmacy.id` -> `Organization.id` ownership relationship —
 * the fixture grants roles at the `Organization`, while fulfillments are keyed by `Pharmacy.id`,
 * so a test that passed here could not pass against the previous conflated implementation.
 *
 * Scope is the HTTP boundary: authentication, permission gating, ownership scoping, DTO
 * validation, and application-error -> HTTP-status mapping. The commands' internal state
 * machines, transactions and cross-module effects are already unit tested and are not re-proven
 * here.
 */
/** `body()` returns `Record<string, unknown>`; these narrow the two nested shapes these specs
 * assert on (§9.1/§9.2 `totals` and `items[]`) without sprinkling casts through every assertion. */
function totalsOf(payload: Record<string, unknown>): Record<string, number> {
  return payload.totals as Record<string, number>;
}
function itemsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return payload.items as Array<Record<string, unknown>>;
}

describe('Orders — cart / orders / pharmacy HTTP interface (e2e)', () => {
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

  /** A logged-in user holding no order permissions at all (registration grants CUSTOMER, so the
   * auto-grant is removed first — otherwise a permission test would assert nothing). */
  async function userWithoutOrderPermissions() {
    const user = await registerAndVerify(ctx);
    await ctx.prisma.userRole.deleteMany({ where: { userId: user.userId } });
    await grantRoleDirect(ctx, user.userId, 'DRIVER');
    return login(ctx, user.phone, user.password);
  }

  describe('Cart (§9.1)', () => {
    it('returns null for a customer who has never added an item (no cart is auto-created)', async () => {
      const customer = await createCustomer(ctx);

      const res = await request(ctx.server)
        .get('/cart')
        .set(...auth(customer.accessToken))
        .expect(200);

      expect(body(res)).toBeNull();
      expect(await ctx.prisma.cart.count()).toBe(0);
    });

    it('adds an item, lazily creating the cart, and reflects it in GET /cart', async () => {
      const customer = await createCustomer(ctx);
      const catalogProductId = await createPricedProduct(ctx);

      await request(ctx.server)
        .post('/cart/items')
        .set(...auth(customer.accessToken))
        .send({ catalogProductId, quantity: 3 })
        .expect(201);

      const cart = body(
        await request(ctx.server)
          .get('/cart')
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect(cart.customerUserId).toBe(customer.userId);
      expect(cart.items).toEqual([
        expect.objectContaining({ catalogProductId, quantity: 3, requiresRx: false }),
      ]);
    });

    it('updates a line quantity, removes a line, and clears the cart', async () => {
      const customer = await createCustomer(ctx);
      const catalogProductId = await createPricedProduct(ctx);
      await request(ctx.server)
        .post('/cart/items')
        .set(...auth(customer.accessToken))
        .send({ catalogProductId, quantity: 1 })
        .expect(201);

      const initial = body(
        await request(ctx.server).get('/cart').set(...auth(customer.accessToken)).expect(200),
      );
      const itemId = (initial.items as Array<{ id: string }>)[0].id;

      await request(ctx.server)
        .patch(`/cart/items/${itemId}`)
        .set(...auth(customer.accessToken))
        .send({ quantity: 7 })
        .expect(200);
      const updated = body(
        await request(ctx.server).get('/cart').set(...auth(customer.accessToken)).expect(200),
      );
      expect((updated.items as Array<{ quantity: number }>)[0].quantity).toBe(7);

      await request(ctx.server)
        .delete(`/cart/items/${itemId}`)
        .set(...auth(customer.accessToken))
        .expect(200);
      const emptied = body(
        await request(ctx.server).get('/cart').set(...auth(customer.accessToken)).expect(200),
      );
      expect(emptied.items).toEqual([]);

      // Clearing an already-empty cart is a no-op, not an error.
      await request(ctx.server)
        .delete('/cart')
        .set(...auth(customer.accessToken))
        .expect(200);
    });

    it('returns live totals priced from the current catalog read (spec 9.1)', async () => {
      const customer = await createCustomer(ctx);
      const catalogProductId = await createPricedProduct(ctx);
      await request(ctx.server)
        .post('/cart/items')
        .set(...auth(customer.accessToken))
        .send({ catalogProductId, quantity: 2 })
        .expect(201);

      const cart = body(
        await request(ctx.server).get('/cart').set(...auth(customer.accessToken)).expect(200),
      );

      expect(totalsOf(cart).subtotal).toBe(5000); // 2500 x 2 from Catalog
      expect(totalsOf(cart).currency).toBe('ETB');
      expect(totalsOf(cart).grandTotal).toEqual(expect.any(Number));
    });

    it('validates the cart against fresh catalog/inventory data (spec 9.1)', async () => {
      const customer = await createCustomer(ctx);
      const catalogProductId = await createPricedProduct(ctx);
      await createStockedPharmacy(ctx, catalogProductId, 50);
      await request(ctx.server)
        .post('/cart/items')
        .set(...auth(customer.accessToken))
        .send({ catalogProductId, quantity: 2 })
        .expect(201);

      const unchanged = body(
        await request(ctx.server)
          .post('/cart/validate')
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect(itemsOf(unchanged)).toHaveLength(1);
      expect(itemsOf(unchanged)[0]).toMatchObject({
        catalogProductId,
        priceChanged: false,
        stillAvailable: true,
      });
      expect(unchanged.readyForCheckout).toBe(true);
      expect(totalsOf(unchanged).subtotal).toBe(5000);

      // Reprice through Module 03's own admin contract; validate must flag it and reconcile the
      // cached baseline so the customer can proceed (parent doc F-CRT-06).
      await setProductPrice(ctx, catalogProductId, 3100);

      const changed = body(
        await request(ctx.server)
          .post('/cart/validate')
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect(itemsOf(changed)[0]).toMatchObject({
        priceChanged: true,
        previousPrice: 2500,
        unitPrice: 3100,
        stillAvailable: true,
      });
      expect(totalsOf(changed).subtotal).toBe(6200);

      const item = await ctx.prisma.cartItem.findFirstOrThrow({ where: { catalogProductId } });
      expect(item.indicativePrice).toBe(3100);
      // Validation reports and reconciles price only — it never changes cart contents.
      expect(item.quantity).toBe(2);
      expect(await ctx.prisma.cartItem.count({ where: { cartId: item.cartId } })).toBe(1);
    });

    it('reports an out-of-stock line as not ready for checkout', async () => {
      const customer = await createCustomer(ctx);
      const catalogProductId = await createPricedProduct(ctx);
      await createStockedPharmacy(ctx, catalogProductId, 1);
      await request(ctx.server)
        .post('/cart/items')
        .set(...auth(customer.accessToken))
        .send({ catalogProductId, quantity: 5 })
        .expect(201);

      const data = body(
        await request(ctx.server)
          .post('/cart/validate')
          .set(...auth(customer.accessToken))
          .expect(200),
      );

      expect(itemsOf(data)[0].stillAvailable).toBe(false);
      expect(data.readyForCheckout).toBe(false);
    });

    it('reports an empty cart as not ready for checkout', async () => {
      const customer = await createCustomer(ctx);

      const data = body(
        await request(ctx.server)
          .post('/cart/validate')
          .set(...auth(customer.accessToken))
          .expect(200),
      );

      expect(itemsOf(data)).toEqual([]);
      expect(data.readyForCheckout).toBe(false);
      expect(data.totals).toBeNull();
    });

    it('does not let one customer touch another customer’s cart item', async () => {
      const owner = await createCustomer(ctx);
      const intruder = await createCustomer(ctx);
      const catalogProductId = await createPricedProduct(ctx);
      await request(ctx.server)
        .post('/cart/items')
        .set(...auth(owner.accessToken))
        .send({ catalogProductId, quantity: 1 })
        .expect(201);
      const cart = body(
        await request(ctx.server).get('/cart').set(...auth(owner.accessToken)).expect(200),
      );
      const itemId = (cart.items as Array<{ id: string }>)[0].id;

      await request(ctx.server)
        .patch(`/cart/items/${itemId}`)
        .set(...auth(intruder.accessToken))
        .send({ quantity: 99 })
        .expect(404);

      // And the owner's line is untouched.
      const after = body(
        await request(ctx.server).get('/cart').set(...auth(owner.accessToken)).expect(200),
      );
      expect((after.items as Array<{ quantity: number }>)[0].quantity).toBe(1);
    });

    it.each([
      ['non-uuid catalogProductId', { catalogProductId: 'nope', quantity: 1 }],
      ['zero quantity', { catalogProductId: randomUUID(), quantity: 0 }],
      ['non-integer quantity', { catalogProductId: randomUUID(), quantity: 1.5 }],
      ['unknown field', { catalogProductId: randomUUID(), quantity: 1, foo: 'bar' }],
    ])('rejects %s on POST /cart/items with 400', async (_label, payload) => {
      const customer = await createCustomer(ctx);

      const res = await request(ctx.server)
        .post('/cart/items')
        .set(...auth(customer.accessToken))
        .send(payload)
        .expect(400);

      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('requires authentication and the order:create:own permission', async () => {
      await request(ctx.server).get('/cart').expect(401);

      const unpermitted = await userWithoutOrderPermissions();
      const res = await request(ctx.server)
        .get('/cart')
        .set(...auth(unpermitted.accessToken))
        .expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    });
  });

  describe('Orders (§9.3)', () => {
    it('lists, filters and paginates the caller’s own orders', async () => {
      const { customer } = await placeOrder(ctx);

      const listed = body(
        await request(ctx.server)
          .get('/orders')
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect(listed.total).toBe(1);
      expect((listed.items as Array<{ customerUserId: string }>)[0].customerUserId).toBe(
        customer.userId,
      );

      const filtered = body(
        await request(ctx.server)
          .get('/orders?status=PAID&page=1&size=10')
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect(filtered.total).toBe(1);

      const otherStatus = body(
        await request(ctx.server)
          .get('/orders?status=CANCELLED')
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect(otherStatus.total).toBe(0);
    });

    it('never lists another customer’s orders', async () => {
      await placeOrder(ctx);
      const stranger = await createCustomer(ctx);

      const listed = body(
        await request(ctx.server)
          .get('/orders')
          .set(...auth(stranger.accessToken))
          .expect(200),
      );
      expect(listed).toEqual({ items: [], total: 0 });
    });

    it('returns order detail with status history, and the invoice', async () => {
      const { customer, orderId } = await placeOrder(ctx);

      const detail = body(
        await request(ctx.server)
          .get(`/orders/${orderId}`)
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect((detail.order as { id: string }).id).toBe(orderId);
      expect(detail.lines).toHaveLength(1);
      // Placement writes DRAFT->PENDING_PAYMENT and PENDING_PAYMENT->PAID.
      expect((detail.statusHistory as unknown[]).length).toBeGreaterThanOrEqual(2);

      const invoice = body(
        await request(ctx.server)
          .get(`/orders/${orderId}/invoice`)
          .set(...auth(customer.accessToken))
          .expect(200),
      );
      expect(invoice.orderId).toBe(orderId);
      expect(invoice.invoiceNumber).toEqual(expect.any(String));
      expect(invoice.pdfRef).toBeNull();
    });

    it('hides another customer’s order behind ORDER_NOT_FOUND (no existence leakage)', async () => {
      const { orderId } = await placeOrder(ctx);
      const stranger = await createCustomer(ctx);

      for (const path of [`/orders/${orderId}`, `/orders/${orderId}/invoice`]) {
        const res = await request(ctx.server)
          .get(path)
          .set(...auth(stranger.accessToken))
          .expect(404);
        expect(errorOf(res).code).toBe(ErrorCode.ORDER_NOT_FOUND);
      }
    });

    it('cancels an owned order and records the transition', async () => {
      const { customer, orderId } = await placeOrder(ctx);

      await request(ctx.server)
        .post(`/orders/${orderId}/cancel`)
        .set(...auth(customer.accessToken))
        .send({ reason: 'Ordered by mistake' })
        .expect(200);

      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('CANCELLED');
      expect(order.cancelReason).toBe('Ordered by mistake');
    });

    it('rejects a cancel with a missing/short reason with 400', async () => {
      const { customer, orderId } = await placeOrder(ctx);

      for (const payload of [{}, { reason: 'x' }]) {
        const res = await request(ctx.server)
          .post(`/orders/${orderId}/cancel`)
          .set(...auth(customer.accessToken))
          .send(payload)
          .expect(400);
        expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });

    it('requires authentication and the order:read:own permission', async () => {
      await request(ctx.server).get('/orders').expect(401);

      const unpermitted = await userWithoutOrderPermissions();
      await request(ctx.server)
        .get('/orders')
        .set(...auth(unpermitted.accessToken))
        .expect(403);
    });
  });


  describe('Pharmacy fulfillment (§9.4)', () => {
    it('lists only the caller’s own organization’s fulfillments', async () => {
      const { pharmacy, fulfillmentId } = await placeOrder(ctx);

      const listed = body(
        await request(ctx.server)
          .get('/pharmacy/orders')
          .set(...auth(pharmacy.accessToken))
          .expect(200),
      );
      expect(listed.total).toBe(1);
      expect((listed.items as Array<{ id: string }>)[0].id).toBe(fulfillmentId);
    });

    it('does not leak another organization’s fulfillments into the listing', async () => {
      await placeOrder(ctx);
      const otherProduct = await createPricedProduct(ctx);
      const otherPharmacy = await createStockedPharmacy(ctx, otherProduct);

      const listed = body(
        await request(ctx.server)
          .get('/pharmacy/orders')
          .set(...auth(otherPharmacy.accessToken))
          .expect(200),
      );
      expect(listed).toEqual({ items: [], total: 0 });
    });

    it('filters the listing by fulfillment status', async () => {
      const { pharmacy } = await placeOrder(ctx);

      const pending = body(
        await request(ctx.server)
          .get('/pharmacy/orders?status=PENDING')
          .set(...auth(pharmacy.accessToken))
          .expect(200),
      );
      expect(pending.total).toBe(1);

      const ready = body(
        await request(ctx.server)
          .get('/pharmacy/orders?status=READY')
          .set(...auth(pharmacy.accessToken))
          .expect(200),
      );
      expect(ready.total).toBe(0);
    });

    it('walks the full valid path: checkout -> accept -> prepare -> ready, dispatching real stock', async () => {
      const { pharmacy, fulfillmentId, orderId, catalogProductId } = await placeOrder(ctx);

      // Checkout confirmed the reservation (module-04 §8 "confirm on payment success"), so the
      // hold is CONFIRMED before the pharmacy ever acts — HELD would be TTL-swept and dispatch
      // would fail with INVALID_RESERVATION_STATE.
      // Reservations are created by matching *before* the order exists, so they are reached
      // through the OrderLine that snapshotted the reservationId, not by orderId.
      const line = await ctx.prisma.orderLine.findFirstOrThrow({ where: { orderId } });
      const reservation = await ctx.prisma.stockReservation.findUniqueOrThrow({
        where: { id: line.reservationId as string },
      });
      expect(reservation.status).toBe('CONFIRMED');

      const listingBefore = await ctx.prisma.inventoryListing.findFirstOrThrow({
        where: { catalogProductId },
      });

      for (const action of ['accept', 'prepare', 'ready']) {
        await request(ctx.server)
          .post(`/pharmacy/orders/${fulfillmentId}/${action}`)
          .set(...auth(pharmacy.accessToken))
          .expect(200);
      }

      const fulfillment = await ctx.prisma.fulfillment.findUniqueOrThrow({
        where: { id: fulfillmentId },
      });
      expect(fulfillment.status).toBe('READY');
      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('READY');

      // Real Module 04 dispatch happened: a DISPATCH movement exists and onHand fell by the
      // ordered quantity. Nothing here is mocked.
      const dispatchMovements = await ctx.prisma.stockMovement.findMany({
        where: { reservationId: reservation.id, type: 'DISPATCH' },
      });
      expect(dispatchMovements.length).toBeGreaterThan(0);
      const listingAfter = await ctx.prisma.inventoryListing.findUniqueOrThrow({
        where: { id: listingBefore.id },
      });
      expect(listingAfter.onHand).toBe(listingBefore.onHand - reservation.quantity);
    });

    it('reaches READY without INVALID_RESERVATION_STATE', async () => {
      const { pharmacy, fulfillmentId } = await placeOrder(ctx);

      for (const action of ['accept', 'prepare']) {
        await request(ctx.server)
          .post(`/pharmacy/orders/${fulfillmentId}/${action}`)
          .set(...auth(pharmacy.accessToken))
          .expect(200);
      }

      const res = await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/ready`)
        .set(...auth(pharmacy.accessToken));

      expect(res.status).toBe(200);
      // The regression this task fixed: dispatch previously rejected the still-HELD reservation.
      expect(JSON.stringify(res.body)).not.toContain('INVALID_RESERVATION_STATE');
    });

    it.each(['PHARMACY_MANAGER', 'PHARMACIST'])(
      'authorizes a %s granted at the owning organization',
      async (roleKey) => {
        const { pharmacy, fulfillmentId } = await placeOrder(ctx);
        // Granted at the Organization the pharmacy belongs to — not at the Pharmacy.id.
        const staff = await grantOrgRole(ctx, roleKey, pharmacy.organizationId);

        await request(ctx.server)
          .post(`/pharmacy/orders/${fulfillmentId}/accept`)
          .set(...auth(staff.accessToken))
          .expect(200);
      },
    );

    it('denies a correct role held at a different organization, without leaking existence', async () => {
      const { fulfillmentId } = await placeOrder(ctx);
      const otherProduct = await createPricedProduct(ctx);
      const otherPharmacy = await createStockedPharmacy(ctx, otherProduct);

      const forbidden = await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/accept`)
        .set(...auth(otherPharmacy.accessToken));
      const missing = await request(ctx.server)
        .post(`/pharmacy/orders/${randomUUID()}/accept`)
        .set(...auth(otherPharmacy.accessToken));

      expect(forbidden.status).toBe(404);
      // Byte-identical to a genuinely missing fulfillment — no existence leakage.
      expect(errorOf(forbidden)).toEqual(errorOf(missing));
    });

    it('rejects an out-of-order transition with INVALID_ORDER_STATE_TRANSITION', async () => {
      const { pharmacy, fulfillmentId } = await placeOrder(ctx);

      const res = await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/ready`)
        .set(...auth(pharmacy.accessToken));

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe(ErrorCode.INVALID_ORDER_STATE_TRANSITION);
    });

    it('declines a fulfillment, returning the re-match outcome', async () => {
      const { pharmacy, fulfillmentId } = await placeOrder(ctx);

      const result = body(
        await request(ctx.server)
          .post(`/pharmacy/orders/${fulfillmentId}/decline`)
          .set(...auth(pharmacy.accessToken))
          .send({ reason: 'Out of stock on the shelf' })
          .expect(200),
      );

      expect((result.declinedFulfillment as { status: string }).status).toBe('CANCELLED');
      // Only one pharmacy stocks the product, so the re-match finds no alternative.
      expect(result.newFulfillment).toBeNull();
    });

    it('requires authentication and the order:fulfill:org permission', async () => {
      const { fulfillmentId, customer } = await placeOrder(ctx);

      await request(ctx.server).get('/pharmacy/orders').expect(401);

      // A CUSTOMER holds order:create:own/order:read:own but not order:fulfill:org.
      const res = await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/accept`)
        .set(...auth(customer.accessToken))
        .expect(403);
      expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
    });

    it('rejects a decline with a missing reason with 400', async () => {
      const { pharmacy, fulfillmentId } = await placeOrder(ctx);

      const res = await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/decline`)
        .set(...auth(pharmacy.accessToken))
        .send({})
        .expect(400);

      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });
});
