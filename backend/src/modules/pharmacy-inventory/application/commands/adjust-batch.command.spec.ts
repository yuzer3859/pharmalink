import { AdjustBatchCommand } from './adjust-batch.command';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { StorageRequirement } from '../../domain/enums';

describe('AdjustBatchCommand', () => {
  const pharmacyId = 'pharmacy-1';
  const listingId = 'listing-1';
  const batchId = 'batch-1';

  function buildListing(onHand = 10, reserved = 0): InventoryListing {
    const listing = InventoryListing.create(listingId, {
      pharmacyId,
      branchId: 'branch-1',
      catalogProductId: 'product-1',
      price: 100,
      currency: 'ETB',
      storageRequirement: StorageRequirement.AMBIENT,
    });
    return InventoryListing.rehydrate({ ...listing.toProps(), onHand, reserved, sellable: onHand - reserved });
  }

  const batch = { id: batchId, listingId, batchNumber: 'B1', quantity: 10, expiryDate: new Date('2030-01-01'), supplier: null, receivedAt: null, createdAt: new Date() };

  let listings: { findById: jest.Mock; lockForUpdate: jest.Mock; updateCache: jest.Mock };
  let ledger: {
    findBatchById: jest.Mock;
    lockBatchForUpdate: jest.Mock;
    adjustBatchQuantity: jest.Mock;
    findBatchesByListing: jest.Mock;
    recordMovement: jest.Mock;
  };
  let uow: { run: jest.Mock };
  let audit: { record: jest.Mock };
  let command: AdjustBatchCommand;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    listings = {
      findById: jest.fn().mockResolvedValue(buildListing()),
      lockForUpdate: jest.fn().mockImplementation(async () => {
        callOrder.push('listing.lockForUpdate');
        return buildListing();
      }),
      updateCache: jest.fn().mockResolvedValue(undefined),
    };
    ledger = {
      findBatchById: jest.fn().mockResolvedValue(batch),
      lockBatchForUpdate: jest.fn().mockImplementation(async () => {
        callOrder.push('ledger.lockBatchForUpdate');
        return batch;
      }),
      adjustBatchQuantity: jest.fn().mockResolvedValue(undefined),
      findBatchesByListing: jest.fn().mockResolvedValue([{ ...batch, quantity: 13 }]),
      recordMovement: jest.fn().mockResolvedValue(undefined),
    };
    uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    command = new AdjustBatchCommand(listings as never, ledger as never, uow as never, audit as never);
  });

  it('adjusts the batch quantity and listing onHand under a fresh lock inside the transaction', async () => {
    await command.execute({ actorUserId: 'user-1', pharmacyId, batchId, quantityDelta: 3, reason: 'recount' });
    expect(ledger.lockBatchForUpdate).toHaveBeenCalledWith(batchId, {});
    expect(ledger.adjustBatchQuantity).toHaveBeenCalledWith(batchId, 13, {});
    expect(listings.updateCache).toHaveBeenCalledWith(listingId, { onHand: 13, sellable: 13 }, {});
  });

  it('locks in the global order listing -> batch (module-04 hardening §8/§12) — the inverse of ' +
    'the pre-hardening order, chosen so this command can never deadlock against ' +
    'DispatchStockCommand\'s listing-then-batch order', async () => {
    await command.execute({ actorUserId: 'user-1', pharmacyId, batchId, quantityDelta: 3, reason: 'recount' });
    expect(callOrder).toEqual(['listing.lockForUpdate', 'ledger.lockBatchForUpdate']);
  });

  it('recomputes from the freshly-locked batch quantity, not the stale pre-check snapshot ' +
    '(proves the fix: a concurrent adjustment that changed quantity between pre-check and lock ' +
    'is reflected)', async () => {
    // Pre-check sees quantity=10; by the time the lock is acquired, a concurrent adjustment
    // already landed and raised it to 16.
    ledger.lockBatchForUpdate.mockResolvedValue({ ...batch, quantity: 16 });

    await command.execute({ actorUserId: 'user-1', pharmacyId, batchId, quantityDelta: 3, reason: 'recount' });

    // Computed from the locked value (16 + 3 = 19), not the stale pre-check value (10 + 3 = 13).
    expect(ledger.adjustBatchQuantity).toHaveBeenCalledWith(batchId, 19, {});
  });

  it('rejects an adjustment that would make batch quantity negative', async () => {
    await expect(
      command.execute({ actorUserId: 'user-1', pharmacyId, batchId, quantityDelta: -20, reason: 'loss' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(ledger.adjustBatchQuantity).not.toHaveBeenCalled();
  });

  it('rejects an adjustment that would make listing onHand negative even if the batch itself would not go negative', async () => {
    listings.lockForUpdate.mockResolvedValue(buildListing(0, 0));
    await expect(
      command.execute({ actorUserId: 'user-1', pharmacyId, batchId, quantityDelta: -1, reason: 'loss' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects when the listing does not belong to the calling pharmacy', async () => {
    await expect(
      command.execute({ actorUserId: 'user-1', pharmacyId: 'other-pharmacy', batchId, quantityDelta: 1, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'LISTING_NOT_FOUND' });
  });
});
