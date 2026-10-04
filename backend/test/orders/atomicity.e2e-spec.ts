import { Injectable } from '@nestjs/common';
import request from 'supertest';
import { AppLogger } from '../../src/shared/logging/app-logger.service';
import { AuditService, RecordAuditParams } from '../../src/shared/audit/audit.service';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { OutboxCapableClient, OutboxService } from '../../src/shared/outbox/outbox.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { auth } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { placeOrder, readyToCheckout } from './support';

/**
 * Mirrors `test/pharmacy-inventory/atomicity.e2e-spec.ts`'s `PoisonedOutboxService` (module-06
 * §12.3's "poisoned-outbox pattern"). One-shot: it disarms itself on the first matching call so a
 * retry after the forced failure exercises the real path.
 *
 * **Armed by event type**, unlike Module 04's unconditional flag. Module 06's commands sit
 * downstream of cross-module calls that write their *own* outbox events first — e.g.
 * `CancelOrderCommand` calls `IInventoryPort.release()`, and Module 04's
 * `ReleaseReservationCommand` writes `pharmacy.stock.released` before Module 06's transaction
 * even opens. An unconditional poison is swallowed by that upstream write (the release is
 * best-effort, §3.12 invariant 5) and never reaches the command under test. Scoping the arm to
 * the event type keeps the injection on the intended transaction boundary.
 */
@Injectable()
class PoisonedOutboxService extends OutboxService {
  armedEventType: string | null = null;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    if (this.armedEventType !== null && event.type === this.armedEventType) {
      this.armedEventType = null;
      throw new Error(
        'CONTROLLED_FAILURE: simulated outbox failure after the state mutation, before commit',
      );
    }
    return super.write(event, client);
  }
}

/**
 * `PrepareFulfillmentCommand` co-locates state + **audit** in its transaction but writes no
 * outbox event (§8 catalogs no "fulfillment preparing" event), so poisoning the outbox could
 * never exercise its boundary. The same one-shot mechanism is therefore applied to the other
 * half of the ADR-010 triple — this is the identical subclass-and-throw shape the outbox poison
 * uses, not a second testing architecture.
 */
@Injectable()
class PoisonedAuditService extends AuditService {
  armedAction: string | null = null;

  constructor(prisma: PrismaService, logger: AppLogger) {
    super(prisma, logger);
  }

  async record(params: RecordAuditParams, tx?: unknown): Promise<{ id: string; hash: string }> {
    if (this.armedAction !== null && params.action === this.armedAction) {
      this.armedAction = null;
      throw new Error(
        'CONTROLLED_FAILURE: simulated audit failure after the state mutation, before commit',
      );
    }
    return super.record(params, tx);
  }
}

/**
 * Module 06 mutation atomicity — state + audit + outbox (`06-orders-spec.md` §12.3's **Required**
 * `atomicity.e2e-spec.ts`): "poisoned-outbox pattern (mirrors Module 05's
 * `application-workflow.e2e-spec.ts`) for `CheckoutCommand`, `AcceptFulfillmentCommand`,
 * `PrepareFulfillmentCommand`, `CancelOrderCommand`: no partial `Order`/`OrderLine`/`Fulfillment`/
 * audit/outbox row survives a mid-transaction failure".
 *
 * Real Postgres, real `AppModule` wiring, real Prisma repositories, real outbox/audit tables —
 * only the single failure-injection point is overridden, exactly as Modules 03/04 do.
 *
 * **Scope note (ADR-014).** These assertions are about each command's *own local* `Serializable`
 * transaction. Cross-module calls (`IInventoryPort`, `IDispensingPort`, Module 05 matching) each
 * open their own transaction and are deliberately **not** claimed to roll back with it — that is
 * the accepted eventual-consistency seam, and each test below asserts the documented
 * compensating behaviour instead of pretending the seam is atomic.
 */
