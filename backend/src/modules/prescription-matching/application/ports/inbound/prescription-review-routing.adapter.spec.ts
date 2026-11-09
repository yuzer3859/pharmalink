import { PrescriptionStatus } from '../../../domain/enums';
import { IPrescriptionRepository } from '../../../domain/repositories/prescription.repository';
import { AssignVerifyingPharmacyCommand } from '../../commands/assign-verifying-pharmacy.command';
import { PrescriptionReviewRoutingAdapter } from './prescription-review-routing.adapter';

const rx = (over: Record<string, unknown> = {}) => ({
  id: 'rx-1',
  customerUserId: 'customer-1',
  status: PrescriptionStatus.UPLOADED,
  verifyingPharmacyId: null,
  ...over,
});

function build() {
  const prescriptions = {
    listByCustomer: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    findLineById: jest.fn(),
    findById: jest.fn(),
  } as unknown as jest.Mocked<IPrescriptionRepository>;
  const assign = { execute: jest.fn() } as unknown as jest.Mocked<AssignVerifyingPharmacyCommand>;
  return { adapter: new PrescriptionReviewRoutingAdapter(prescriptions, assign), prescriptions, assign };
}

describe('PrescriptionReviewRoutingAdapter (Work 109)', () => {
  describe('routeForReview', () => {
    it("routes the customer's newest uploaded prescription to the given pharmacy organisation", async () => {
      const { adapter, prescriptions, assign } = build();
      prescriptions.listByCustomer.mockResolvedValueOnce({ items: [rx()], total: 1 } as never);
      assign.execute.mockResolvedValue(rx({ status: PrescriptionStatus.PENDING_VERIFICATION, verifyingPharmacyId: 'org-1' }) as never);

      const requestedItems = [{ catalogProductId: 'p-1', productName: 'Amoxicillin', quantity: 2 }];
      const result = await adapter.routeForReview({ customerUserId: 'customer-1', verifyingOrganizationId: 'org-1', requestedItems });

      expect(prescriptions.listByCustomer).toHaveBeenCalledWith({ customerUserId: 'customer-1', status: PrescriptionStatus.UPLOADED, page: 1, size: 1 });
      expect(assign.execute).toHaveBeenCalledWith({ prescriptionId: 'rx-1', pharmacyId: 'org-1', requestedItems });
      expect(result).toEqual({ prescriptionId: 'rx-1', status: PrescriptionStatus.PENDING_VERIFICATION, verifyingOrganizationId: 'org-1', routedNow: true });
    });

    it('never moves a prescription already with a pharmacy; it reports where it is', async () => {
      const { adapter, prescriptions, assign } = build();
      prescriptions.listByCustomer
        .mockResolvedValueOnce({ items: [], total: 0 } as never)
        .mockResolvedValueOnce({ items: [rx({ id: 'rx-2', status: PrescriptionStatus.PENDING_VERIFICATION, verifyingPharmacyId: 'org-9' })], total: 1 } as never);

      const result = await adapter.routeForReview({ customerUserId: 'customer-1', verifyingOrganizationId: 'org-1', requestedItems: [] });

      expect(assign.execute).not.toHaveBeenCalled();
      expect(result).toEqual({ prescriptionId: 'rx-2', status: PrescriptionStatus.PENDING_VERIFICATION, verifyingOrganizationId: 'org-9', routedNow: false });
    });

    it('returns null when the customer has nothing to review', async () => {
      const { adapter, assign } = build();
      await expect(adapter.routeForReview({ customerUserId: 'customer-1', verifyingOrganizationId: 'org-1', requestedItems: [] })).resolves.toBeNull();
      expect(assign.execute).not.toHaveBeenCalled();
    });
  });

  describe('verifyingOrganizationsFor', () => {
    it("returns the distinct verifying organisations of the customer's own prescription lines", async () => {
      const { adapter, prescriptions } = build();
      prescriptions.findLineById.mockImplementation(async (id: string) => ({ id, prescriptionId: id === 'l-3' ? 'rx-other' : 'rx-1' }) as never);
      prescriptions.findById.mockImplementation(async (id: string) =>
        (id === 'rx-other'
          ? rx({ id, customerUserId: 'someone-else', verifyingPharmacyId: 'org-x' })
          : rx({ id, status: PrescriptionStatus.APPROVED, verifyingPharmacyId: 'org-1' })) as never,
      );

      const result = await adapter.verifyingOrganizationsFor({ customerUserId: 'customer-1', prescriptionLineIds: ['l-1', 'l-2', 'l-1', 'l-3'] });

      // Another customer's line never contributes.
      expect(result).toEqual(['org-1']);
    });

    it('skips lines that no longer exist and prescriptions with no verifying pharmacy', async () => {
      const { adapter, prescriptions } = build();
      prescriptions.findLineById.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'l-2', prescriptionId: 'rx-1' } as never);
      prescriptions.findById.mockResolvedValue(rx({ status: PrescriptionStatus.APPROVED }) as never);
      await expect(adapter.verifyingOrganizationsFor({ customerUserId: 'customer-1', prescriptionLineIds: ['l-1', 'l-2'] })).resolves.toEqual([]);
    });
  });
});
