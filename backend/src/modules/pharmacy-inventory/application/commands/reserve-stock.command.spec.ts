import { ReserveStockCommand } from './reserve-stock.command';
import { Pharmacy } from '../../domain/entities/pharmacy.entity';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { StorageRequirement } from '../../domain/enums';

function buildEligiblePharmacy(id: string, organizationId = 'org-1'): Pharmacy {
  const pharmacy = Pharmacy.register(id, { organizationId, displayName: 'Test Pharmacy' });
  pharmacy.activate(null);
  return pharmacy;
}

function buildListing(id: string, pharmacyId: string, onHand = 10, reserved = 0): InventoryListing {
  const listing = InventoryListing.create(id, {
    pharmacyId,
    branchId: 'branch-1',
    catalogProductId: 'product-1',
    price: 100,
    currency: 'ETB',
    storageRequirement: StorageRequirement.AMBIENT,
  });
  return InventoryListing.rehydrate({ ...listing.toProps(), onHand, reserved, sellable: onHand - reserved });
}

describe('ReserveStockCommand', () => {
  let listings: { lockForUpdate: jest.Mock; updateCache: jest.Mock };
  let pharmacies: { findById: jest.Mock };
  let reservations: { findByIdempotencyKey: jest.Mock; create: jest.Mock };
  let ledger: { findBatchesByListing: jest.Mock; recordMovement: jest.Mock };
  let config: { get: jest.Mock };
  let uow: { run: jest.Mock };
  let outbox: { write: jest.Mock };
  let command: ReserveStockCommand;

  const listingId = 'listing-1';
  const pharmacyId = 'pharmacy-1';

  beforeEach(() => {
    const listing = buildListing(listingId, pharmacyId, 10, 0);
    const pharmacy = buildEligiblePharmacy(pharmacyId);

    listings = {
      lockForUpdate: jest.fn().mockResolvedValue(listing),
      updateCache: jest.fn().mockResolvedValue(undefined),
    };
    pharmacies = { findById: jest.fn().mockResolvedValue(pharmacy) };
    reservations = {
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    };
    ledger = {
      findBatchesByListing: jest.fn().mockResolvedValue([
        { id: 'batch-1', quantity: 10, expiryDate: new Date('2030-01-01') },
      ]),
      recordMovement: jest.fn().mockResolvedValue(undefined),
    };
    config = { get: jest.fn().mockReturnValue(undefined) };
    uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})) };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };

    command = new ReserveStockCommand(
      listings as never,
      pharmacies as never,
      reservations as never,
      ledger as never,
      config as never,
      uow as never,
      outbox as never,
    );
  });

  it('reserves stock and writes the RESERVE movement + StockReserved event', async () => {
    const result = await command.execute({
      listingId,
      quantity: 4,
      orderId: 'order-1',
      idempotencyKey: 'key-1',
    });

    expect(result.reservationId).toBeDefined();
    expect(reservations.create).toHaveBeenCalledTimes(1);
    expect(reservations.create).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'key-1' }),
      expect.anything(),
    );
    expect(ledger.recordMovement).toHaveBeenCalledTimes(1);
    expect(listings.updateCache).toHaveBeenCalledWith(listingId, { reserved: 4, sellable: 6 }, {});
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('rejects when sellable is insufficient', async () => {
    ledger.findBatchesByListing.mockResolvedValue([
      { id: 'batch-1', quantity: 2, expiryDate: new Date('2030-01-01') },
    ]);
    await expect(
      command.execute({ listingId, quantity: 5, orderId: 'order-1', idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(reservations.create).not.toHaveBeenCalled();
  });

  it('rejects when the pharmacy is not eligible (defensive re-check)', async () => {
    const suspended = Pharmacy.register(pharmacyId, { organizationId: 'org-1', displayName: 'X' });
    pharmacies.findById.mockResolvedValue(suspended); // still PENDING, never activated
    await expect(
      command.execute({ listingId, quantity: 1, orderId: 'order-1', idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ code: 'PHARMACY_NOT_ELIGIBLE' });
  });

  it('idempotency: a replay with the identical key+payload returns the original reservation without a second write', async () => {
    const first = await command.execute({
      listingId,
      quantity: 3,
      orderId: 'order-1',
      idempotencyKey: 'key-1',
    });
    expect(reservations.create).toHaveBeenCalledTimes(1);

    reservations.findByIdempotencyKey.mockResolvedValue({
      id: first.reservationId,
      listingId,
      orderId: 'order-1',
      quantity: 3,
      status: 'HELD',
      expiresAt: first.expiresAt,
      createdAt: new Date(),
    });

    const second = await command.execute({
      listingId,
      quantity: 3,
      orderId: 'order-1',
      idempotencyKey: 'key-1',
    });

    expect(second.reservationId).toBe(first.reservationId);
    expect(reservations.create).toHaveBeenCalledTimes(1);
  });

  it('idempotency conflict: reusing the same key with a different payload throws IDEMPOTENCY_CONFLICT ' +
    'instead of silently returning the mismatched reservation', async () => {
    reservations.findByIdempotencyKey.mockResolvedValue({
      id: 'existing-reservation',
      listingId,
      orderId: 'order-1',
      quantity: 3,
      status: 'HELD',
      expiresAt: new Date(),
      createdAt: new Date(),
    });

    await expect(
      command.execute({ listingId, quantity: 4, orderId: 'order-1', idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      command.execute({ listingId, quantity: 3, orderId: 'order-2', idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(reservations.create).not.toHaveBeenCalled();
  });

  it('concurrent race: a P2002 unique-violation on insert is resolved by re-reading the winning row, ' +
    'not surfaced as a 500', async () => {
    reservations.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    }));
    reservations.findByIdempotencyKey
      .mockResolvedValueOnce(null) // first lookup inside the tx: no existing row yet
      .mockResolvedValueOnce({
        id: 'winner-reservation',
        listingId,
        orderId: 'order-1',
        quantity: 4,
        status: 'HELD',
        expiresAt: new Date(),
        createdAt: new Date(),
      });

    const result = await command.execute({
      listingId,
      quantity: 4,
      orderId: 'order-1',
      idempotencyKey: 'key-1',
    });

    expect(result.reservationId).toBe('winner-reservation');
  });
});
