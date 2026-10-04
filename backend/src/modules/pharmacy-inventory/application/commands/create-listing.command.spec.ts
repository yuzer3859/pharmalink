import { CreateListingCommand } from './create-listing.command';
import { Pharmacy } from '../../domain/entities/pharmacy.entity';

function eligiblePharmacy(id: string): Pharmacy {
  const pharmacy = Pharmacy.register(id, { organizationId: 'org-1', displayName: 'Test Pharmacy' });
  pharmacy.activate(null);
  return pharmacy;
}

describe('CreateListingCommand', () => {
  const pharmacyId = 'pharmacy-1';
  const branchId = 'branch-1';
  const catalogProductId = 'product-1';

  let pharmacies: { findById: jest.Mock };
  let branches: { findById: jest.Mock };
  let listings: { findByBranchAndProduct: jest.Mock; create: jest.Mock; updateCache: jest.Mock };
  let ledger: { addBatch: jest.Mock; recordMovement: jest.Mock };
  let catalog: { getProduct: jest.Mock };
  let uow: { run: jest.Mock };
  let audit: { record: jest.Mock };
  let outbox: { write: jest.Mock; writeMany: jest.Mock };
  let command: CreateListingCommand;

  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  beforeEach(() => {
    pharmacies = { findById: jest.fn().mockResolvedValue(eligiblePharmacy(pharmacyId)) };
    branches = { findById: jest.fn().mockResolvedValue({ pharmacyId, id: branchId }) };
    listings = {
      findByBranchAndProduct: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
      updateCache: jest.fn().mockResolvedValue(undefined),
    };
    ledger = { addBatch: jest.fn().mockResolvedValue(undefined), recordMovement: jest.fn().mockResolvedValue(undefined) };
    catalog = {
      getProduct: jest.fn().mockResolvedValue({
        id: catalogProductId,
        type: 'MEDICINE',
        status: 'ACTIVE',
        rxClassification: 'OTC',
        controlledSchedule: 'NONE',
        onlineSaleProhibited: false,
        storageRequirement: 'AMBIENT',
      }),
    };
    uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    outbox = { write: jest.fn().mockResolvedValue(undefined), writeMany: jest.fn().mockResolvedValue(undefined) };

    command = new CreateListingCommand(
      pharmacies as never,
      branches as never,
      listings as never,
      ledger as never,
      catalog as never,
      uow as never,
      audit as never,
      outbox as never,
    );
  });

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      actorUserId: 'user-1',
      pharmacyId,
      branchId,
      catalogProductId,
      price: 500,
      batchNumber: 'B1',
      initialQuantity: 10,
      expiryDate: futureDate,
      ...overrides,
    };
  }

  it('happy path: creates the listing, the initial batch, and emits ListingCreated + StockReceived', async () => {
    const result = await command.execute(baseInput());
    expect(result.listingId).toBeDefined();
    expect(listings.create).toHaveBeenCalledTimes(1);
    expect(ledger.addBatch).toHaveBeenCalledTimes(1);
    expect(outbox.write).toHaveBeenCalledTimes(2);
  });

  it('rejects when the pharmacy is not eligible', async () => {
    pharmacies.findById.mockResolvedValue(
      Pharmacy.register(pharmacyId, { organizationId: 'org-1', displayName: 'X' }),
    );
    await expect(command.execute(baseInput())).rejects.toMatchObject({ code: 'PHARMACY_NOT_ELIGIBLE' });
  });

  it('rejects when the catalog product is missing or inactive', async () => {
    catalog.getProduct.mockResolvedValue(null);
    await expect(command.execute(baseInput())).rejects.toMatchObject({ code: 'CATALOG_PRODUCT_NOT_FOUND' });
  });

  it('rejects when the catalog product is prohibited from online sale', async () => {
    catalog.getProduct.mockResolvedValue({
      id: catalogProductId,
      type: 'MEDICINE',
      status: 'ACTIVE',
      rxClassification: 'RX',
      controlledSchedule: 'SCHEDULE_II',
      onlineSaleProhibited: true,
      storageRequirement: 'AMBIENT',
    });
    await expect(command.execute(baseInput())).rejects.toMatchObject({ code: 'CONTROLLED_PROHIBITED' });
  });

  it('rejects a duplicate (branch, product) listing', async () => {
    listings.findByBranchAndProduct.mockResolvedValue({ id: 'existing-listing' });
    await expect(command.execute(baseInput())).rejects.toMatchObject({ code: 'DUPLICATE_LISTING' });
  });

  it('rejects when the branch does not belong to the caller pharmacy', async () => {
    branches.findById.mockResolvedValue({ pharmacyId: 'other-pharmacy', id: branchId });
    await expect(command.execute(baseInput())).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
  });
});
