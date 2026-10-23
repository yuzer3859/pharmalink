import { SchedulerRegistry } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { FULFILLMENT_REPOSITORY, IFulfillmentRepository } from '../../src/modules/orders/domain/repositories/fulfillment.repository';
import { DECLINE_RECOVERY_REPOSITORY } from '../../src/modules/orders/domain/repositories/decline-recovery.repository';
import { DeclineConfirmationReconciler } from '../../src/modules/orders/infrastructure/scheduling/decline-confirmation.reconciler';
import { IInventoryPort, INVENTORY_PORT } from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { RESERVATION_STATUS_READ_PORT } from '../../src/modules/pharmacy-inventory/application/ports/inbound/reservation-status-read.port';
import { IListingRepository, LISTING_REPOSITORY } from '../../src/modules/pharmacy-inventory/domain/repositories/listing.repository';
import { IReservationRepository, RESERVATION_REPOSITORY } from '../../src/modules/pharmacy-inventory/domain/repositories/reservation.repository';
import { ReservationTtlSweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/reservation-ttl.sweeper';
import { ApiException } from '../../src/shared/errors/api-exception';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createPricedProduct, createStockedPharmacy, placeOrder, PlacedOrder, readyToCheckout } from './support';

type Segment = { orderId: string; lineId: string; fulfillmentId: string | null; reservationId: string | null; listingId: string | null; reservationStatus: string | null; state: string; diagnosticCode: string };
type View = { pageCounts: Record<string, number>; countsScope: string; items: Segment[]; totalOrders: number; page: number; size: number };

/**
 * Work 55 against real PostgreSQL: recovery of a pharmacy decline whose Phase 3a (new fulfillment +
 * re-pointed lines) committed but whose replacement confirmation did not. The decline is made to stop
 * at a chosen point with spies; the reconciler (cron stopped, run by hand) and the read-only Module 16
 * view are then checked against the real rows. Races are forced with pauses at real lock points and a
 * wait on PostgreSQL's lock-wait state — no sleeps.
 */
