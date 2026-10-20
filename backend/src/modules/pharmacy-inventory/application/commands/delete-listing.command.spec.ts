import { DeleteListingCommand } from './delete-listing.command';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { StorageRequirement } from '../../domain/enums';

describe('DeleteListingCommand (Work 55, H1 — no deletion under live reservations)', () => {
  const listing = InventoryListing.create('listing-1', {
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    catalogProductId: 'product-1',
    price: 100,
    currency: 'ETB',
    storageRequirement: StorageRequirement.AMBIENT,
  });

  function build(live = 0) {
    const calls: string[] = [];
    const listings = {
      findById: jest.fn().mockResolvedValue(listing),
      lockForUpdate: jest.fn(async () => (calls.push('lock-listing'), listing)),
      softDelete: jest.fn(async () => { calls.push('soft-delete'); }),
    };
    const reservations = { countLiveForListing: jest.fn(async () => (calls.push('count-live'), live)) };
    const uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({ tx: true })) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const outbox = { write: jest.fn().mockResolvedValue(undefined) };
    const command = new DeleteListingCommand(listings as never, reservations as never, uow as never, audit as never, outbox as never);
    return { command, listings, reservations, audit, outbox, calls };
  }
  const input = { actorUserId: 'owner-1', pharmacyId: 'pharmacy-1', listingId: 'listing-1' };

  it('no live reservation: locks the listing, checks under that lock, then soft-deletes with audit and event (unchanged behaviour)', async () => {
    const t = build(0);
    await t.command.execute(input);
    expect(t.calls).toEqual(['lock-listing', 'count-live', 'soft-delete']);
    expect(t.listings.lockForUpdate).toHaveBeenCalledWith('listing-1', { tx: true });
    expect(t.reservations.countLiveForListing).toHaveBeenCalledWith('listing-1', { tx: true });
    expect(t.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'LISTING_DELETED' }), { tx: true });
    expect(t.outbox.write).toHaveBeenCalledTimes(1);
  });

  it('live reservations: 409 CONFLICT naming the reason and count — no delete, audit or event', async () => {
    const t = build(2);
    await expect(t.command.execute(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      details: { reason: 'LISTING_HAS_LIVE_RESERVATIONS', liveReservations: 2 },
    });
    expect(t.listings.softDelete).not.toHaveBeenCalled();
    expect(t.audit.record).not.toHaveBeenCalled();
    expect(t.outbox.write).not.toHaveBeenCalled();
  });

  it('a listing deleted concurrently (gone under the lock): 404, nothing written', async () => {
    const t = build(0);
    t.listings.lockForUpdate.mockResolvedValue(null as never);
    await expect(t.command.execute(input)).rejects.toMatchObject({ code: 'LISTING_NOT_FOUND' });
    expect(t.reservations.countLiveForListing).not.toHaveBeenCalled();
    expect(t.listings.softDelete).not.toHaveBeenCalled();
  });

  it('another pharmacy’s listing: 404 before any transaction (unchanged)', async () => {
    const t = build(0);
    await expect(t.command.execute({ ...input, pharmacyId: 'pharmacy-2' })).rejects.toMatchObject({ code: 'LISTING_NOT_FOUND' });
    expect(t.listings.lockForUpdate).not.toHaveBeenCalled();
  });
});
