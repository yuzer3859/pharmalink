import { Pharmacy } from '../../../domain/entities/pharmacy.entity';
import { IPharmacyRepository } from '../../../domain/repositories/pharmacy.repository';
import { IIdentityPort } from '../outbound/identity.port';
import { PharmacyRecipientReadPortAdapter } from './pharmacy-recipient-read.port';

/** The contract Module 13 relies on: pharmacy → its organization's owner, and `null` otherwise. */
describe('PharmacyRecipientReadPortAdapter', () => {
  const pharmacyRow = { organizationId: 'org-1' } as unknown as Pharmacy;
  let findById: jest.Mock;
  let getOrganizationOwner: jest.Mock;
  let adapter: PharmacyRecipientReadPortAdapter;

  beforeEach(() => {
    findById = jest.fn().mockResolvedValue(pharmacyRow);
    getOrganizationOwner = jest.fn().mockResolvedValue({ userId: 'owner-1' });
    adapter = new PharmacyRecipientReadPortAdapter(
      { findById } as unknown as IPharmacyRepository,
      { getOrganizationOwner } as unknown as IIdentityPort,
    );
  });

  it('answers the owner of the pharmacy’s organization', async () => {
    await expect(adapter.ownerUserIdOfPharmacy('pharmacy-1')).resolves.toBe('owner-1');
    expect(findById).toHaveBeenCalledWith('pharmacy-1');
    expect(getOrganizationOwner).toHaveBeenCalledWith('org-1');
  });

  it('answers null for an unknown pharmacy, without asking Module 01', async () => {
    findById.mockResolvedValue(null);
    await expect(adapter.ownerUserIdOfPharmacy('nope')).resolves.toBeNull();
    expect(getOrganizationOwner).not.toHaveBeenCalled();
  });

  it('answers null when the organization is gone', async () => {
    getOrganizationOwner.mockResolvedValue(null);
    await expect(adapter.ownerUserIdOfPharmacy('pharmacy-1')).resolves.toBeNull();
  });
});