describe('Pharmacy decline recovery (e2e, Work 55)', () => {
  let ctx: TestContext;
  let inventory: IInventoryPort;
  let reconciler: DeclineConfirmationReconciler;
  let admin: { accessToken: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    inventory = ctx.app.get(INVENTORY_PORT);
    reconciler = ctx.app.get(DeclineConfirmationReconciler);
    for (const job of ctx.app.get(SchedulerRegistry).getCronJobs().values()) void job.stop();
    expect([...ctx.app.get(SchedulerRegistry).getCronJobs().values()].filter((job) => job.running)).toEqual([]);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const held = await ctx.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "orders" o JOIN "order_lines" l ON l."orderId" = o."id"
        JOIN "stock_reservations" r ON r."id" = l."reservationId"
       WHERE o."status" = 'CANCELLED' AND r."status" IN ('HELD', 'CONFIRMED')`;
    expect(held[0].n).toBe(0); // §3.12 invariant 5
  });

  const view = async (state?: string, paging: Record<string, number> = {}) =>
    body(await request(ctx.server).get('/admin/operations/order-decline-recovery').query({ ...(state ? { state } : {}), ...paging }).set(...auth(admin.accessToken)).expect(200)) as unknown as View;
  const decline = (o: { pharmacy: { accessToken: string }; fulfillmentId: string }) =>
    request(ctx.server).post(`/pharmacy/orders/${o.fulfillmentId}/decline`).set(...auth(o.pharmacy.accessToken)).send({ reason: 'Out of stock on the shelf' });
  const lines = (orderId: string) => ctx.prisma.orderLine.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
  const statusOf = async (id: string) => (await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id } })).status;
  const snapshot = async (orderId: string) => ({
    lines: await lines(orderId),
    fulfillments: await ctx.prisma.fulfillment.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    movements: await ctx.prisma.stockMovement.count(),
  });

  /** Decline whose confirmation step fails for every reservation (or only for `failFor`). Phase 3a commits. */
  async function declineWithFailedConfirm(o: PlacedOrder, failFor?: (reservationId: string) => boolean) {
    const original = inventory.confirm.bind(inventory);
    jest.spyOn(inventory, 'confirm').mockImplementation(async (input) => {
      if (!failFor || failFor(input.reservationId)) throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Module 04 down');
      return original(input);
    });
    const res = await decline(o);
    jest.restoreAllMocks();
    return res;
  }

  /** A two-product order at one pharmacy, and a second pharmacy stocking both (the re-match target). */
  async function twoLineOrderWithBackup() {
    const ready = await readyToCheckout(ctx, { quantity: 2, stock: 20 });
    const productB = await createPricedProduct(ctx);
    const listing = (token: string, branchId: string, productId: string) =>
      request(ctx.server).post('/inventory/listings').set(...auth(token)).send({
        catalogProductId: productId, branchId, price: 2500, batchNumber: `B-${randomUUID().slice(0, 6)}`,
        initialQuantity: 20, expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }).expect(201);
    await listing(ready.pharmacy.accessToken, ready.pharmacy.branchId, productB);
    const backup = await createStockedPharmacy(ctx, ready.catalogProductId);
    await listing(backup.accessToken, backup.branchId, productB);
    await ctx.prisma.cartItem.create({ data: { cartId: ready.cartId, catalogProductId: productB, quantity: 3, indicativePrice: 2500 } });
    const orderId = body(await request(ctx.server).post('/checkout').set(...auth(ready.user.accessToken)).send({ addressId: ready.addressId, idempotencyKey: randomUUID() }).expect(201)).orderId as string;
    const fulfillmentId = (await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId } })).id;
    return { order: { customer: ready.user, pharmacy: ready.pharmacy, catalogProductId: ready.catalogProductId, orderId, fulfillmentId } as PlacedOrder, backup };
  }

  it('Phase 3a committed, confirmation failed → PENDING_CONFIRMATION; the reconciler confirms it and MarkReady completes', async () => {
    const o = await placeOrder(ctx);
    const backup = await createStockedPharmacy(ctx, o.catalogProductId);
    expect((await declineWithFailedConfirm(o)).status).toBe(503);
    const [line] = await lines(o.orderId);
    expect(await statusOf(line.reservationId!)).toBe('HELD');
    expect((await view()).items).toEqual([expect.objectContaining({ orderId: o.orderId, state: 'PENDING_CONFIRMATION', diagnosticCode: 'REPLACEMENT_HELD', reservationId: line.reservationId })]);

    const before = await snapshot(o.orderId);
    expect(await reconciler.run()).toMatchObject({ confirmed: 1 });
    expect(await statusOf(line.reservationId!)).toBe('CONFIRMED');
    expect(await snapshot(o.orderId)).toEqual(before); // no repoint, no fulfillment, no movement
    expect((await view()).items.map((s) => s.state)).toEqual(['RESOLVED']);

    const live = await ctx.prisma.fulfillment.findFirstOrThrow({ where: { orderId: o.orderId, status: 'PENDING' } });
    for (const action of ['accept', 'prepare', 'ready']) {
      await request(ctx.server).post(`/pharmacy/orders/${live.id}/${action}`).set(...auth(backup.accessToken)).expect(200);
    }
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('READY');
  });

  it('partial confirmation: the already-confirmed replacement is left as is; the remaining HELD one is confirmed', async () => {
    const { order } = await twoLineOrderWithBackup();
    let first: string | null = null;
    expect((await declineWithFailedConfirm(order, (id) => (first === null ? ((first = id), false) : true))).status).toBe(503);
    const ids = (await lines(order.orderId)).map((l) => l.reservationId!);
    expect((await Promise.all(ids.map(statusOf))).sort()).toEqual(['CONFIRMED', 'HELD']);

    const confirm = jest.spyOn(inventory, 'confirm');
    expect(await reconciler.run()).toMatchObject({ confirmed: 1, alreadyConfirmed: 1 });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].reservationId).not.toBe(first);
    expect((await Promise.all(ids.map(statusOf)))).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('a replacement hold that expired before recovery is not revived; the view flags CONFIRMATION_FAILED', async () => {
    const o = await placeOrder(ctx);
    await createStockedPharmacy(ctx, o.catalogProductId);
    await declineWithFailedConfirm(o);
    const [line] = await lines(o.orderId);
    await ctx.prisma.stockReservation.update({ where: { id: line.reservationId! }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect(await ctx.app.get(ReservationTtlSweeper).run()).toBe(1);

    const before = await snapshot(o.orderId);
    const confirm = jest.spyOn(inventory, 'confirm');
    expect(await reconciler.run()).toMatchObject({ confirmed: 0, failed: 1 });
    expect(confirm).not.toHaveBeenCalled();
    expect(await statusOf(line.reservationId!)).toBe('EXPIRED');
    expect(await snapshot(o.orderId)).toEqual(before);
    expect((await view('CONFIRMATION_FAILED')).items).toEqual([expect.objectContaining({ state: 'CONFIRMATION_FAILED', diagnosticCode: 'RESERVATION_EXPIRED', reservationStatus: 'EXPIRED' })]);
  });

  /** Waits until PostgreSQL reports a backend blocked on a `stock_reservations` row lock. */
  async function waitForReservationLockWaiter() {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await ctx.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE '%stock_reservations%'`;
      if (row.n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('never blocked on a reservation row lock');
  }
  function gate() {
    let reached!: () => void;
    let resume!: () => void;
    return { at: new Promise<void>((r) => (reached = r)), go: new Promise<void>((r) => (resume = r)), reach: () => reached(), resume: () => resume() };
  }

  it('race — confirmation holds the reservation lock first: the cancellation waits, then releases the CONFIRMED replacement', async () => {
    const o = await placeOrder(ctx);
    await createStockedPharmacy(ctx, o.catalogProductId);
    await declineWithFailedConfirm(o);
    const [line] = await lines(o.orderId);

    // Park confirm inside its transaction, after it locked the reservation (its status write).
    const reservations = ctx.app.get<IReservationRepository>(RESERVATION_REPOSITORY);
    const original = reservations.updateStatus.bind(reservations);
    const g = gate();
    jest.spyOn(reservations, 'updateStatus').mockImplementationOnce(async (...args: Parameters<IReservationRepository['updateStatus']>) => {
      g.reach();
      await g.go;
      return original(...args);
    });
    const reconciling = reconciler.run();
    await g.at;
    const cancelling = request(ctx.server).post(`/orders/${o.orderId}/cancel`).set(...auth(o.customer.accessToken)).send({ reason: 'Changed my mind today' }).then((r) => r);
    await waitForReservationLockWaiter();
    g.resume();

    expect(await reconciling).toMatchObject({ confirmed: 1 });
    expect((await cancelling).status).toBe(200);
    expect(await statusOf(line.reservationId!)).toBe('RELEASED');
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('CANCELLED');
  });

  it('race — the cancellation holds the reservation lock first: confirmation waits, finds it RELEASED and does not revive it', async () => {
    const o = await placeOrder(ctx);
    await createStockedPharmacy(ctx, o.catalogProductId);
    await declineWithFailedConfirm(o);
    const [line] = await lines(o.orderId);

    // 1) Park the reconciler just before its confirm (re-check already passed — no cancellation yet).
    const originalConfirm = inventory.confirm.bind(inventory);
    const r = gate();
    jest.spyOn(inventory, 'confirm').mockImplementationOnce(async (input) => {
      r.reach();
      await r.go;
      return originalConfirm(input);
    });
    const reconciling = reconciler.run();
    await r.at;
    // 2) The cancellation's batch takes the reservation lock, then parks at its listing lock.
    const listings = ctx.app.get<IListingRepository>(LISTING_REPOSITORY);
    const originalLock = listings.lockForUpdate.bind(listings);
    const c = gate();
    jest.spyOn(listings, 'lockForUpdate').mockImplementationOnce(async (id: string, tx: unknown) => {
      c.reach();
      await c.go;
      return originalLock(id, tx);
    });
    const cancelling = request(ctx.server).post(`/orders/${o.orderId}/cancel`).set(...auth(o.customer.accessToken)).send({ reason: 'Changed my mind today' }).then((x) => x);
    await c.at;
    // 3) Let the confirm run into the held lock, then let the cancellation finish.
    r.resume();
    await waitForReservationLockWaiter();
    c.resume();

    expect((await cancelling).status).toBe(200);
    expect(await reconciling).toMatchObject({ confirmed: 0, failed: 1 });
    expect(await statusOf(line.reservationId!)).toBe('RELEASED');
    expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('CANCELLED');
  });

  it('overlapping reconciler runs (another instance): one confirmation, no movement, fulfillment or re-pointing', async () => {
    const o = await placeOrder(ctx);
    await createStockedPharmacy(ctx, o.catalogProductId);
    await declineWithFailedConfirm(o);
    const before = await snapshot(o.orderId);
    const other = new DeclineConfirmationReconciler(ctx.app.get(DECLINE_RECOVERY_REPOSITORY), ctx.app.get(RESERVATION_STATUS_READ_PORT), inventory);
    const [a, b] = await Promise.all([reconciler.run(), other.run()]);
    expect(a.confirmed + b.confirmed + a.alreadyConfirmed + b.alreadyConfirmed).toBe(2); // each saw it once
    expect(a.errors + b.errors + a.failed + b.failed).toBe(0);
    expect(await statusOf(before.lines[0].reservationId!)).toBe('CONFIRMED');
    expect(await snapshot(o.orderId)).toEqual(before);
  });

  it('a decline that stopped before Phase 3a: ORPHANED in the view, never confirmed or re-pointed by the reconciler', async () => {
    const o = await placeOrder(ctx);
    await createStockedPharmacy(ctx, o.catalogProductId);
    const fulfillments = ctx.app.get<IFulfillmentRepository>(FULFILLMENT_REPOSITORY);
    jest.spyOn(fulfillments, 'create').mockRejectedValueOnce(new Error('process stopped in Phase 3a'));
    expect((await decline(o)).status).toBe(500);
    jest.restoreAllMocks();
    const before = await snapshot(o.orderId);
    expect(before.fulfillments.map((f) => f.status)).toEqual(['CANCELLED']);

    const confirm = jest.spyOn(inventory, 'confirm');
    expect(await reconciler.run()).toMatchObject({ orphaned: 1, confirmed: 0 });
    expect(confirm).not.toHaveBeenCalled();
    expect(await snapshot(o.orderId)).toEqual(before);
    expect((await view('ORPHANED')).items).toEqual([expect.objectContaining({ orderId: o.orderId, fulfillmentId: o.fulfillmentId, state: 'ORPHANED', diagnosticCode: 'LINE_ON_CANCELLED_FULFILLMENT' })]);
  });

  it('multi-pharmacy: another live fulfillment does not hide the stranded declined segment', async () => {
    const o = await placeOrder(ctx);
    await createStockedPharmacy(ctx, o.catalogProductId);
    // Checkout only creates single-pharmacy orders, so the second, still-live pharmacy segment is
    // written directly: fulfillment C (ACCEPTED) with its own line and a CONFIRMED reservation. A real
    // multi-pharmacy checkout creates all its fulfillments in one transaction, so C carries the
    // original fulfillment's creation time (only Phase 3a creates a fulfillment later).
    const c = await createStockedPharmacy(ctx, o.catalogProductId);
    const listingC = await ctx.prisma.inventoryListing.findFirstOrThrow({ where: { branchId: c.branchId } });
    const reservationC = (await inventory.reserve({ listingId: listingC.id, quantity: 1, orderId: o.orderId, idempotencyKey: `seg-${randomUUID()}` })).reservationId;
    await inventory.confirm({ reservationId: reservationC });
    const original = await ctx.prisma.fulfillment.findUniqueOrThrow({ where: { id: o.fulfillmentId } });
    const fC = await ctx.prisma.fulfillment.create({ data: { orderId: o.orderId, pharmacyId: c.pharmacyId, branchId: c.branchId, status: 'ACCEPTED', createdAt: original.createdAt } });
    const lineA = (await lines(o.orderId))[0];
    await ctx.prisma.orderLine.create({ data: { orderId: o.orderId, catalogProductId: lineA.catalogProductId, quantity: 1, unitPrice: 2500, lineTotal: 2500, fulfillmentId: fC.id, pharmacyId: c.pharmacyId, branchId: c.branchId, reservationId: reservationC, lineStatus: 'RESERVED' } });

    jest.spyOn(ctx.app.get<IFulfillmentRepository>(FULFILLMENT_REPOSITORY), 'create').mockRejectedValueOnce(new Error('process stopped in Phase 3a'));
    await decline(o);
    jest.restoreAllMocks();

    const items = (await view()).items.filter((s) => s.orderId === o.orderId);
    expect(items.map((s) => [s.lineId, s.fulfillmentId, s.state])).toEqual([[lineA.id, o.fulfillmentId, 'ORPHANED']]);
    expect(await reconciler.run()).toMatchObject({ orphaned: 1, confirmed: 0 });
    expect(await statusOf(reservationC)).toBe('CONFIRMED');
  });

  it('an ordinary, fully completed decline is RESOLVED — not flagged, nothing for the reconciler to do', async () => {
    const o = await placeOrder(ctx);
    await createStockedPharmacy(ctx, o.catalogProductId);
    await decline(o).expect(200);
    const v = await view();
    expect(v.items.map((s) => s.state)).toEqual(['RESOLVED']);
    expect(v.pageCounts).toEqual({ PENDING_CONFIRMATION: 0, CONFIRMATION_FAILED: 0, ORPHANED: 0, RESOLVED: 1 });
    expect(v.countsScope).toBe('CURRENT_PAGE');
    const confirm = jest.spyOn(inventory, 'confirm');
    expect(await reconciler.run()).toMatchObject({ confirmed: 0, alreadyConfirmed: 1, failed: 0, orphaned: 0 });
    expect(confirm).not.toHaveBeenCalled();
    // ADMIN only; no customer data.
    await request(ctx.server).get('/admin/operations/order-decline-recovery').set(...auth(o.customer.accessToken)).expect(403);
    await request(ctx.server).get('/admin/operations/order-decline-recovery').expect(401);
    expect(JSON.stringify(v)).not.toContain(o.customer.userId);
  });

  it('count semantics across pages: totalOrders is global; pageCounts cover only the current page (countsScope CURRENT_PAGE)', async () => {
    // Two candidate orders in different states: one PENDING_CONFIRMATION, one ORPHANED.
    const pending = await placeOrder(ctx);
    await createStockedPharmacy(ctx, pending.catalogProductId);
    await declineWithFailedConfirm(pending);
    const orphan = await placeOrder(ctx);
    await createStockedPharmacy(ctx, orphan.catalogProductId);
    jest.spyOn(ctx.app.get<IFulfillmentRepository>(FULFILLMENT_REPOSITORY), 'create').mockRejectedValueOnce(new Error('process stopped in Phase 3a'));
    await decline(orphan);
    jest.restoreAllMocks();

    const [p1, p2] = [await view(undefined, { page: 1, size: 1 }), await view(undefined, { page: 2, size: 1 })];
    for (const p of [p1, p2]) {
      expect(p.totalOrders).toBe(2); // global
      expect(p.countsScope).toBe('CURRENT_PAGE');
      expect(p.items.map((s) => s.orderId).length).toBe(1);
      // A page's counts are exactly its own items' states — and never include the other page.
      const own = Object.fromEntries(['PENDING_CONFIRMATION', 'CONFIRMATION_FAILED', 'ORPHANED', 'RESOLVED'].map((k) => [k, p.items.filter((s) => s.state === k).length]));
      expect(p.pageCounts).toEqual(own);
      expect(Object.values(p.pageCounts).reduce((a, b) => a + b, 0)).toBe(1);
    }
    expect([...p1.items, ...p2.items].map((s) => s.state).sort()).toEqual(['ORPHANED', 'PENDING_CONFIRMATION']);
    expect((await view(undefined, { page: 1, size: 2 })).pageCounts).toMatchObject({ PENDING_CONFIRMATION: 1, ORPHANED: 1 });
  });
});
