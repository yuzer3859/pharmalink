import request from 'supertest';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../src/modules/pharmacy-inventory/application/ports/inbound/inventory.port';
import { ReservationTtlSweeper } from '../../src/modules/pharmacy-inventory/infrastructure/scheduling/reservation-ttl.sweeper';
import { auth, body, createUserWithRole } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createActivatedPharmacy } from './support';

async function activeCatalogProduct(ctx: TestContext) {
  const admin = await createUserWithRole(ctx, 'ADMIN');
  const mfr = body(
    await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(admin.accessToken))
      .send({ name: 'Acme Pharma' })
      .expect(201),
  );
  const product = body(
    await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({
        type: 'MEDICINE',
        genericName: 'Metformin',
        manufacturerId: mfr.id,
        dosageForm: 'TABLET',
        strengthValue: 500,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn: 'Metformin 500mg',
      })
      .expect(201),
  );
  // Published only through catalogue review (module-16 Work 30): submit (DRAFT -> PENDING_REVIEW), then approve (-> ACTIVE).
  await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/submit`).set(...auth(admin.accessToken)).expect(200);
  await request(ctx.server).post(`/admin/catalog/review/${product.id as string}/approve`).set(...auth(admin.accessToken)).expect(200);
  return product.id as string;
}

/**
 * Reconciliation invariant (module-04 §3.10.4/§17.3) — see the identical helper in
 * `listing-lifecycle.e2e-spec.ts` for the rationale on excluding `RESERVE`/`RELEASE`.
 */
async function reconcile(ctx: TestContext, listingId: string) {
  const listing = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
  const sum = await ctx.prisma.stockMovement.aggregate({
    where: { listingId, type: { in: ['RECEIPT', 'ADJUST', 'DISPATCH'] } },
    _sum: { quantityDelta: true },
  });
  expect(sum._sum.quantityDelta ?? 0).toBe(listing.onHand);
}

describe('Reservation lifecycle & concurrency (e2e, via IInventoryPort in-process)', () => {
  let ctx: TestContext;
  let inventoryPort: IInventoryPort;

  beforeAll(async () => {
    ctx = await createTestApp();
    inventoryPort = ctx.app.get<IInventoryPort>(INVENTORY_PORT);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  async function seedListing(ctx: TestContext, quantity = 10) {
    const pharmacy = await createActivatedPharmacy(ctx);
    const productId = await activeCatalogProduct(ctx);
    const branch = body(
      await request(ctx.server)
        .post('/pharmacy/branches')
        .set(...auth(pharmacy.accessToken))
        .send({ name: 'Main Branch' })
        .expect(201),
    );
    const listing = body(
      await request(ctx.server)
        .post('/inventory/listings')
        .set(...auth(pharmacy.accessToken))
        .send({
          catalogProductId: productId,
          branchId: branch.branchId,
          price: 900,
          batchNumber: 'B-1',
          initialQuantity: quantity,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .expect(201),
    );
    return { listingId: listing.listingId as string, productId, pharmacy };
  }

  it('reserve -> confirm -> dispatch happy path, with ledger reconciliation at every step; availability reflects sellable', async () => {
    const { listingId, productId } = await seedListing(ctx, 10);

    let availability = body(
      await request(ctx.server).get(`/availability/product/${productId}`).expect(200),
    ) as unknown as Array<{ listingId: string; sellable: number }>;
    expect(availability.find((r) => r.listingId === listingId)?.sellable).toBe(10);

    const orderId = 'order-happy-1';
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 4,
      orderId,
      idempotencyKey: 'idem-1',
    });
    await reconcile(ctx, listingId);

    availability = body(
      await request(ctx.server).get(`/availability/product/${productId}`).expect(200),
    ) as unknown as Array<{ listingId: string; sellable: number }>;
    expect(availability.find((r) => r.listingId === listingId)?.sellable).toBe(6);

    await inventoryPort.confirm({ reservationId: reservation.reservationId });
    await inventoryPort.dispatch({ reservationId: reservation.reservationId });
    await reconcile(ctx, listingId);

    const fulfillment = await inventoryPort.getReservationFulfillment(reservation.reservationId);
    expect(fulfillment.dispatched).toBe(true);
    expect(fulfillment.dispatchedQuantity).toBe(4);

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.onHand).toBe(6);
    expect(listingRow.reserved).toBe(0);
  });

  it('reserve -> release restores sellable; release is idempotent', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 3,
      orderId: 'order-release-1',
      idempotencyKey: 'idem-2',
    });
    await inventoryPort.release({ reservationId: reservation.reservationId, reason: 'customer cancelled' });
    await reconcile(ctx, listingId);

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(0);
    expect(listingRow.sellable).toBe(10);

    // Idempotent repeat release — must not double-credit sellable.
    await inventoryPort.release({ reservationId: reservation.reservationId });
    const afterSecondRelease = await ctx.prisma.inventoryListing.findUniqueOrThrow({
      where: { id: listingId },
    });
    expect(afterSecondRelease.sellable).toBe(10);
  });

  it('idempotency-key replay for the same order returns the original reservation without a second write', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const first = await inventoryPort.reserve({
      listingId,
      quantity: 2,
      orderId: 'order-idem-1',
      idempotencyKey: 'idem-3',
    });
    const second = await inventoryPort.reserve({
      listingId,
      quantity: 2,
      orderId: 'order-idem-1',
      idempotencyKey: 'idem-3',
    });
    expect(second.reservationId).toBe(first.reservationId);

    const count = await ctx.prisma.stockReservation.count({ where: { listingId, orderId: 'order-idem-1' } });
    expect(count).toBe(1);
  });

  it('concurrent reserve race on the last unit: exactly one of two parallel reserves succeeds', async () => {
    const { listingId } = await seedListing(ctx, 1);

    const results = await Promise.allSettled([
      inventoryPort.reserve({ listingId, quantity: 1, orderId: 'order-race-a', idempotencyKey: 'race-a' }),
      inventoryPort.reserve({ listingId, quantity: 1, orderId: 'order-race-b', idempotencyKey: 'race-b' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    await reconcile(ctx, listingId);
    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(1);
    expect(listingRow.sellable).toBe(0);
  });

  // -----------------------------------------------------------------------------------------
  // Step 1 — idempotency key persistence/enforcement (module-04 §5.4/§8/§15).
  // -----------------------------------------------------------------------------------------

  it('idempotency conflict: reusing the same key with a different orderId/quantity is rejected ' +
    'deterministically instead of silently returning the mismatched reservation', async () => {
    const { listingId } = await seedListing(ctx, 10);
    await inventoryPort.reserve({
      listingId,
      quantity: 2,
      orderId: 'order-conflict-1',
      idempotencyKey: 'idem-conflict',
    });

    await expect(
      inventoryPort.reserve({
        listingId,
        quantity: 2,
        orderId: 'order-conflict-2', // different order, same key
        idempotencyKey: 'idem-conflict',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    await expect(
      inventoryPort.reserve({
        listingId,
        quantity: 5, // different quantity, same key/order
        orderId: 'order-conflict-1',
        idempotencyKey: 'idem-conflict',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const count = await ctx.prisma.stockReservation.count({ where: { listingId } });
    expect(count).toBe(1);
  });

  it('two simultaneous requests with the identical idempotency key resolve to exactly one ' +
    'persisted reservation (DB unique-constraint race-safety, not just an app-level pre-check)', async () => {
    const { listingId } = await seedListing(ctx, 10);

    const results = await Promise.allSettled([
      inventoryPort.reserve({
        listingId,
        quantity: 3,
        orderId: 'order-samekey',
        idempotencyKey: 'idem-samekey',
      }),
      inventoryPort.reserve({
        listingId,
        quantity: 3,
        orderId: 'order-samekey',
        idempotencyKey: 'idem-samekey',
      }),
    ]);

    // Both resolve to the same reservation (replay semantics) — neither is rejected, since the
    // payload is identical.
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      reservationId: string;
    }>[];
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled[0].value.reservationId).toBe(fulfilled[1].value.reservationId);

    const count = await ctx.prisma.stockReservation.count({
      where: { listingId, idempotencyKey: 'idem-samekey' },
    });
    expect(count).toBe(1);

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(3); // not double-reserved
  });

  // -----------------------------------------------------------------------------------------
  // Step 2 — concurrent reservation transitions must not double-apply effects (module-04 §8).
  // -----------------------------------------------------------------------------------------

  it('two concurrent manual releases of the same reservation: exactly one has effect, the other is a no-op', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 4,
      orderId: 'order-concurrent-release',
      idempotencyKey: 'idem-concurrent-release',
    });

    await Promise.allSettled([
      inventoryPort.release({ reservationId: reservation.reservationId, reason: 'race-a' }),
      inventoryPort.release({ reservationId: reservation.reservationId, reason: 'race-b' }),
    ]);

    const releaseMovements = await ctx.prisma.stockMovement.count({
      where: { listingId, type: 'RELEASE' },
    });
    expect(releaseMovements).toBe(1);

    const reservationRow = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservation.reservationId },
    });
    expect(reservationRow.status).toBe('RELEASED');

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(0);
    expect(listingRow.sellable).toBe(10);
    await reconcile(ctx, listingId);
  });

  it('manual release racing TTL expiration: whichever wins the row lock establishes the ' +
    'terminal state, the other is a no-op — no double RELEASE movement or double sellable credit', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 4,
      orderId: 'order-release-vs-expire',
      idempotencyKey: 'idem-release-vs-expire',
    });
    // Force it past its TTL so the sweeper's batch scan picks it up.
    await ctx.prisma.stockReservation.update({
      where: { id: reservation.reservationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const sweeper = ctx.app.get(ReservationTtlSweeper);

    await Promise.allSettled([
      sweeper.run(),
      inventoryPort.release({ reservationId: reservation.reservationId, reason: 'manual-race' }),
    ]);

    const releaseMovements = await ctx.prisma.stockMovement.count({
      where: { listingId, type: 'RELEASE' },
    });
    expect(releaseMovements).toBe(1);

    const reservationRow = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservation.reservationId },
    });
    expect(['RELEASED', 'EXPIRED']).toContain(reservationRow.status);

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(0);
    expect(listingRow.sellable).toBe(10);
    await reconcile(ctx, listingId);
  });

  it('confirm racing TTL expiration: confirm never succeeds on a lapsed hold, and the hold is ' +
    'expired exactly once — by this sweeper tick or, if confirm held the row lock, the next one', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 2,
      orderId: 'order-confirm-vs-expire',
      idempotencyKey: 'idem-confirm-vs-expire',
    });
    await ctx.prisma.stockReservation.update({
      where: { id: reservation.reservationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const sweeper = ctx.app.get(ReservationTtlSweeper);

    const results = await Promise.allSettled([
      sweeper.run(),
      inventoryPort.confirm({ reservationId: reservation.reservationId }),
    ]);

    // `expiresAt` is in the past, so confirm must reject whichever side locks the row first.
    const confirmResult = results[1];
    expect(confirmResult.status).toBe('rejected');
    const confirmError = (confirmResult as PromiseRejectedResult).reason as { code: string };

    const releaseCount = () =>
      ctx.prisma.stockMovement.count({ where: { listingId, type: 'RELEASE' } });
    const statusOf = async () =>
      (await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: reservation.reservationId } }))
        .status;

    if (confirmError.code === 'INVALID_RESERVATION_STATE') {
      // Sweeper locked and committed first; confirm then saw EXPIRED under its own lock.
      expect(await statusOf()).toBe('EXPIRED');
      expect(await releaseCount()).toBe(1);
    } else {
      // Confirm locked first and rejected the lapsed hold without mutating it. A sweeper that
      // reached the row while confirm still held the lock SKIP LOCKED-skipped it, leaving it
      // HELD for a later tick; one that arrived after confirm's rollback expired it this tick.
      expect(confirmError.code).toBe('RESERVATION_EXPIRED');
      const status = await statusOf();
      expect(['HELD', 'EXPIRED']).toContain(status);
      expect(await releaseCount()).toBe(status === 'HELD' ? 0 : 1);
      if (status === 'HELD') {
        // The next tick must pick it up — a lapsed hold is never stranded.
        expect(await sweeper.run()).toBe(1);
        expect(await statusOf()).toBe('EXPIRED');
        expect(await releaseCount()).toBe(1);
      }
    }

    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(0);
    expect(listingRow.sellable).toBe(10);
    await reconcile(ctx, listingId);
  });

  it('dispatch racing release: the loser sees the terminal state under its own lock and throws ' +
    'INVALID_RESERVATION_STATE rather than dispatching stock for a released reservation', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 2,
      orderId: 'order-dispatch-vs-release',
      idempotencyKey: 'idem-dispatch-vs-release',
    });
    await inventoryPort.confirm({ reservationId: reservation.reservationId });

    const results = await Promise.allSettled([
      inventoryPort.dispatch({ reservationId: reservation.reservationId }),
      inventoryPort.release({ reservationId: reservation.reservationId, reason: 'race' }),
    ]);

    const [dispatchResult] = results;
    const reservationRow = await ctx.prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservation.reservationId },
    });
    if (dispatchResult.status === 'fulfilled') {
      expect(reservationRow.status).toBe('CONFIRMED'); // dispatch doesn't change reservation status
      const dispatchMovements = await ctx.prisma.stockMovement.count({
        where: { listingId, type: 'DISPATCH' },
      });
      expect(dispatchMovements).toBeGreaterThan(0);
    } else {
      expect((dispatchResult as PromiseRejectedResult).reason).toMatchObject({
        code: 'INVALID_RESERVATION_STATE',
      });
      expect(reservationRow.status).toBe('RELEASED');
    }
    // Exactly one side wins: when dispatch commits first, release sees its DISPATCH movements under
    // the reservation lock and is rejected, so `reserved` is decremented exactly once either way.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [, releaseResult] = results;
    if (dispatchResult.status === 'fulfilled') {
      expect((releaseResult as PromiseRejectedResult).reason).toMatchObject({
        code: 'INVALID_RESERVATION_STATE',
      });
      expect(await ctx.prisma.stockMovement.count({ where: { listingId, type: 'RELEASE' } })).toBe(0);
    }
    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(0);
    await reconcile(ctx, listingId);
  });

  it('release after dispatch is rejected with INVALID_RESERVATION_STATE and leaves reserved intact, ' +
    'even when a sibling reservation keeps reserved high enough to hide a double decrement', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const dispatched = await inventoryPort.reserve({
      listingId,
      quantity: 2,
      orderId: 'order-release-after-dispatch',
      idempotencyKey: 'idem-release-after-dispatch',
    });
    // Sibling hold on the same listing: reserved stays >= 2 after dispatch, so the old code's
    // underflow assertion would not have caught a second decrement.
    const sibling = await inventoryPort.reserve({
      listingId,
      quantity: 3,
      orderId: 'order-release-after-dispatch-sibling',
      idempotencyKey: 'idem-release-after-dispatch-sibling',
    });
    await inventoryPort.confirm({ reservationId: dispatched.reservationId });
    await inventoryPort.dispatch({ reservationId: dispatched.reservationId });

    await expect(
      inventoryPort.release({ reservationId: dispatched.reservationId, reason: 'customer-cancel' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESERVATION_STATE' });

    expect(
      await ctx.prisma.stockReservation.findUniqueOrThrow({ where: { id: dispatched.reservationId } }),
    ).toMatchObject({ status: 'CONFIRMED' });
    expect(
      await ctx.prisma.stockMovement.count({ where: { reservationId: dispatched.reservationId, type: 'RELEASE' } }),
    ).toBe(0);
    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.onHand).toBe(8);
    expect(listingRow.reserved).toBe(3);
    expect(listingRow.sellable).toBe(5);
    // Same recount as Module 16's reservation-integrity view: only the undispatched sibling HOLD
    // contributes, so stored and derived agree (difference 0).
    const contributing = await ctx.prisma.stockReservation.aggregate({
      where: { listingId, status: 'HELD' },
      _sum: { quantity: true },
    });
    expect(contributing._sum.quantity).toBe(listingRow.reserved);
    await reconcile(ctx, listingId);

    // The sibling is unaffected and still releases normally.
    await inventoryPort.release({ reservationId: sibling.reservationId, reason: 'customer-cancel' });
    const afterSibling = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(afterSibling.reserved).toBe(0);
    expect(afterSibling.sellable).toBe(8);
  });

  it('repeated release after expiration remains a true no-op (no second movement/outbox row)', async () => {
    const { listingId } = await seedListing(ctx, 10);
    const reservation = await inventoryPort.reserve({
      listingId,
      quantity: 2,
      orderId: 'order-repeat-release',
      idempotencyKey: 'idem-repeat-release',
    });
    await ctx.prisma.stockReservation.update({
      where: { id: reservation.reservationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const sweeper = ctx.app.get(ReservationTtlSweeper);
    await sweeper.run();

    // A manual release retried after the sweeper already expired it must be a no-op.
    await inventoryPort.release({ reservationId: reservation.reservationId, reason: 'late-retry' });
    await inventoryPort.release({ reservationId: reservation.reservationId, reason: 'late-retry-2' });

    const releaseMovements = await ctx.prisma.stockMovement.count({
      where: { listingId, type: 'RELEASE' },
    });
    expect(releaseMovements).toBe(1);
    const listingRow = await ctx.prisma.inventoryListing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listingRow.reserved).toBe(0);
    expect(listingRow.sellable).toBe(10);
  });
});
