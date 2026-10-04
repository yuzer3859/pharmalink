import { ReservationTtlSweeper } from './reservation-ttl.sweeper';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { ReservationStatus, StorageRequirement } from '../../domain/enums';

/**
 * Unit coverage for the hardening fix to `ReservationTtlSweeper` (module-04 §8): invariants must
 * be calculated and validated BEFORE any write, and an invariant failure must never leave a
 * partially-applied expiration (terminal status + movement committed, but no cache/outbox
 * update). See `test/pharmacy-inventory/reservation-concurrency.e2e-spec.ts` and
 * `test/pharmacy-inventory/ttl-sweeper-atomicity.e2e-spec.ts` for the real-Postgres proof of the
 * same guarantees.
 */
describe('ReservationTtlSweeper', () => {
  const listingId = 'listing-1';
  const reservationId = 'reservation-1';
  const expiredReservation = {
    id: reservationId,
    listingId,
    orderId: 'order-1',
    quantity: 4,
    status: ReservationStatus.HELD,
    expiresAt: new Date(Date.now() - 60_000),
    createdAt: new Date(),
  };

  function buildListing(onHand = 10, reserved = 4): InventoryListing {
    const listing = InventoryListing.create(listingId, {
      pharmacyId: 'pharmacy-1',
      branchId: 'branch-1',
      catalogProductId: 'product-1',
      price: 100,
      currency: 'ETB',
      storageRequirement: StorageRequirement.AMBIENT,
    });
    return InventoryListing.rehydrate({ ...listing.toProps(), onHand, reserved, sellable: onHand - reserved });
  }

  let prisma: { $transaction: jest.Mock };
  let reservations: {
    lockNextExpired: jest.Mock;
    updateStatus: jest.Mock;
  };
  let listings: { lockForUpdate: jest.Mock; updateCache: jest.Mock };
  let ledger: { findBatchesByListing: jest.Mock; recordMovement: jest.Mock };
  let outbox: { write: jest.Mock };
  let sweeper: ReservationTtlSweeper;

  beforeEach(() => {
    prisma = {
      // Mirrors Prisma's real $transaction signature closely enough for unit purposes: runs the
      // callback against a fake tx token and propagates a thrown error as a rejection (a real
      // rollback, from the caller's perspective, is indistinguishable from a rejected promise).
      $transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})),
    };
    // Combined discovery+lock: returns the reservation once, then `null` (simulating that it's
    // now terminal/excluded), so a naive infinite-loop bug in the sweeper would be caught by
    // tests asserting a bounded number of `$transaction` calls.
    let returned = false;
    reservations = {
      lockNextExpired: jest.fn().mockImplementation(async () => {
        if (returned) return null;
        returned = true;
        return expiredReservation;
      }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    listings = {
      lockForUpdate: jest.fn().mockResolvedValue(buildListing()),
      updateCache: jest.fn().mockResolvedValue(undefined),
    };
    ledger = {
      findBatchesByListing: jest.fn().mockResolvedValue([
        { id: 'batch-1', quantity: 10, expiryDate: new Date('2030-01-01') },
      ]),
      recordMovement: jest.fn().mockResolvedValue(undefined),
    };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };

    sweeper = new ReservationTtlSweeper(
      prisma as never,
      reservations as never,
      listings as never,
      ledger as never,
      outbox as never,
    );
  });

  it('a valid expiration writes status, movement, cache, and outbox atomically', async () => {
    const processed = await sweeper.run();
    expect(processed).toBe(1);
    expect(reservations.updateStatus).toHaveBeenCalledWith(reservationId, ReservationStatus.EXPIRED, {});
    expect(ledger.recordMovement).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RELEASE', quantityDelta: 4, reservationId }),
      {},
    );
    expect(listings.updateCache).toHaveBeenCalledWith(listingId, { reserved: 0, sellable: 10 }, {});
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('an invariant failure (reserved would go negative) writes NOTHING — no status, movement, ' +
    'cache, or outbox change — instead of logging and committing a partial expiration', async () => {
    // listing.reserved (0) < reservation.quantity (4): an inconsistent state that must never be
    // allowed to commit a partial expiration.
    listings.lockForUpdate.mockResolvedValue(buildListing(10, 0));

    const processed = await sweeper.run();

    expect(processed).toBe(0);
    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(ledger.recordMovement).not.toHaveBeenCalled();
    expect(listings.updateCache).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('validates invariants before issuing any write (order of operations, not just final state)', async () => {
    listings.lockForUpdate.mockResolvedValue(buildListing(10, 0));
    const writeOrder: string[] = [];
    reservations.updateStatus.mockImplementation(async () => writeOrder.push('updateStatus'));
    ledger.recordMovement.mockImplementation(async () => writeOrder.push('recordMovement'));
    listings.updateCache.mockImplementation(async () => writeOrder.push('updateCache'));

    await sweeper.run();

    expect(writeOrder).toEqual([]);
  });

  it('a thrown error inside one reservation transaction does not stop the sweep from processing ' +
    'the rest of the batch — the failing row is excluded from subsequent lookups this tick so ' +
    'it cannot starve every other eligible reservation', async () => {
    const badReservationId = 'bad-reservation';
    const badReservation = { ...expiredReservation, id: badReservationId, quantity: 999 };
    // First call (no exclusions yet) returns the bad row; once it's excluded, the next call
    // returns the good row (simulating it really being expired and no longer matching
    // `status='HELD'` in the DB); every call after that finds nothing left.
    let goodHandled = false;
    reservations.lockNextExpired.mockImplementation(async (_now: Date, excludeIds: string[]) => {
      if (!excludeIds.includes(badReservationId)) {
        return badReservation;
      }
      if (!goodHandled) {
        goodHandled = true;
        return expiredReservation;
      }
      return null;
    });
    // The bad row's quantity (999) underflows against onHand=10/reserved=4; the good row's
    // quantity (4) does not.
    listings.lockForUpdate.mockResolvedValue(buildListing(10, 4));

    const processed = await sweeper.run();

    expect(processed).toBe(1);
    expect(reservations.updateStatus).toHaveBeenCalledTimes(1);
    expect(reservations.updateStatus).toHaveBeenCalledWith(reservationId, ReservationStatus.EXPIRED, {});
    // The failing id was passed as an exclusion on the next lookup, proving it doesn't get
    // re-selected forever as the earliest `expiresAt`.
    expect(reservations.lockNextExpired).toHaveBeenCalledWith(
      expect.any(Date),
      expect.arrayContaining([badReservationId]),
      {},
    );
  });

  it('skips a row lockNextExpired reports as no longer HELD/expired (SKIP LOCKED / concurrent race)', async () => {
    reservations.lockNextExpired.mockResolvedValue(null);
    const processed = await sweeper.run();
    expect(processed).toBe(0);
    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('a failure while writing the outbox propagates as a rejected transaction, so the sweeper ' +
    'treats this reservation as not-handled-this-tick instead of swallowing the error — a real ' +
    'Postgres transaction rolls back everything else written in the same callback (proven ' +
    'against a real DB in `ttl-sweeper-atomicity.e2e-spec.ts`)', async () => {
    outbox.write.mockRejectedValue(new Error('CONTROLLED_FAILURE: simulated outbox failure'));

    const processed = await sweeper.run();

    expect(processed).toBe(0);
  });
});
