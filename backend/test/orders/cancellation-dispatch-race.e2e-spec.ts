import { SchedulerRegistry } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { ORDER_REPOSITORY, IOrderRepository } from '../../src/modules/orders/domain/repositories/order.repository';
import { IInventoryPort, INVENTORY_PORT } from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { IListingRepository, LISTING_REPOSITORY } from '../../src/modules/pharmacy-inventory/domain/repositories/listing.repository';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createPricedProduct, readyToCheckout } from './support';

const REASON = 'No longer needed, sorry';

/**
 * Work 55 against real PostgreSQL: customer cancellation vs `MarkReadyCommand` on a two-line order.
 * Cancellation releases through Module 04's ONE all-or-nothing batch; MarkReady dispatches
 * reservation by reservation before its own order transaction. Both take the reservation row
 * locks and only then a listing lock, so a one-shot pause on the real listing repository's
 * `lockForUpdate` parks a flow while it holds its reservation lock(s), and
 * `waitForReservationLockWaiter` waits until PostgreSQL reports the other flow blocked on a
 * `stock_reservations` lock — each interleaving is forced, never left to scheduling.
 */
describe('Orders — cancellation vs MarkReady dispatch (e2e, Work 55)', () => {
  let ctx: TestContext;
  let inventory: IInventoryPort;
  let listings: IListingRepository;

  beforeAll(async () => {
    ctx = await createTestApp();
    inventory = ctx.app.get<IInventoryPort>(INVENTORY_PORT);
    listings = ctx.app.get<IListingRepository>(LISTING_REPOSITORY);
    // No background @Cron tick may take locks or change reservations behind the test's back.
    for (const job of ctx.app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
    expect([...ctx.app.get(SchedulerRegistry).getCronJobs().values()].filter((job) => job.running)).toEqual([]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A real checkout of two products from the one stocked pharmacy → one fulfillment, two reservations. */
  async function placeTwoLineOrder() {
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
    const checkout = body(
      await request(ctx.server).post('/checkout').set(...auth(ready.user.accessToken)).send({ addressId: ready.addressId, idempotencyKey: randomUUID() }).expect(201),
    );
    const orderId = checkout.orderId as string;
    const fulfillment = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId } });
    const lines = await ctx.prisma.orderLine.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
    const reservationIds = lines.map((l) => l.reservationId as string);
    expect(new Set(reservationIds).size).toBe(2);
    const reservations = await ctx.prisma.stockReservation.findMany({ where: { id: { in: reservationIds } } });
    expect(reservations.map((r) => r.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
    return { customer: ready.user, pharmacy: ready.pharmacy, orderId, fulfillmentId: fulfillment.id, reservationIds, listingIds: reservations.map((r) => r.listingId) };
  }

  const pharmacyStep = (o: { pharmacy: { accessToken: string }; fulfillmentId: string }, action: string) =>
    request(ctx.server).post(`/pharmacy/orders/${o.fulfillmentId}/${action}`).set(...auth(o.pharmacy.accessToken));
  const cancel = (o: { customer: { accessToken: string }; orderId: string }) =>
    request(ctx.server).post(`/orders/${o.orderId}/cancel`).set(...auth(o.customer.accessToken)).send({ reason: REASON });
  async function toPreparing(o: { pharmacy: { accessToken: string }; fulfillmentId: string }) {
    await pharmacyStep(o, 'accept').expect(200);
    await pharmacyStep(o, 'prepare').expect(200);
  }

  /** Parks the next `listings.lockForUpdate` caller — a flow that already holds its reservation lock(s). */
  function pauseAtListingLock() {
    const original = listings.lockForUpdate.bind(listings);
    let reached!: () => void;
    let resume!: () => void;
    const atLock = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (resume = r));
    jest.spyOn(listings, 'lockForUpdate').mockImplementationOnce(async (id: string, tx: unknown) => {
      reached();
      await gate;
      return original(id, tx);
    });
    return { atLock, resume };
  }

  /** Waits until PostgreSQL reports a backend blocked on a lock while touching `stock_reservations`. */
  async function waitForReservationLockWaiter() {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await ctx.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE '%stock_reservations%'`;
      if (row.n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the competing flow never blocked on a reservation row lock');
  }

  /** Everything a rejected cancellation must leave untouched. */
  const snapshot = async (orderId: string, listingIds: string[], reservationIds: string[]) => ({
    order: await ctx.prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    history: await ctx.prisma.orderStatusHistory.count({ where: { orderId } }),
    fulfillments: await ctx.prisma.fulfillment.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    reservations: await ctx.prisma.stockReservation.findMany({ where: { id: { in: reservationIds } }, orderBy: { id: 'asc' } }),
    listings: await ctx.prisma.inventoryListing.findMany({ where: { id: { in: listingIds } }, orderBy: { id: 'asc' } }),
    movements: await ctx.prisma.stockMovement.findMany({ where: { listingId: { in: listingIds } }, orderBy: { id: 'asc' } }),
    audit: await ctx.prisma.auditLog.count(),
    outbox: await ctx.prisma.outbox.count(),
  });
  const movementsOf = (reservationIds: string[], type: 'RELEASE' | 'DISPATCH') =>
    ctx.prisma.stockMovement.count({ where: { reservationId: { in: reservationIds }, type } });

  it('normal cancellation: every reservation released together (one batch), order CANCELLED, stock back', async () => {
    const o = await placeTwoLineOrder();
    await cancel(o).expect(200);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('CANCELLED');
    const rs = await ctx.prisma.stockReservation.findMany({ where: { id: { in: o.reservationIds } } });
    expect(rs.map((r) => r.status)).toEqual(['RELEASED', 'RELEASED']);
    expect(await movementsOf(o.reservationIds, 'RELEASE')).toBe(2);
    for (const l of await ctx.prisma.inventoryListing.findMany({ where: { id: { in: o.listingIds } } })) {
      expect({ reserved: l.reserved, sellable: l.sellable, onHand: l.onHand }).toEqual({ reserved: 0, sellable: 20, onHand: 20 });
    }
  });

  it('an already-RELEASED reservation stays a no-op inside the batch; the other is released and the order cancelled', async () => {
    const o = await placeTwoLineOrder();
    await inventory.release({ reservationId: o.reservationIds[0], reason: 'earlier' });
    await cancel(o).expect(200);
    expect(await ctx.prisma.stockMovement.count({ where: { reservationId: o.reservationIds[0], type: 'RELEASE' } })).toBe(1);
    expect(await ctx.prisma.stockMovement.count({ where: { reservationId: o.reservationIds[1], type: 'RELEASE' } })).toBe(1);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('CANCELLED');
  });

  it('one reservation dispatched before cancellation (MarkReady failed midway): 422, and NOTHING changes — the other reservation is not released', async () => {
    const o = await placeTwoLineOrder();
    await toPreparing(o);
    await inventory.dispatch({ reservationId: o.reservationIds[0] }); // MarkReady's first dispatch committed; it never finished
    const before = await snapshot(o.orderId, o.listingIds, o.reservationIds);

    const res = await cancel(o).expect(422);
    expect(errorOf(res).code).toBe(ErrorCode.CANCELLATION_NOT_ALLOWED);

    expect(await snapshot(o.orderId, o.listingIds, o.reservationIds)).toEqual(before);
    expect(before.order.status).toBe('ACCEPTED');
    expect(before.reservations.map((r) => r.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
    // The pharmacy can still finish: MarkReady's retry skips the dispatched line and dispatches the other.
    await pharmacyStep(o, 'ready').expect(200);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('READY');
    expect(await movementsOf(o.reservationIds, 'RELEASE')).toBe(0);
  });

  it('race A — cancellation takes the reservation locks first: MarkReady cannot dispatch a released reservation and the order never becomes READY', async () => {
    const o = await placeTwoLineOrder();
    await toPreparing(o);

    const pause = pauseAtListingLock();
    const cancelling = cancel(o).then((r) => r);
    await pause.atLock; // the batch holds BOTH reservation locks and has validated them
    const readying = pharmacyStep(o, 'ready').then((r) => r);
    await waitForReservationLockWaiter(); // MarkReady's first dispatch is blocked on a reservation row
    pause.resume();

    const [c, m] = [await cancelling, await readying];
    expect(c.status).toBe(200);
    expect(m.status).toBe(422);
    expect(errorOf(m).code).toBe(ErrorCode.INVALID_RESERVATION_STATE);

    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('CANCELLED');
    expect((await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id: o.fulfillmentId } })).status).toBe('PREPARING');
    expect((await ctx.prisma.stockReservation.findMany({ where: { id: { in: o.reservationIds } } })).map((r) => r.status)).toEqual(['RELEASED', 'RELEASED']);
    expect(await movementsOf(o.reservationIds, 'DISPATCH')).toBe(0);
    expect(await movementsOf(o.reservationIds, 'RELEASE')).toBe(2);
    for (const l of await ctx.prisma.inventoryListing.findMany({ where: { id: { in: o.listingIds } } })) {
      expect({ reserved: l.reserved, onHand: l.onHand, sellable: l.sellable }).toEqual({ reserved: 0, onHand: 20, sellable: 20 });
    }
  });

  it('race B — MarkReady dispatches first: cancellation waits, then rejects 422 without releasing ANY reservation; MarkReady completes READY', async () => {
    const o = await placeTwoLineOrder();
    await toPreparing(o);
    const audits = await ctx.prisma.auditLog.count();

    const pause = pauseAtListingLock();
    const readying = pharmacyStep(o, 'ready').then((r) => r);
    await pause.atLock; // MarkReady's first dispatch holds that reservation's lock; no DISPATCH movement yet
    const cancelling = cancel(o).then((r) => r);
    await waitForReservationLockWaiter(); // the cancellation batch is blocked on that reservation row
    pause.resume();

    const [m, c] = [await readying, await cancelling];
    expect(c.status).toBe(422);
    expect(errorOf(c).code).toBe(ErrorCode.CANCELLATION_NOT_ALLOWED);
    expect(m.status).toBe(200);

    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('READY');
    expect((await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id: o.fulfillmentId } })).status).toBe('READY');
    expect((await ctx.prisma.stockReservation.findMany({ where: { id: { in: o.reservationIds } } })).map((r) => r.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await movementsOf(o.reservationIds, 'RELEASE')).toBe(0);
    expect(await ctx.prisma.stockMovement.count({ where: { reservationId: o.reservationIds[0], type: 'DISPATCH' } })).toBeGreaterThan(0);
    expect(await ctx.prisma.stockMovement.count({ where: { reservationId: o.reservationIds[1], type: 'DISPATCH' } })).toBeGreaterThan(0);
    for (const l of await ctx.prisma.inventoryListing.findMany({ where: { id: { in: o.listingIds } } })) expect(l.reserved).toBe(0);
    // No cancellation trace: no ORDER_CANCELLED audit row or event; MarkReady's own ORDER_READY audit only.
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ORDER_CANCELLED' } })).toBe(0);
    expect(await ctx.prisma.auditLog.count()).toBe(audits + 1);
    expect(await ctx.prisma.outbox.count({ where: { eventType: { in: ['order.cancelled', 'pharmacy.stock.released'] } } })).toBe(0);
  });

  it('the batch commits but the order transaction fails: the intent is durable (503 PENDING at STOCK_RELEASED); a retried cancel finishes without a second release', async () => {
    const o = await placeTwoLineOrder();
    const orders = ctx.app.get<IOrderRepository>(ORDER_REPOSITORY);
    jest.spyOn(orders, 'updateStatus').mockRejectedValueOnce(new Error('simulated order-transaction failure'));

    const first = await cancel(o);
    expect(first.status).toBe(503);
    expect(errorOf(first).code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(await ctx.prisma.orderCancellationRequest.findUniqueOrThrow({ where: { orderId: o.orderId } })).toMatchObject({ phase: 'STOCK_RELEASED' });
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('PAID');
    expect((await ctx.prisma.stockReservation.findMany({ where: { id: { in: o.reservationIds } } })).map((r) => r.status)).toEqual(['RELEASED', 'RELEASED']);

    await cancel(o).expect(200);
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('CANCELLED');
    expect(await movementsOf(o.reservationIds, 'RELEASE')).toBe(2);
  });
});
