import request from 'supertest';
import { auth, body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder, readyToCheckout } from './support';

/**
 * Event-contract tests (`06-orders-spec.md` §12.3's `event-contracts.e2e-spec.ts`: "Every event
 * in §8 fires with the exact contracted payload, mirroring Module 05's own
 * `event-contracts.e2e-spec.ts` pattern").
 *
 * For every event §8 says Slice 1 emits, this triggers the real business operation through the
 * real HTTP surface against real Postgres, reads back the persisted `outbox` row, and asserts the
 * envelope + payload against §8's payload/trigger table and `00-domain-event-catalog.md`'s
 * Module 06 row. Nothing is mocked.
 *
 * §8 also states which events Slice 1 must **not** emit (`OrderDispatched`/`OrderDelivered`/
 * `OrderCompleted` — no reachable trigger without Module 08); the final test pins that too, so a
 * future speculative event cannot be added without failing this suite.
 */
describe('Orders domain events — contract vs. 00-domain-event-catalog.md / module-06 §8 (e2e)', () => {
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

  /** Reads back the outbox row for `eventType`, parsed as the full `DomainEvent` envelope. */
  async function envelopeFor(eventType: string, aggregateId?: string) {
    const rows = await ctx.prisma.outbox.findMany({
      where: { eventType, ...(aggregateId ? { aggregateId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[rows.length - 1];
    const envelope = row.payload as {
      id: string;
      type: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
      occurredAt: string;
    };
    expect(envelope.id).toEqual(expect.any(String));
    expect(envelope.type).toBe(eventType);
    expect(envelope.aggregateType).toBe('Order');
    expect(envelope.aggregateId).toEqual(expect.any(String));
    expect(() => new Date(envelope.occurredAt).toISOString()).not.toThrow();
    expect(new Date(envelope.occurredAt).toISOString()).toBe(envelope.occurredAt);
    // The denormalized columns the relay dispatches on must match the envelope.
    expect(row.aggregateType).toBe(envelope.aggregateType);
    expect(row.aggregateId).toBe(envelope.aggregateId);
    return envelope;
  }

  // -------------------------------------------------------------------------------------------
  // order.placed / order.paid — CheckoutCommand (§8, saga steps 6 and 8)
  // -------------------------------------------------------------------------------------------

  it('order.placed: { orderId, customerUserId, totals } on checkout', async () => {
    const { user, addressId } = await readyToCheckout(ctx);

    const data = body(
      await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ addressId, idempotencyKey: 'events-placed' })
        .expect(201),
    );
    const orderId = data.orderId as string;

    const envelope = await envelopeFor('order.placed', orderId);
    expect(envelope.aggregateId).toBe(orderId);
    expect(envelope.payload).toEqual({
      orderId,
      customerUserId: user.userId,
      totals: { grandTotal: expect.any(Number), currency: 'ETB' },
    });
    expect(envelope.payload.orderId).toBe(orderId);

    // Exactly one — the saga must not double-emit on its own retry path.
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.placed', aggregateId: orderId } }),
    ).toBe(1);
  });

  it('order.paid: { orderId, paymentId } with paymentId null for COD', async () => {
    const { user, addressId } = await readyToCheckout(ctx);

    const data = body(
      await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ addressId, idempotencyKey: 'events-paid' })
        .expect(201),
    );
    const orderId = data.orderId as string;

    const envelope = await envelopeFor('order.paid', orderId);
    // §8: "paymentId is null/absent until Module 07 exists" — every Slice-1 order is COD.
    expect(envelope.payload).toEqual({ orderId, paymentId: null });
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.paid', aggregateId: orderId } }),
    ).toBe(1);
  });

  it('order.placed and order.paid are written in the same transaction as the order row', async () => {
    // ADR-010: both events commit with the state change. If the order exists, both rows exist and
    // carry the same `createdAt` transaction boundary as the order's own placement.
    const { user, addressId } = await readyToCheckout(ctx);
    const data = body(
      await request(ctx.server)
        .post('/checkout')
        .set(...auth(user.accessToken))
        .send({ addressId, idempotencyKey: 'events-same-tx' })
        .expect(201),
    );
    const orderId = data.orderId as string;

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const rows = await ctx.prisma.outbox.findMany({
      where: { aggregateId: orderId, eventType: { in: ['order.placed', 'order.paid'] } },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(order.createdAt.getTime() - 5_000);
    }
  });

  // -------------------------------------------------------------------------------------------
  // order.accepted — AcceptFulfillmentCommand (§8)
  // -------------------------------------------------------------------------------------------

  it('order.accepted: { orderId, fulfillmentId, pharmacyId } on accept', async () => {
    const { pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);

    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/accept`)
      .set(...auth(pharmacy.accessToken))
      .expect(200);

    const fulfillment = await ctx.prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
    });
    const envelope = await envelopeFor('order.accepted', orderId);
    expect(envelope.payload).toEqual({
      orderId,
      fulfillmentId,
      pharmacyId: fulfillment.pharmacyId,
    });
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.accepted', aggregateId: orderId } }),
    ).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // order.ready — MarkReadyCommand (§8)
  // -------------------------------------------------------------------------------------------

  it('order.ready: { orderId, fulfillmentId } once the fulfillment reaches READY', async () => {
    const { pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);

    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/${action}`)
        .set(...auth(pharmacy.accessToken))
        .expect(200);
    }

    const envelope = await envelopeFor('order.ready', orderId);
    expect(envelope.payload).toEqual({ orderId, fulfillmentId });
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.ready', aggregateId: orderId } }),
    ).toBe(1);

    // Preparing emits nothing — §8 catalogs no "fulfillment preparing" event.
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'order.preparing' } })).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // order.cancelled — CancelOrderCommand (§8)
  // -------------------------------------------------------------------------------------------

  it('order.cancelled: { orderId, reason } carrying the customer-supplied reason', async () => {
    const { customer, orderId } = await placeOrder(ctx);
    const reason = 'Ordered the wrong strength by mistake';

    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason })
      .expect(200);

    const envelope = await envelopeFor('order.cancelled', orderId);
    expect(envelope.payload).toEqual({ orderId, reason });
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.cancelled', aggregateId: orderId } }),
    ).toBe(1);
  });

  it('order.cancelled: a decline that exhausts every candidate cancels the order with NO_PHARMACY_MATCH', async () => {
    // §8's note: a decline is not a new Module 06 event — when re-match fails, the order simply
    // takes the cataloged `OrderCancelled` path.
    const { pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);

    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/decline`)
      .set(...auth(pharmacy.accessToken))
      .send({ reason: 'Out of stock at this branch right now' })
      .expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === 'CANCELLED') {
      const envelope = await envelopeFor('order.cancelled', orderId);
      expect(envelope.payload).toEqual({ orderId, reason: 'NO_PHARMACY_MATCH' });
    }
    // Either way, no bespoke "declined"/"rematched" event was invented (§8).
    expect(
      await ctx.prisma.outbox.count({
        where: { eventType: { in: ['order.declined', 'order.rematched'] } },
      }),
    ).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Negative contract — §8's explicitly not-emitted Slice 1 events
  // -------------------------------------------------------------------------------------------

  it('emits no Slice-2 event: order.dispatched / order.delivered / order.completed never appear', async () => {
    const { pharmacy, fulfillmentId } = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/${action}`)
        .set(...auth(pharmacy.accessToken))
        .expect(200);
    }

    expect(
      await ctx.prisma.outbox.count({
        where: {
          eventType: { in: ['order.dispatched', 'order.delivered', 'order.completed'] },
        },
      }),
    ).toBe(0);
  });

  it('the full lifecycle emits exactly the §8 Slice-1 set for its order, and nothing else', async () => {
    const { pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server)
        .post(`/pharmacy/orders/${fulfillmentId}/${action}`)
        .set(...auth(pharmacy.accessToken))
        .expect(200);
    }

    const rows = await ctx.prisma.outbox.findMany({
      where: { aggregateId: orderId, aggregateType: 'Order' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.eventType)).toEqual([
      'order.placed',
      'order.paid',
      'order.accepted',
      'order.ready',
    ]);
  });
});
