import { ReleaseReservationCommand } from './release-reservation.command';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { ReservationStatus, StorageRequirement } from '../../domain/enums';

describe('ReleaseReservationCommand', () => {
  const listingId = 'listing-1';
  const reservationId = 'reservation-1';

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

  const heldReservation = {
    id: reservationId,
    listingId,
    orderId: 'order-1',
    quantity: 4,
    status: ReservationStatus.HELD,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  };

  let reservations: {
    findById: jest.Mock;
    lockForUpdate: jest.Mock;
    updateStatus: jest.Mock;
    findDispatchMovements: jest.Mock;
  };
  let listings: { lockForUpdate: jest.Mock; updateCache: jest.Mock };
  let ledger: { findBatchesByListing: jest.Mock; recordMovement: jest.Mock };
  let uow: { run: jest.Mock };
  let audit: { record: jest.Mock };
  let outbox: { write: jest.Mock };
  let command: ReleaseReservationCommand;

  beforeEach(() => {
    reservations = {
      findById: jest.fn().mockResolvedValue(heldReservation),
      lockForUpdate: jest.fn().mockResolvedValue(heldReservation),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      findDispatchMovements: jest.fn().mockResolvedValue([]),
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
    uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };

    command = new ReleaseReservationCommand(
      reservations as never,
      listings as never,
      ledger as never,
      uow as never,
      audit as never,
      outbox as never,
    );
  });

  it('releases a HELD reservation and restores sellable', async () => {
    await command.execute({ reservationId, reason: 'cancelled' });
    expect(reservations.updateStatus).toHaveBeenCalledWith(reservationId, ReservationStatus.RELEASED, {});
    expect(listings.updateCache).toHaveBeenCalledWith(listingId, { reserved: 0, sellable: 10 }, {});
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: releasing an already-RELEASED reservation is a no-op, does not double-credit sellable', async () => {
    const released = { ...heldReservation, status: ReservationStatus.RELEASED };
    reservations.findById.mockResolvedValue(released);
    reservations.lockForUpdate.mockResolvedValue(released);

    await command.execute({ reservationId, reason: 'retry' });

    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(listings.updateCache).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('is idempotent for an EXPIRED reservation too', async () => {
    const expired = { ...heldReservation, status: ReservationStatus.EXPIRED };
    reservations.findById.mockResolvedValue(expired);
    reservations.lockForUpdate.mockResolvedValue(expired);

    await command.execute({ reservationId });

    expect(reservations.updateStatus).not.toHaveBeenCalled();
  });

  it('re-validates status under the lock, not just the pre-transaction read: even if the ' +
    'pre-check saw HELD, a status flip discovered under the lock (e.g. a concurrent TTL expiry ' +
    'that committed in between) still short-circuits as a no-op', async () => {
    reservations.findById.mockResolvedValue(heldReservation); // stale pre-check: still HELD
    reservations.lockForUpdate.mockResolvedValue({ ...heldReservation, status: ReservationStatus.EXPIRED });

    await command.execute({ reservationId, reason: 'cancelled' });

    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(listings.updateCache).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('throws an invariant error instead of clamping when reserved would go negative', async () => {
    listings.lockForUpdate.mockResolvedValue(buildListing(10, 0)); // reserved already 0
    await expect(command.execute({ reservationId, reason: 'cancelled' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(listings.updateCache).not.toHaveBeenCalled();
  });

  describe('CONFIRMED reservations', () => {
    const confirmed = { ...heldReservation, status: ReservationStatus.CONFIRMED };

    beforeEach(() => {
      reservations.findById.mockResolvedValue(confirmed);
      reservations.lockForUpdate.mockResolvedValue(confirmed);
    });

    it('releases an undispatched CONFIRMED reservation, checking dispatch movements under the tx', async () => {
      await command.execute({ reservationId, reason: 'customer-cancel' });

      expect(reservations.findDispatchMovements).toHaveBeenCalledWith(reservationId, {});
      expect(reservations.updateStatus).toHaveBeenCalledWith(reservationId, ReservationStatus.RELEASED, {});
      expect(listings.updateCache).toHaveBeenCalledWith(listingId, { reserved: 0, sellable: 10 }, {});
    });

    it('rejects an already-dispatched CONFIRMED reservation with INVALID_RESERVATION_STATE and writes nothing', async () => {
      reservations.findDispatchMovements.mockResolvedValue([{ batchId: 'batch-1', qty: 4 }]);

      await expect(command.execute({ reservationId, reason: 'customer-cancel' })).rejects.toMatchObject({
        code: 'INVALID_RESERVATION_STATE',
      });

      expect(listings.lockForUpdate).not.toHaveBeenCalled();
      expect(reservations.updateStatus).not.toHaveBeenCalled();
      expect(ledger.recordMovement).not.toHaveBeenCalled();
      expect(listings.updateCache).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(outbox.write).not.toHaveBeenCalled();
    });

    it('checks dispatch after the reservation lock and before the listing lock', async () => {
      const order: string[] = [];
      reservations.lockForUpdate.mockImplementation(async () => {
        order.push('reservation');
        return confirmed;
      });
      reservations.findDispatchMovements.mockImplementation(async () => {
        order.push('dispatch-check');
        return [];
      });
      listings.lockForUpdate.mockImplementation(async () => {
        order.push('listing');
        return buildListing();
      });

      await command.execute({ reservationId });

      expect(order).toEqual(['reservation', 'dispatch-check', 'listing']);
    });
  });

  it('does not query dispatch movements for a HELD reservation (only CONFIRMED can be dispatched)', async () => {
    await command.execute({ reservationId });
    expect(reservations.findDispatchMovements).not.toHaveBeenCalled();
  });
});