describe('Orders — mutation atomicity: state + audit + outbox (e2e)', () => {
  let ctx: TestContext;
  let poisonedOutbox: PoisonedOutboxService;
  let poisonedAudit: PoisonedAuditService;

  beforeAll(async () => {
    ctx = await createTestApp([
      { provide: OutboxService, useClass: PoisonedOutboxService },
      { provide: AuditService, useClass: PoisonedAuditService },
    ]);
    poisonedOutbox = ctx.app.get(OutboxService) as unknown as PoisonedOutboxService;
    poisonedAudit = ctx.app.get(AuditService) as unknown as PoisonedAuditService;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    poisonedOutbox.armedEventType = null;
    poisonedAudit.armedAction = null;
  });

  // -------------------------------------------------------------------------------------------
  // CheckoutCommand (§4 steps 6+8 — order + lines + fulfillment + invoice + cart + audit + outbox)
  // -------------------------------------------------------------------------------------------

  it('checkout: a failure before commit leaves no order, line, fulfillment, invoice, history, audit or outbox row', async () => {
    const { user, addressId } = await readyToCheckout(ctx);

    poisonedOutbox.armedEventType = 'order.placed';
    const failed = await request(ctx.server)
      .post('/checkout')
      .set(...auth(user.accessToken))
      .send({ addressId, idempotencyKey: 'atomicity-checkout-1' });

    expect(failed.status).toBe(500);
    expect(poisonedOutbox.armedEventType).toBeNull();

    // Every row the one transaction would have written is absent — no partial order survives.
    expect(await ctx.prisma.order.count()).toBe(0);
    expect(await ctx.prisma.orderLine.count()).toBe(0);
    expect(await ctx.prisma.fulfillment.count()).toBe(0);
    expect(await ctx.prisma.invoice.count()).toBe(0);
    expect(await ctx.prisma.orderStatusHistory.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ORDER_PLACED' } })).toBe(0);
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: { in: ['order.placed', 'order.paid'] } } }),
    ).toBe(0);

    // Cart finalization is inside the same transaction, so the cart is still usable.
    const cart = await ctx.prisma.cart.findFirstOrThrow({
      where: { customerUserId: user.userId },
    });
    expect(cart.status).toBe('ACTIVE');
    expect(await ctx.prisma.cartItem.count({ where: { cartId: cart.id } })).toBe(1);
  });

  it('checkout: the failed attempt releases its reservation (ADR-014 compensation, not a rollback)', async () => {
    const { user, addressId } = await readyToCheckout(ctx);

    poisonedOutbox.armedEventType = 'order.placed';
    await request(ctx.server)
      .post('/checkout')
      .set(...auth(user.accessToken))
      .send({ addressId, idempotencyKey: 'atomicity-checkout-2' })
      .expect(500);

    // Module 04's reservation was made in its *own* transaction, so it cannot roll back with
    // ours (§4's compensation column). The saga instead releases it best-effort; the row remains
    // for audit but must hold no stock.
    const reservations = await ctx.prisma.stockReservation.findMany();
    for (const reservation of reservations) {
      expect(['RELEASED', 'EXPIRED']).toContain(reservation.status);
    }
    const listing = await ctx.prisma.inventoryListing.findFirstOrThrow();
    expect(listing.reserved).toBe(0);
  });

  it('checkout: retrying after the forced failure succeeds and writes exactly one complete order', async () => {
    const { user, addressId } = await readyToCheckout(ctx);

    poisonedOutbox.armedEventType = 'order.placed';
    await request(ctx.server)
      .post('/checkout')
      .set(...auth(user.accessToken))
      .send({ addressId, idempotencyKey: 'atomicity-checkout-3a' })
      .expect(500);

    await request(ctx.server)
      .post('/checkout')
      .set(...auth(user.accessToken))
      .send({ addressId, idempotencyKey: 'atomicity-checkout-3b' })
      .expect(201);

    expect(await ctx.prisma.order.count()).toBe(1);
    expect(await ctx.prisma.fulfillment.count()).toBe(1);
    expect(await ctx.prisma.invoice.count()).toBe(1);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'order.placed' } })).toBe(1);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'order.paid' } })).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // AcceptFulfillmentCommand (§9.4 — fulfillment + order status + history + audit + outbox)
  // -------------------------------------------------------------------------------------------

  it('accept: a failure before commit leaves fulfillment and order status untouched, with no history, audit or event', async () => {
    const { pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);
    const historyBefore = await ctx.prisma.orderStatusHistory.count({ where: { orderId } });

    poisonedOutbox.armedEventType = 'order.accepted';
    const failed = await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/accept`)
      .set(...auth(pharmacy.accessToken));

    expect(failed.status).toBe(500);

    // Neither half of the two-aggregate update survives.
    const fulfillment = await ctx.prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
    });
    expect(fulfillment.status).toBe('PENDING');
    expect(fulfillment.acceptedAt).toBeNull();
    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAID');

    expect(await ctx.prisma.orderStatusHistory.count({ where: { orderId } })).toBe(historyBefore);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ORDER_ACCEPTED' } })).toBe(0);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'order.accepted' } })).toBe(0);
  });

  it('accept: retrying after the forced failure transitions once, with exactly one event', async () => {
    const { pharmacy, fulfillmentId, orderId } = await placeOrder(ctx);

    poisonedOutbox.armedEventType = 'order.accepted';
    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/accept`)
      .set(...auth(pharmacy.accessToken))
      .expect(500);

    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/accept`)
      .set(...auth(pharmacy.accessToken))
      .expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('ACCEPTED');
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.accepted', aggregateId: orderId } }),
    ).toBe(1);
    expect(
      await ctx.prisma.orderStatusHistory.count({ where: { orderId, toStatus: 'ACCEPTED' } }),
    ).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // PrepareFulfillmentCommand (§9.4 — fulfillment status + audit; no outbox event is cataloged)
  // -------------------------------------------------------------------------------------------

  it('prepare: a failure before commit leaves the fulfillment ACCEPTED with no audit row', async () => {
    const { pharmacy, fulfillmentId } = await placeOrder(ctx);
    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/accept`)
      .set(...auth(pharmacy.accessToken))
      .expect(200);

    poisonedAudit.armedAction = 'FULFILLMENT_PREPARING';
    const failed = await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/prepare`)
      .set(...auth(pharmacy.accessToken));

    expect(failed.status).toBe(500);

    const fulfillment = await ctx.prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
    });
    expect(fulfillment.status).toBe('ACCEPTED');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'FULFILLMENT_PREPARING' } })).toBe(0);
  });

  it('prepare: the Module 05 dispense seam is not claimed to roll back — retrying still succeeds', async () => {
    // Dispensing runs *before* the local transaction and owns its own (ADR-014). An OTC order has
    // no Rx line to dispense, so this asserts the documented boundary rather than pretending the
    // cross-module call is transactional: the local half rolls back and a retry completes.
    const { pharmacy, fulfillmentId } = await placeOrder(ctx);
    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/accept`)
      .set(...auth(pharmacy.accessToken))
      .expect(200);

    poisonedAudit.armedAction = 'FULFILLMENT_PREPARING';
    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/prepare`)
      .set(...auth(pharmacy.accessToken))
      .expect(500);

    await request(ctx.server)
      .post(`/pharmacy/orders/${fulfillmentId}/prepare`)
      .set(...auth(pharmacy.accessToken))
      .expect(200);

    const fulfillment = await ctx.prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
    });
    expect(fulfillment.status).toBe('PREPARING');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'FULFILLMENT_PREPARING' } })).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // CancelOrderCommand (§9.3 — order status + history + audit + outbox)
  // -------------------------------------------------------------------------------------------

  it('cancel: a failure before commit leaves the order un-cancelled with no history, audit or event', async () => {
    const { customer, orderId } = await placeOrder(ctx);

    poisonedOutbox.armedEventType = 'order.cancelled';
    const failed = await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: 'Changed my mind about this order' });

    expect(failed.status).toBe(500);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAID');
    expect(order.cancelledAt).toBeNull();
    expect(order.cancelReason).toBeNull();
    expect(
      await ctx.prisma.orderStatusHistory.count({ where: { orderId, toStatus: 'CANCELLED' } }),
    ).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ORDER_CANCELLED' } })).toBe(0);
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'order.cancelled' } })).toBe(0);
  });

  it('cancel: the best-effort reservation release is preserved across the rolled-back attempt', async () => {
    // §3.12 invariant 5 / ADR-014: the release is a cross-module call in its own transaction, so
    // it does NOT roll back with the local failure. That is the documented behaviour and this
    // test pins it rather than asserting a rollback the architecture never promised.
    const { customer, orderId } = await placeOrder(ctx);
    const line = await ctx.prisma.orderLine.findFirstOrThrow({ where: { orderId } });

    poisonedOutbox.armedEventType = 'order.cancelled';
    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: 'Changed my mind about this order' })
      .expect(500);

    const released = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: line.reservationId as string },
    });
    expect(released.status).toBe('RELEASED');

    // The order itself is still PAID, so a retry is legal and completes the cancellation.
    await request(ctx.server)
      .post(`/orders/${orderId}/cancel`)
      .set(...auth(customer.accessToken))
      .send({ reason: 'Changed my mind about this order' })
      .expect(200);

    const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CANCELLED');
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'order.cancelled', aggregateId: orderId } }),
    ).toBe(1);
  });
});
