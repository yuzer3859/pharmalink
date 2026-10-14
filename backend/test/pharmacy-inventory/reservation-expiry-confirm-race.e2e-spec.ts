import request from 'supertest';
import { OutboxService } from '../../src/shared/outbox/outbox.service';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  IListingRepository,
  LISTING_REPOSITORY,
} from '../../src/modules/pharmacy-inventory/domain/repositories/listing.repository';
import {
  IReservationRepository,
  RESERVATION_REPOSITORY,
} from '../../src/modules/pharmacy-inventory/domain/repositories/reservation.repository';
import { ReservationTtlSweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/reservation-ttl.sweeper';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

/**
 * Module 04 Work 53 against real PostgreSQL: confirm vs TTL expiry vs release, with the
 * interleavings forced deterministically rather than left to scheduling. Every reservation-mutating
 * flow locks the reservation row and THEN the listing (`IListingRepository.lockForUpdate`), so a
 * one-shot pause on the real listing repository's `lockForUpdate` parks a flow at a known point
 * while it holds the reservation row lock; `waitForLockWaiter` then waits until PostgreSQL itself
 * reports the competing statement blocked on a lock before the parked flow is let go.
 */
describe('Reservation expiry vs confirm race (e2e, Work 53)', () => {
  let ctx: TestContext;
  let inventoryPort: IInventoryPort;
  let sweeper: ReservationTtlSweeper;
  let listings: IListingRepository;

  beforeAll(async () => {
    ctx = await createTestApp();
    inventoryPort = ctx.app.get<IInventoryPort>(INVENTORY_PORT);
    sweeper = ctx.app.get(ReservationTtlSweeper);
    listings = ctx.app.get<IListingRepository>(LISTING_REPOSITORY);
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

  async function seedListing(quantity = 10) {
    const pharmacy = await createActivatedPharmacy(ctx);
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const mfr = body(
      await request(ctx.server).post('/admin/catalog/manufacturers').set(...auth(admin.accessToken)).send({ name: 'Acme Pharma' }).expect(201),
    );
    const product = body(
      await request(ctx.server)
        .post('/admin/catalog/products')
        .set(...auth(admin.accessToken))
        .send({
          type: 'MEDICINE', genericName: 'Metformin', manufacturerId: mfr.id, dosageForm: 'TABLET',
          strengthValue: 500, strengthUnit: 'MG', rxClassification: 'OTC', nameEn: 'Metformin 500mg',
        })
        .expect(201),
    );
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
    const branch = body(
      await request(ctx.server).post('/pharmacy/branches').set(...auth(pharmacy.accessToken)).send({ name: 'Main Branch' }).expect(201),
    );
    const listing = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: product.id, branchId: branch.branchId, price: 900, batchNumber: 'B-1',
          initialQuantity: quantity, expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    return listing.listingId as string;
  }

  let seq = 0;
  async function hold(listingId: string, quantity: number, lapsed: boolean) {
    seq += 1;
    const { reservationId } = await inventoryPort.reserve({ listingId, quantity, orderId: `order-w53-${seq}`, idempotencyKey: `idem-w53-${seq}` });
    if (lapsed) {
      // Only the clock moves past the TTL; every other column is as Module 04's reserve wrote it.
      await ctx.prisma.stockReservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    }
    return reservationId;
  }

  /** Parks the next `listings.lockForUpdate` caller — i.e. a flow that already holds a reservation row lock. */
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

  /** Waits until PostgreSQL reports a backend blocked on a lock (the competing flow's FOR UPDATE). */
  async function waitForLockWaiter() {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await ctx.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      if (row.n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the competing flow never blocked on the reservation row lock');
  }

  const statusOf = async (id: string) => (await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id } })).status;
  const releases = (reservationId: string) => ctx.prisma.stockMovement.count({ where: { reservationId, type: 'RELEASE' } });
  /** `outbox.payload` stores the whole event envelope; the event's own payload is nested inside it. */
  const releasedEvents = async (reservationId: string) =>
    (await ctx.prisma.outbox.findMany({ where: { eventType: 'pharmacy.stock.released' } }))
      .map((e) => (e.payload as { payload: { reservationId: string; quantity: number; reason: string | null } }).payload)
      .filter((p) => p.reservationId === reservationId);
  const listingCounts = async (listingId: string) => {
    const l = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    return { reserved: l.reserved, sellable: l.sellable, onHand: l.onHand };
  };
  /** module-04 §17.3 reconciliation — on-hand equals the sum of on-hand movements. */
  async function reconcile(listingId: string) {
    const sum = await ctx.prisma.stockMovement.aggregate({
      where: { listingId, type: { in: ['RECEIPT', 'ADJUST', 'DISPATCH'] } },
      _sum: { quantityDelta: true },
    });
    expect(sum._sum.quantityDelta ?? 0).toBe((await listingCounts(listingId)).onHand);
  }
  const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? String(e));

  it('a valid (unexpired) confirm succeeds: CONFIRMED, quantities untouched, no release movement or event', async () => {
    const listingId = await seedListing(10);
    const id = await hold(listingId, 4, false);
    const audits = await ctx.prisma.auditLog.count();

    await inventoryPort.confirm({ reservationId: id });

    expect(await statusOf(id)).toBe('CONFIRMED');
    expect(await listingCounts(listingId)).toEqual({ reserved: 4, sellable: 6, onHand: 10 });
    expect(await releases(id)).toBe(0);
    expect(await releasedEvents(id)).toHaveLength(0);
    expect(await ctx.prisma.auditLog.count()).toBe(audits);
    await reconcile(listingId);
  });

  it('confirm locks first while a sweeper tick runs: the tick SKIP LOCKED-skips the row, and confirm ' +
    'itself expires the lapsed hold exactly once before rejecting — it is not left HELD', async () => {
    const listingId = await seedListing(10);
    const id = await hold(listingId, 4, true);
    const audits = await ctx.prisma.auditLog.count();

    const pause = pauseAtListingLock();
    const confirming = codeOf(inventoryPort.confirm({ reservationId: id }));
    await pause.atLock; // confirm holds the reservation row lock and has found the hold lapsed
    expect(await sweeper.run()).toBe(0); // the concurrent tick skipped the locked row
    pause.resume();

    expect(await confirming).toBe('RESERVATION_EXPIRED');
    expect(await statusOf(id)).toBe('EXPIRED');
    expect(await releases(id)).toBe(1);
    expect(await releasedEvents(id)).toEqual([expect.objectContaining({ quantity: 4, reason: 'TTL_EXPIRED' })]);
    expect(await listingCounts(listingId)).toEqual({ reserved: 0, sellable: 10, onHand: 10 });
    expect(await sweeper.run()).toBe(0); // nothing left for a later tick: no second release
    expect(await releases(id)).toBe(1);
    expect(await ctx.prisma.auditLog.count()).toBe(audits);
    await reconcile(listingId);
  });

  it('the sweeper locks first while confirm runs: confirm waits on the row, then sees EXPIRED and ' +
    'throws INVALID_RESERVATION_STATE; one release in all', async () => {
    const listingId = await seedListing(10);
    const id = await hold(listingId, 4, true);

    const pause = pauseAtListingLock();
    const sweeping = sweeper.run();
    await pause.atLock; // the sweeper holds the reservation row lock
    const confirming = codeOf(inventoryPort.confirm({ reservationId: id }));
    await waitForLockWaiter(); // confirm is blocked on that row
    pause.resume();

    expect(await sweeping).toBe(1);
    expect(await confirming).toBe('INVALID_RESERVATION_STATE');
    expect(await statusOf(id)).toBe('EXPIRED');
    expect(await releases(id)).toBe(1);
    expect(await releasedEvents(id)).toHaveLength(1);
    expect(await listingCounts(listingId)).toEqual({ reserved: 0, sellable: 10, onHand: 10 });
    await reconcile(listingId);
  });

  it('confirm-expiry racing a release (order cancellation): whichever locks first wins; the other is a ' +
    'no-op or a deterministic error; stock is released exactly once in both orders', async () => {
    const listingId = await seedListing(10);

    // Confirm first: it expires the hold; the waiting release then sees EXPIRED and is a no-op.
    const a = await hold(listingId, 3, true);
    let pause = pauseAtListingLock();
    const confirmA = codeOf(inventoryPort.confirm({ reservationId: a }));
    await pause.atLock;
    const releaseA = codeOf(inventoryPort.release({ reservationId: a, reason: 'order-cancelled' }));
    await waitForLockWaiter();
    pause.resume();
    expect([await confirmA, await releaseA]).toEqual(['RESERVATION_EXPIRED', 'OK']);
    expect([await statusOf(a), await releases(a), (await releasedEvents(a)).length]).toEqual(['EXPIRED', 1, 1]);

    // Release first: it releases the hold; the waiting confirm then sees RELEASED and is rejected.
    const b = await hold(listingId, 2, true);
    pause = pauseAtListingLock();
    const releaseB = codeOf(inventoryPort.release({ reservationId: b, reason: 'order-cancelled' }));
    await pause.atLock;
    const confirmB = codeOf(inventoryPort.confirm({ reservationId: b }));
    await waitForLockWaiter();
    pause.resume();
    expect([await releaseB, await confirmB]).toEqual(['OK', 'INVALID_RESERVATION_STATE']);
    expect([await statusOf(b), await releases(b), (await releasedEvents(b)).length]).toEqual(['RELEASED', 1, 1]);

    expect(await listingCounts(listingId)).toEqual({ reserved: 0, sellable: 10, onHand: 10 });
    expect(await sweeper.run()).toBe(0);
    await reconcile(listingId);
  });

  it('cancellation/release of an unexpired hold still works, and a confirmed reservation is never expired', async () => {
    const listingId = await seedListing(10);
    const released = await hold(listingId, 2, false);
    await inventoryPort.release({ reservationId: released, reason: 'order-cancelled' });
    expect([await statusOf(released), await releases(released)]).toEqual(['RELEASED', 1]);
    expect(await codeOf(inventoryPort.confirm({ reservationId: released }))).toBe('INVALID_RESERVATION_STATE');

    const confirmed = await hold(listingId, 3, false);
    await inventoryPort.confirm({ reservationId: confirmed });
    await ctx.prisma.stockReservation.update({ where: { id: confirmed }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect(await sweeper.run()).toBe(0);
    expect(await codeOf(inventoryPort.confirm({ reservationId: confirmed }))).toBe('OK'); // idempotent re-confirm
    expect([await statusOf(confirmed), await releases(confirmed)]).toEqual(['CONFIRMED', 0]);
    expect(await listingCounts(listingId)).toEqual({ reserved: 3, sellable: 7, onHand: 10 });
    await reconcile(listingId);
  });

  it('a failed expiry (sweep or confirm) rolls back cleanly and a later sweep recovers it, exactly once', async () => {
    const listingId = await seedListing(10);
    const id = await hold(listingId, 4, true);
    const outbox = ctx.app.get(OutboxService);
    const before = await listingCounts(listingId);

    jest.spyOn(outbox, 'write').mockRejectedValueOnce(new Error('simulated outbox failure'));
    expect(await sweeper.run()).toBe(0);
    expect([await statusOf(id), await releases(id), (await releasedEvents(id)).length]).toEqual(['HELD', 0, 0]);
    expect(await listingCounts(listingId)).toEqual(before);

    jest.spyOn(outbox, 'write').mockRejectedValueOnce(new Error('simulated outbox failure'));
    expect(await codeOf(inventoryPort.confirm({ reservationId: id }))).toBe('RESERVATION_EXPIRED');
    expect([await statusOf(id), await releases(id), (await releasedEvents(id)).length]).toEqual(['HELD', 0, 0]);
    expect(await listingCounts(listingId)).toEqual(before);

    expect(await sweeper.run()).toBe(1);
    expect([await statusOf(id), await releases(id), (await releasedEvents(id)).length]).toEqual(['EXPIRED', 1, 1]);
    expect(await listingCounts(listingId)).toEqual({ reserved: 0, sellable: 10, onHand: 10 });
    await reconcile(listingId);
  });

  it('overlapping sweeper runs expire each lapsed hold exactly once', async () => {
    const listingId = await seedListing(10);
    const ids = [await hold(listingId, 1, true), await hold(listingId, 2, true), await hold(listingId, 3, true)];

    const processed = await Promise.all([sweeper.run(), sweeper.run(), sweeper.run()]);

    expect(processed.reduce((a, b) => a + b, 0)).toBe(3);
    for (const id of ids) {
      expect([await statusOf(id), await releases(id), (await releasedEvents(id)).length]).toEqual(['EXPIRED', 1, 1]);
    }
    expect(await listingCounts(listingId)).toEqual({ reserved: 0, sellable: 10, onHand: 10 });
    expect(await sweeper.run()).toBe(0);
    await reconcile(listingId);
  });

  it("the sweeper's expiry boundary is unchanged: strictly expiresAt < now", async () => {
    const listingId = await seedListing(10);
    const id = await hold(listingId, 1, false);
    const { expiresAt } = await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id } });
    const reservations = ctx.app.get<IReservationRepository>(RESERVATION_REPOSITORY);
    const lockedAt = (now: Date) => ctx.prisma.$transaction((tx) => reservations.lockNextExpired(now, [], tx));

    expect(await lockedAt(expiresAt)).toBeNull();
    expect((await lockedAt(new Date(expiresAt.getTime() + 1)))?.id).toBe(id);
    expect(await statusOf(id)).toBe('HELD');
  });
});
