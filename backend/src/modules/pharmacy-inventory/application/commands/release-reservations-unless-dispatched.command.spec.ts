import { ReleaseReservationsUnlessDispatchedCommand } from './release-reservations-unless-dispatched.command';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { ReservationStatus, StorageRequirement } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { isDispatchedReservationRejection } from '../ports/inbound/inventory.port';

describe('ReleaseReservationsUnlessDispatchedCommand', () => {
  function buildListing(id: string, onHand = 10, reserved = 9): InventoryListing {
    const listing = InventoryListing.create(id, {
      pharmacyId: 'pharmacy-1',
      branchId: 'branch-1',
      catalogProductId: `product-${id}`,
      price: 100,
      currency: 'ETB',
      storageRequirement: StorageRequirement.AMBIENT,
    });
    return InventoryListing.rehydrate({ ...listing.toProps(), onHand, reserved, sellable: onHand - reserved });
  }
  const reservation = (id: string, listingId: string, quantity: number, status: ReservationStatus) => ({
    id, listingId, orderId: 'order-1', quantity, status, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(),
  });

  let rows: Record<string, ReturnType<typeof reservation>>;
  let dispatchedIds: Set<string>;
  let calls: string[];
  let reservations: { lockForUpdate: jest.Mock; findDispatchMovements: jest.Mock; updateStatus: jest.Mock };
  let listings: { lockForUpdate: jest.Mock; updateCache: jest.Mock };
  let ledger: { findBatchesByListing: jest.Mock; recordMovement: jest.Mock };
  let outbox: { write: jest.Mock };
  let uow: { run: jest.Mock };
  let command: ReleaseReservationsUnlessDispatchedCommand;

  beforeEach(() => {
    rows = {
      'r-a': reservation('r-a', 'L-2', 2, ReservationStatus.CONFIRMED),
      'r-b': reservation('r-b', 'L-1', 3, ReservationStatus.HELD),
      'r-c': reservation('r-c', 'L-2', 4, ReservationStatus.CONFIRMED),
    };
    dispatchedIds = new Set();
    calls = [];
    reservations = {
      lockForUpdate: jest.fn(async (id: string) => (calls.push(`lock-reservation:${id}`), rows[id] ?? null)),
      findDispatchMovements: jest.fn(async (id: string) => (calls.push(`dispatch-check:${id}`), dispatchedIds.has(id) ? [{ batchId: 'b', qty: 1 }] : [])),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    listings = {
      lockForUpdate: jest.fn(async (id: string) => (calls.push(`lock-listing:${id}`), buildListing(id))),
      updateCache: jest.fn().mockResolvedValue(undefined),
    };
    ledger = {
      findBatchesByListing: jest.fn().mockResolvedValue([{ id: 'batch-1', quantity: 10, expiryDate: new Date('2030-01-01') }]),
      recordMovement: jest.fn().mockResolvedValue(undefined),
    };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };
    uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})) };
    command = new ReleaseReservationsUnlessDispatchedCommand(reservations as never, listings as never, ledger as never, uow as never, outbox as never);
  });

  const expectNoWrites = () => {
    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(ledger.recordMovement).not.toHaveBeenCalled();
    expect(listings.updateCache).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  };

  it('locks every reservation (de-duplicated, sorted) before any check, then the listings (sorted), all in ONE transaction', async () => {
    await command.execute({ reservationIds: ['r-c', 'r-a', 'r-b', 'r-a'], reason: 'customer-cancel' });
    expect(uow.run).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'lock-reservation:r-a', 'lock-reservation:r-b', 'lock-reservation:r-c',
      'dispatch-check:r-a', 'dispatch-check:r-c', // CONFIRMED only — a HELD reservation cannot have been dispatched
      'lock-listing:L-1', 'lock-listing:L-2',
    ]);
  });

  it('releases every undispatched reservation: RELEASED + one RELEASE movement + one outbox event each; one cache update per listing', async () => {
    await command.execute({ reservationIds: ['r-a', 'r-b', 'r-c'], reason: 'customer-cancel' });
    expect(reservations.updateStatus.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['r-a', ReservationStatus.RELEASED], ['r-b', ReservationStatus.RELEASED], ['r-c', ReservationStatus.RELEASED],
    ]);
    expect(ledger.recordMovement.mock.calls.map((c) => [c[0].reservationId, c[0].type, c[0].quantityDelta, c[0].reason])).toEqual([
      ['r-a', 'RELEASE', 2, 'customer-cancel'], ['r-b', 'RELEASE', 3, 'customer-cancel'], ['r-c', 'RELEASE', 4, 'customer-cancel'],
    ]);
    expect(outbox.write).toHaveBeenCalledTimes(3);
    // L-1: reserved 9 − 3; L-2: reserved 9 − (2 + 4), summed once per listing.
    expect(listings.updateCache.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['L-1', { reserved: 6, sellable: 4 }],
      ['L-2', { reserved: 3, sellable: 7 }],
    ]);
  });

  it('one dispatched CONFIRMED reservation rejects the WHOLE batch — typed rejection naming it, zero writes, no listing lock', async () => {
    dispatchedIds.add('r-c');
    const err = await command.execute({ reservationIds: ['r-a', 'r-b', 'r-c'] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INVALID_RESERVATION_STATE', details: { from: 'DISPATCHED', reservationIds: ['r-c'] } });
    expect(isDispatchedReservationRejection(err)).toBe(true);
    expect(listings.lockForUpdate).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('RELEASED and EXPIRED reservations are no-ops; an all-terminal batch writes nothing and locks no listing', async () => {
    rows['r-a'].status = ReservationStatus.RELEASED;
    rows['r-c'].status = ReservationStatus.EXPIRED;
    await command.execute({ reservationIds: ['r-a', 'r-c'] });
    expect(reservations.findDispatchMovements).not.toHaveBeenCalled();
    expect(listings.lockForUpdate).not.toHaveBeenCalled();
    expectNoWrites();

    await command.execute({ reservationIds: ['r-a', 'r-b', 'r-c'] });
    expect(reservations.updateStatus.mock.calls.map((c) => c[0])).toEqual(['r-b']);
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('an unknown id rejects the whole batch with RESERVATION_NOT_FOUND before any write', async () => {
    await expect(command.execute({ reservationIds: ['r-a', 'r-zzz'] })).rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
    expectNoWrites();
  });

  it('a listing whose reserved cannot cover the batch fails the invariant before any write', async () => {
    listings.lockForUpdate.mockImplementation(async (id: string) => buildListing(id, 10, id === 'L-2' ? 5 : 9));
    await expect(command.execute({ reservationIds: ['r-a', 'r-b', 'r-c'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expectNoWrites();
  });

  it('an empty batch does nothing (no transaction)', async () => {
    await command.execute({ reservationIds: [] });
    expect(uow.run).not.toHaveBeenCalled();
  });

  it('the port guard recognises only the dispatched rejection (also the single release’s) and nothing else', () => {
    expect(isDispatchedReservationRejection(PharmacyInventoryErrors.reservationsDispatched(['x']))).toBe(true);
    expect(isDispatchedReservationRejection(PharmacyInventoryErrors.invalidReservationState('DISPATCHED', 'RELEASED'))).toBe(true);
    expect(isDispatchedReservationRejection(PharmacyInventoryErrors.invalidReservationState('RELEASED', 'CONFIRMED'))).toBe(false);
    expect(isDispatchedReservationRejection(PharmacyInventoryErrors.reservationNotFound())).toBe(false);
    expect(isDispatchedReservationRejection(new Error('DISPATCHED'))).toBe(false);
  });
});
