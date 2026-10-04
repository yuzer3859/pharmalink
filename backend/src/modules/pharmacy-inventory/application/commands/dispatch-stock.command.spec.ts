import { DispatchStockCommand } from './dispatch-stock.command';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { ReservationStatus, StorageRequirement } from '../../domain/enums';

describe('DispatchStockCommand', () => {
  const listingId = 'listing-1';
  const reservationId = 'reservation-1';
  const confirmed = {
    id: reservationId,
    listingId,
    orderId: 'order-1',
    quantity: 4,
    status: ReservationStatus.CONFIRMED,
    expiresAt: new Date(Date.now() + 60_000),
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

  let reservations: {
    findById: jest.Mock;
    lockForUpdate: jest.Mock;
    findDispatchMovements: jest.Mock;
  };
  let listings: { lockForUpdate: jest.Mock; updateCache: jest.Mock };
  let ledger: {
    lockBatchesForListing: jest.Mock;
    adjustBatchQuantity: jest.Mock;
    recordMovement: jest.Mock;
  };
  let uow: { run: jest.Mock };
  let outbox: { write: jest.Mock };
  let command: DispatchStockCommand;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    reservations = {
      findById: jest.fn().mockResolvedValue(confirmed),
      lockForUpdate: jest.fn().mockImplementation(async () => {
        callOrder.push('reservation.lockForUpdate');
        return confirmed;
      }),
      findDispatchMovements: jest.fn().mockResolvedValue([]),
    };
    listings = {
      lockForUpdate: jest.fn().mockImplementation(async () => {
        callOrder.push('listing.lockForUpdate');
        return buildListing();
      }),
      updateCache: jest.fn().mockResolvedValue(undefined),
    };
    ledger = {
      lockBatchesForListing: jest.fn().mockImplementation(async () => {
        callOrder.push('ledger.lockBatchesForListing');
        return [{ id: 'batch-1', quantity: 4, expiryDate: new Date('2030-01-01') }];
      }),
      adjustBatchQuantity: jest.fn().mockResolvedValue(undefined),
      recordMovement: jest.fn().mockResolvedValue(undefined),
    };
    uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})) };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };

    command = new DispatchStockCommand(
      reservations as never,
      listings as never,
      ledger as never,
      uow as never,
      outbox as never,
    );
  });

  it('dispatches a CONFIRMED reservation via FEFO and decrements onHand/reserved', async () => {
    await command.execute({ reservationId });
    expect(listings.updateCache).toHaveBeenCalledWith(listingId, { onHand: 6, reserved: 0 }, {});
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('locks in the global order reservation -> listing -> batches (module-04 hardening §8/§12)', async () => {
    await command.execute({ reservationId });
    expect(callOrder).toEqual([
      'reservation.lockForUpdate',
      'listing.lockForUpdate',
      'ledger.lockBatchesForListing',
    ]);
  });

  it('records reservationId on the DISPATCH movement, scoping fulfillment to this reservation only', async () => {
    await command.execute({ reservationId });
    expect(ledger.recordMovement).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DISPATCH', reservationId }),
      {},
    );
  });

  it('is a true no-op if this reservation was already dispatched (retry-safe)', async () => {
    reservations.findDispatchMovements.mockResolvedValue([{ batchId: 'batch-1', qty: 4 }]);
    await command.execute({ reservationId });
    expect(listings.updateCache).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('dispatch-vs-release race: if the row is RELEASED under the lock, throws a deterministic ' +
    'invalid-state error rather than dispatching stock for a released reservation', async () => {
    reservations.findById.mockResolvedValue(confirmed); // stale pre-check
    reservations.lockForUpdate.mockResolvedValue({ ...confirmed, status: ReservationStatus.RELEASED });

    await expect(command.execute({ reservationId })).rejects.toMatchObject({
      code: 'INVALID_RESERVATION_STATE',
    });
    expect(listings.updateCache).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('throws an invariant error instead of clamping if reserved/onHand would go negative', async () => {
    listings.lockForUpdate.mockResolvedValue(buildListing(2, 0)); // onHand/reserved too low
    await expect(command.execute({ reservationId })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(listings.updateCache).not.toHaveBeenCalled();
  });
});
